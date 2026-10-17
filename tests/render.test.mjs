/**
 * 渲染测试：插件页真的**渲染出**预期内容。
 *
 * 前面几个测试在检查「源码里有没有某段字符串」，那挡不住
 * 「字符串写对了但组件根本没渲染它」这类错误。这里改成**真正调用组件函数**，
 * 遍历返回的元素树，断言用户能看到的东西。
 *
 * `WebSearchPlusPage` 是有状态的：首次渲染处于 loading 态，页面上什么都没有。
 * 因此这里用一个可播种的 `useState` 替身，把快照直接灌进第一次渲染，
 * 让断言作用在**用户实际会看到的那一帧**上。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, it } from 'node:test'

/** 一份形态完整的快照，供页面渲染。 */
const SNAPSHOT = {
	ok: true,
	version: '0.1.0',
	config: {
		priority: ['tavily', 'deepseek-official'],
		tavilyKeyRefs: ['TAVILY_API_KEY'],
		tavilyBaseURL: 'https://api.tavily.com',
		tavilyMaxResults: 8,
		tavilySearchDepth: 'basic',
		tavilyIncludeAnswer: true,
		tavilyTimeoutMs: 30000,
		tavilyRateLimitCooldownMs: 60000,
		fallbackOnEmpty: false
	},
	warnings: [],
	chain: [
		{ node: 'tavily', label: 'Tavily', available: true, detail: '1 个槽位' },
		{ node: 'deepseek-official', label: 'DeepSeek', available: true, detail: '已注册' }
	],
	keys: [
		{ ref: 'TAVILY_API_KEY', state: 'ready', sticky: false, configured: true, writable: true, cooldownUntil: 0 }
	],
	takeover: {
		active: true,
		seamProvider: 'web-search-plus',
		canRepair: true,
		deepSeekRegistered: true,
		message: '已接管'
	}
}

/**
 * 假插槽账本：按内核 `slots.inject` 的真实语义工作。
 *
 * 内核里（`dsh-client-ui-renderer` 的 `SlotRegistry.inject`）回调**只在插槽已声明时**触发：
 * 已声明 → 同步触发一次；之后每次「声明 → 塌陷 → 再声明」都重新触发／撤销；插槽始终
 * 没有声明时它一声不响。所以「回调没被叫醒」只说明「此刻没有声明」，**不能**当成
 * 「插槽不存在」的判据——这正是兜底逻辑要处理的那种沉默。
 *
 * 账本另外提供 `declare(key, { notify: false })`：声明成立但**不叫醒**监听者，
 * 用来验证判据是 `spec()` 同步探测，而不是「回调有没有到」。
 *
 * @param {string[]} [initial] - 初始就处于声明状态的插槽。
 * @returns {object} 账本：`slots` 服务面、驱动器 `declare`/`collapse` 与已注册条目。
 */
function createSlotLedger(initial = ['experience-plus.item', 'plugins.item']) {
	const records = new Map()
	const registered = []
	const injected = []
	const fired = []
	/** 取（或建）某个插槽的记录。 */
	const recordOf = (key) => {
		if (!records.has(key)) records.set(key, { declared: false, listeners: new Set() })
		return records.get(key)
	}
	/** 内核在声明与塌陷时都会通知监听者。 */
	const notify = (key) => {
		for (const listener of [...recordOf(key).listeners]) listener()
	}
	const slots = {
		// 同步探测面：已声明给出 spec，未声明给出 undefined。
		spec: (key) => (recordOf(key).declared ? { kind: 'list', scope: 'root' } : undefined),
		inject: (key, callback) => {
			injected.push(key)
			const record = recordOf(key)
			let active
			/** 停掉当前这次订阅产生的注册。 */
			const stop = () => {
				const dispose = active
				active = undefined
				if (dispose !== undefined) dispose()
			}
			/** 插槽已声明 → 跑回调；否则保持沉默（绝不抛错）。 */
			const reconcile = () => {
				if (!record.declared) {
					stop()
					return
				}
				if (active !== undefined) return
				fired.push(key)
				active = callback() ?? undefined
			}
			const listener = () => {
				stop()
				reconcile()
			}
			record.listeners.add(listener)
			reconcile()
			return () => {
				record.listeners.delete(listener)
				stop()
			}
		},
		register: (spec, component) => {
			// 内核：往未声明的插槽注册会**抛错**，因此实现只能在 inject 回调里注册。
			if (!recordOf(spec.name).declared) throw new Error(`slot "${spec.name}" is not declared`)
			const entry = { spec, component }
			registered.push(entry)
			return () => {
				const index = registered.indexOf(entry)
				if (index >= 0) registered.splice(index, 1)
			}
		}
	}
	for (const key of initial) recordOf(key).declared = true
	return {
		slots,
		registered,
		injected,
		fired,
		/** 声明一个插槽；`notify: false` 表示声明成立但不叫醒监听者。 */
		declare(key, options = {}) {
			recordOf(key).declared = true
			if (options.notify !== false) notify(key)
		},
		/** 塌陷一个插槽。 */
		collapse(key) {
			recordOf(key).declared = false
			notify(key)
		},
		/** 卡片此刻挂在哪些插槽上（按插槽名去重、排序）。 */
		slotsInUse() {
			return [...new Set(registered.map((entry) => entry.spec.name))].sort()
		}
	}
}

/**
 * 加载客户端 bundle，并渲染完整设置页。
 *
 * @param {object} [options] - 覆盖项。
 * @param {object} [options.snapshot] - 灌入首帧的快照。
 * @param {object} [options.ledger] - 自定义插槽账本（默认两个插槽都已声明）。
 * @returns {{ nodes: object[], texts: string[], mod: object, ledger: object, unload: Function }} 元素树、模块与插槽账本。
 */
function renderPage(options = {}) {
	const loaded = { id: undefined, factory: undefined }
	const styles = []
	// 默认两个插槽都已声明：apply() 时两处 inject 都会同步回调，卡片走主插槽。
	const ledger = options.ledger ?? createSlotLedger()
	const sandbox = {
		window: { __ModuleLoader__: { load: (spec) => { loaded.id = spec.id; loaded.factory = spec.factory } } },
		document: {
			createElement: () => ({ dataset: {}, style: {}, remove() {}, textContent: '' }),
			head: { appendChild: (node) => { if (node.textContent) styles.push(node.textContent) } }
		},
		console,
		setTimeout, setInterval, clearTimeout, clearInterval,
		fetch: () => Promise.reject(new Error('渲染测试不联网'))
	}
	vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), vm.createContext(sandbox))
	assert.equal(loaded.id, 'dsh-web-search-plus', '客户端 bundle id 不对')

	// 按 useState 的调用顺序播种。
	// 0=snapshot, 1=error, 2=pending, 3=drafts, 4=revealed, 5=revealing, 6=fromStored, 7=options, 8=probe, 9=usage, 10=message
	//
	// ⚠️ 新增一个 useState 就要顺移这里的索引：本文件用序号播种（而不是按名字），
	// 插在中间的 state 会把后面全部挤位——表现是「选项复选框没勾上」这类
	// 与本次改动毫无关系的假红。上次加 revealing 时就踩过。
	const overrides = {
		0: options.snapshot ?? SNAPSHOT,
		2: options.pending ?? {},
		3: options.drafts ?? {},
		4: options.revealed ?? {},
		5: options.revealing ?? {},
		6: options.fromStored ?? {},
		7: options.options ?? {}
	}
	let callIndex = 0
	const react = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
		useState: (initial) => {
			const index = callIndex
			callIndex += 1
			return [Object.hasOwn(overrides, index) ? overrides[index] : initial, () => {}]
		},
		useCallback: (fn) => fn,
		useEffect: () => {},
		useMemo: (fn) => fn(),
		// useRef 必须**稳定**：真实 React 里同一个 ref 在组件生命周期内是同一个对象。
		// 每次返回新对象会让「用 ref 存同步镜像」的代码在测试里表现成永不为真，
		// 从而把真实缺陷掩盖成绿灯。
		useRef: (() => {
			const refs = []
			let refIndex = 0
			return (initial) => {
				const at = refIndex
				refIndex += 1
				if (refs[at] === undefined) refs[at] = { current: initial }
				return refs[at]
			}
		})()
	}
	const mod = loaded.factory((name) => (name === 'react' ? react : {}))
	// 必须真的跑一遍 apply()，样式才会经由 effect 注入 —— 否则 mod.styles 是空的，
	// 任何针对 CSS 的断言都会在「什么都没检查」的情况下通过或误报。
	const disposers = []
	const ctx = {
		effect: (fn) => {
			const dispose = fn()
			disposers.push(dispose)
			return dispose
		},
		locale: { register: () => () => {}, bind: () => (key) => key },
		slots: ledger.slots
	}
	mod.apply(ctx)
	mod.styles = styles
	const tree = mod.WebSearchPlusPage({ t: (key) => key })
	/** 卸载本插件：跑一遍所有 effect 的撤销函数。 */
	const unload = () => {
		for (const dispose of disposers.splice(0)) {
			if (typeof dispose === 'function') dispose()
		}
	}
	return { nodes: flatten(tree), texts: textsOf(flatten(tree)), mod, ledger, unload }
}

/**
 * 把元素树摊平成节点数组。
 *
 * 组件是以**函数**形式传给 `createElement` 的（`h(KeysCard, props)`），React 会
 * 在渲染时调用它们。测试里必须照做——否则遍历到的只是 `<fn>` 占位节点，
 * 内层真正的 DOM 元素一个都看不到。
 *
 * @param {unknown} node - 元素、数组或文本。
 * @param {object[]} out - 收集容器。
 * @returns {object[]} 节点数组。
 */
function flatten(node, out = []) {
	if (node === null || node === undefined || node === false || node === true) return out
	if (Array.isArray(node)) {
		for (const child of node) flatten(child, out)
		return out
	}
	if (typeof node !== 'object' || node.type === undefined) return out
	// 函数组件：调用它，继续遍历返回的子树。
	if (typeof node.type === 'function') {
		flatten(node.type(node.props), out)
		return out
	}
	out.push(node)
	for (const child of node.children ?? []) flatten(child, out)
	return out
}

/** 收集树里所有文本片段。 */
function textsOf(nodes) {
	return nodes
		.flatMap((node) => (node.children ?? []).filter((child) => typeof child === 'string'))
}

/**
 * 找到密钥区的操作行：**直接子节点里**同时含「添加密钥槽位」按钮与申请链接的那一行。
 *
 * 必须只看直接子节点：用递归查找会命中外层卡片（它的后代里也有按钮和链接），
 * 于是断言的就不是目标行了。
 *
 * @param {object[]} nodes - 摊平后的节点。
 * @returns {object} 该行的元素节点。
 */
function findKeyActionsRow(nodes) {
	const row = nodes.find((node) => {
		const kids = node.children ?? []
		const hasAdd = kids.some((kid) => kid?.type === 'button' && (kid.children ?? []).includes('addKey'))
		const hasAnchor = kids.some((kid) => kid?.type === 'a')
		return hasAdd && hasAnchor
	})
	assert.ok(row !== undefined, '没找到同时包含「添加密钥槽位」与申请链接的行')
	return row
}

describe('插件页渲染：Tavily 密钥申请入口', () => {
	it('首帧不再停在 loading 态（快照已注入）', () => {
		const { texts } = renderPage()
		assert.ok(texts.includes('keysTitle'), '没有渲染出密钥区标题，页面可能仍处于 loading')
	})

	it('渲染出「获取 API Key」链接，指向 Tavily 控制台', () => {
		const { nodes } = renderPage()
		const anchors = nodes.filter((node) => node.type === 'a')
		assert.equal(anchors.length, 1, `应当恰好有一个链接，实际 ${String(anchors.length)} 个`)
		const anchor = anchors[0]
		assert.equal(anchor.props.href, 'https://app.tavily.com/home', '链接地址不对')
		assert.equal(anchor.props.target, '_blank', '应当在新标签打开')
		assert.match(String(anchor.props.rel ?? ''), /noopener/, '外链必须带 noopener')
		assert.deepEqual(anchor.children, ['keyApplyLink'], '链接文案应绑定 keyApplyLink')
	})

	it('链接使用 .wsp-link 类（走官方 --dsw-alias-link 令牌）', () => {
		const { nodes, mod } = renderPage()
		const anchor = nodes.find((node) => node.type === 'a')
		assert.match(String(anchor.props.className), /wsp-link/, '链接缺少 wsp-link 类')
		const css = mod.styles[0] ?? ''
		assert.match(css, /\.wsp-link\s*\{[^}]*--dsw-alias-link/, '.wsp-link 必须使用 --dsw-alias-link')
		assert.match(css, /\.wsp-hint\s*\{/, '缺少 .wsp-hint 样式')
	})

	it('提示文案与链接同处一行（密钥操作区）', () => {
		const { nodes } = renderPage()
		const row = findKeyActionsRow(nodes)
		const rowTexts = textsOf(flatten(row.children ?? []))
		assert.ok(rowTexts.includes('keyApplyHint'), '该行里没有提示文案')
		assert.ok(rowTexts.includes('keyApplyLink'), '该行里没有链接文案')
	})

	it('提示与链接排在「添加密钥槽位 / 重置冷却」之后且被推向右侧', () => {
		const { nodes } = renderPage()
		const row = findKeyActionsRow(nodes)
		// 只取该行的**直接子节点**：flatten 会递归整棵子树，那是给整页断言用的。
		const order = (row.children ?? []).map((child) => {
			if (child === null || child === undefined) return '<empty>'
			if (typeof child !== 'object') return String(child)
			if (child.type === 'button') return (child.children ?? [])[0]
			if (child.type === 'a') return 'LINK'
			return String(child.props.className ?? '')
		})
		assert.deepEqual(order, ['addKey', 'resetCooldowns', 'wsp-grow', 'wsp-hint', 'LINK'], `行内顺序不对：${order.join(' | ')}`)
	})

	it('中英字典都定义了新文案且非空', () => {
		const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
		for (const key of ['keyApplyHint', 'keyApplyLink']) {
			const matches = [...source.matchAll(new RegExp(`${key}:\\s*'([^']*)'`, 'g'))]
			assert.equal(matches.length, 2, `${key} 应在中英字典各出现一次，实际 ${String(matches.length)} 次`)
			for (const match of matches) assert.ok(match[1].trim().length > 0, `${key} 的文案不能为空`)
		}
		assert.match(source, /TAVILY_HOME_URL = 'https:\/\/app\.tavily\.com\/home'/, '未定义正确的 Tavily 地址常量')
	})

	it('概览卡片只渲染一句说明，不重复宿主已渲染的标题、也不自带展开开关', () => {
		/*
		 * 这条断言背后的历史是两轮真实报障，别再把它们改回去：
		 *
		 * 1. 最早这里是 `return t('summary')`，插槽把每个条目各渲染一次，两张卡的
		 *    简介首尾相接 —— 报障「两张卡挤成一整段」。
		 * 2. 于是改成「自带标题 + 展开按钮 + 原位渲染完整页」。结果：宿主摘要位本来
		 *    就紧挨着渲染条目标题，摘要里再写一遍 → 界面上同名两行（本次报障①）；
		 *    而宿主的卡片标题按钮带整卡热区，摘要里的展开按钮永远点不到，点了实际
		 *    是「打开详情页」；更糟的是摘要位在列表卡与详情页各渲染一次，一展开就
		 *    同时挂两份同一个页面（本次报障②的成因）。
		 *
		 * 现在的契约：摘要位**只输出一句说明**。
		 *   - 不得出现 title 文案（标题归宿主）；
		 *   - 不得有 button（宿主卡片里不能再塞第二个可点控件）；
		 *   - 不得渲染 wsp-page（完整页只由 view:'page' 出）。
		 * 用记录式取词函数断言，因为函数组件会被 flatten 展开、文案字符串中途丢失。
		 */
		const { mod } = renderPage()
		const requested = []
		const card = mod.WebSearchPlusCard({
			view: 'summary',
			t: (key) => { requested.push(key); return key }
		})
		assert.equal(typeof card, 'object', 'summary 视图必须返回元素，不能是一行字符串')
		const nodes = flatten(card)
		const classes = nodes.map((node) => String(node.props?.className ?? '')).join(' ')
		assert.ok(classes.includes('wsp-summary'), `摘要卡缺 wsp-summary 外层：${classes}`)
		assert.ok(classes.includes('wsp-summary-desc'), '摘要卡缺说明节点')
		assert.ok(requested.includes('summary'), `摘要卡缺 summary 说明，实际取词：${requested.join(', ')}`)
		// 标题归宿主渲染：摘要里再画一遍就是用户看到的「同名两行」。
		assert.ok(!requested.includes('title'), `摘要卡不应再取 title 字典键（标题由宿主渲染），实际取词：${requested.join(', ')}`)
		// 宿主卡片本身是「打开详情」的整卡按钮，里面不能再有第二个可点控件。
		assert.equal(nodes.filter((node) => node.type === 'button').length, 0, '摘要里不能有按钮：宿主卡片的整卡热区会吃掉它的点击')
		assert.ok(!classes.includes('wsp-page'), '摘要视图不应渲染完整设置页')
	})
})

describe('选项卡布局：栅格铺满、动作右对齐', () => {
	/**
	 * 取出设置栅格及其单元。
	 * @param {object[]} nodes - 摊平后的节点。
	 * @returns {object[]} 栅格单元数组。
	 */
	function gridCells(nodes) {
		const grid = nodes.find((node) => String(node.props.className ?? '').split(/\s+/).includes('wsp-grid'))
		assert.ok(grid !== undefined, '没找到设置栅格')
		return (grid.children ?? []).filter(Boolean)
	}

	it('六个设置项填满三列两行，不留空格子', () => {
		const { nodes } = renderPage()
		const cells = gridCells(nodes)
		// 5 个字段 + 1 个复选框 = 6，正好 3 列 × 2 行；多一个或少一个都会留下空格。
		assert.equal(cells.length, 6, `栅格应有 6 个单元，实际 ${cells.length}`)
	})

	it('每个栅格单元都是「标签 + 控件」的同构结构', () => {
		const { nodes } = renderPage()
		for (const [index, cell] of gridCells(nodes).entries()) {
			const kids = flatten(cell.children ?? [])
			const label = kids.find((kid) => kid.type === 'span' && String(kid.props.className ?? '').includes('wsp-label'))
			assert.ok(label !== undefined, `第 ${String(index + 1)} 格缺少标签`)
			const control = kids.find((kid) => kid.type === 'input' || kid.type === 'select'
				|| String(kid.props.className ?? '').includes('wsp-check'))
			assert.ok(control !== undefined, `第 ${String(index + 1)} 格缺少控件`)
			assert.equal(String(cell.props.className ?? '').split(/\s+/).includes('wsp-field'), true, `第 ${String(index + 1)} 格应使用 wsp-field`)
		}
	})

	it('请求摘要答案在第六格，以复选框呈现并显示开关状态', () => {
		// 复选框勾选状态来自页面本地草稿（options 状态），不是快照配置——
		// 用户改动后要能立刻看到反馈，因此这里按草稿播种。
		const on = renderPage({ options: { tavilyIncludeAnswer: true } })
		const onKids = flatten(gridCells(on.nodes)[5].children ?? [])
		const onLabel = onKids.find((kid) => String(kid.props.className ?? '').includes('wsp-label'))
		assert.deepEqual(onLabel.children, ['includeAnswer'], '第六格的标签应是「请求摘要答案」')
		const onCheck = onKids.find((kid) => String(kid.props.className ?? '').includes('wsp-check'))
		assert.ok(onCheck !== undefined, '第六格缺少复选框容器')
		const onBox = flatten(onCheck.children ?? []).find((kid) => kid.type === 'input')
		assert.equal(onBox.props.type, 'checkbox', '第六格的控件应是复选框')
		assert.equal(onBox.props.checked, true, '草稿为 true 时应勾选')
		assert.ok(flatten(onCheck.children ?? []).some((kid) => kid.type === 'span' && (kid.children ?? []).includes('switchOn')), '应显示「已开启」')

		const off = renderPage({ options: { tavilyIncludeAnswer: false } })
		const offCheck = flatten(gridCells(off.nodes)[5].children ?? []).find((kid) => String(kid.props.className ?? '').includes('wsp-check'))
		const offBox = flatten(offCheck.children ?? []).find((kid) => kid.type === 'input')
		assert.equal(offBox.props.checked, false, '草稿为 false 时不应勾选')
		assert.ok(flatten(offCheck.children ?? []).some((kid) => kid.type === 'span' && (kid.children ?? []).includes('switchOff')), '应显示「已关闭」')
	})

	it('保存按钮与复选框同处最后一格、同一行（不再独占一行悬在底部）', () => {
		const { nodes } = renderPage()
		const row = flatten(gridCells(nodes)[5].children ?? [])
			.find((node) => String(node.props.className ?? '').split(/\s+/).includes('wsp-field-row'))
		assert.ok(row !== undefined, '第六格缺少字段内行 .wsp-field-row')
		const kinds = (row.children ?? []).filter(Boolean).map((child) => {
			if (child.type === 'button') return 'button'
			if (child.type === 'label') return 'label'
			return child.type
		})
		assert.deepEqual(kinds, ['label', 'button'], '该行应当是「复选框 + 保存按钮」两项')
		const button = (row.children ?? []).find((child) => child?.type === 'button')
		assert.deepEqual(button.children, ['save'], '该行的按钮应当是保存')
	})

	it('选项卡没有多余的收尾行（卡片顶层只有标题与栅格）', () => {
		const { nodes } = renderPage()
		const card = nodes.find((node) => String(node.props.className ?? '').split(/\s+/).includes('wsp-card')
			&& flatten(node.children ?? []).some((kid) => String(kid.props.className ?? '').split(/\s+/).includes('wsp-grid')))
		assert.ok(card !== undefined, '没找到选项卡')
		const topLevel = (card.children ?? []).filter(Boolean)
		assert.equal(topLevel.length, 2, `选项卡顶层应当只有「标题 + 栅格」两行，实际 ${topLevel.length} 行`)
	})

	it('承载保存按钮的那一格不是 label（否则点保存会顺带切换复选框）', () => {
		const { nodes } = renderPage()
		const cell = gridCells(nodes)[5]
		assert.notEqual(cell.type, 'label', '含按钮的格子绝不能是 label')
		assert.equal(cell.type, 'div', '含按钮的格子应当是 div')
		// 勾选语义交给内层 label：点文字仍可切换复选框。
		const inner = flatten(cell.children ?? []).find((node) => node.type === 'label')
		assert.ok(inner !== undefined, '复选框应当包在 label 里，保证点文字可切换')
		assert.equal(inner.props.className, 'wsp-check')
	})

	it('密钥卡操作行与槽位内容对齐（wsp-actions）', () => {
		const { nodes } = renderPage()
		const row = nodes.find((node) => String(node.props.className ?? '').split(/\s+/).includes('wsp-actions'))
		assert.ok(row !== undefined, '密钥卡操作行缺少 wsp-actions，会与上方槽位内容错位')
	})
})

describe('模块间视觉统一：嵌套盒与卡片标题', () => {
	/**
	 * 渲染**全部五张卡片**。
	 *
	 * 警告卡只在有告警时出现，因此这里显式带上一条告警，否则它根本不参与检查——
	 * 「没渲染」和「渲染了但不一致」必须区分开。
	 *
	 * @returns {object[]} 摊平后的节点。
	 */
	function renderAllCards() {
		return renderPage({ snapshot: { ...SNAPSHOT, warnings: ['示例：某配置项被自动忽略'] } }).nodes
	}

	/**
	 * 取一张卡片的直接内容。
	 * @param {object[]} nodes - 摊平后的节点。
	 * @param {string} titleKey - 卡片标题的字典键。
	 * @returns {object|undefined} 卡片节点。
	 */
	function cardByTitle(nodes, titleKey) {
		return nodes.find((node) => String(node.props.className ?? '').split(/\s+/).includes('wsp-card')
			&& flatten(node.children ?? []).some((kid) => kid.type === 'h3' && (kid.children ?? []).includes(titleKey)))
	}

	const TITLES = ['priorityTitle', 'keysTitle', 'optionsTitle', 'statusTitle', 'warningsTitle']

	it('五张卡片全部渲染（前置条件）', () => {
		const nodes = renderAllCards()
		for (const title of TITLES) {
			assert.ok(cardByTitle(nodes, title) !== undefined, `卡片「${title}」没有渲染，后续统一性检查无意义`)
		}
	})

	it('每张卡片都有标题，且标题与内容同处一个标题组', () => {
		const nodes = renderAllCards()
		for (const title of TITLES) {
			const card = cardByTitle(nodes, title)
			const head = flatten(card.children ?? []).find((kid) => String(kid.props.className ?? '').split(/\s+/).includes('wsp-card-head'))
			assert.ok(head !== undefined, `卡片「${title}」缺少标题组 wsp-card-head`)
		}
	})

	it('每张卡片的标题下都有一行说明（描述或状态）', () => {
		const nodes = renderAllCards()
		for (const title of TITLES) {
			const card = cardByTitle(nodes, title)
			const head = flatten(card.children ?? []).find((kid) => String(kid.props.className ?? '').split(/\s+/).includes('wsp-card-head'))
			const secondary = (head.children ?? []).filter((kid) => typeof kid === 'object' && kid !== null && kid.type === 'p')
			assert.equal(secondary.length, 1, `卡片「${title}」的标题组应有且仅有一行说明，实际 ${secondary.length}`)
		}
	})

	it('每张卡片的内容都装在同一个 wsp-box 里（选项卡不再裸铺字段）', () => {
		const nodes = renderAllCards()
		for (const title of TITLES) {
			const card = cardByTitle(nodes, title)
			const boxes = flatten(card.children ?? [])
				.filter((kid) => String(kid.props.className ?? '').split(/\s+/).includes('wsp-box'))
			assert.ok(boxes.length > 0, `卡片「${title}」的内容没有装在 wsp-box 里，与其他模块不一致`)
		}
	})

	it('所有盒式行都复用共享的 wsp-box 类，没有各自为政', () => {
		const nodes = renderAllCards()
		const boxLike = nodes.filter((node) => {
			const classes = String(node.props.className ?? '').split(/\s+/)
			return classes.includes('wsp-node') || classes.includes('wsp-key')
		})
		assert.ok(boxLike.length > 0, '没有找到任何盒式行')
		const missing = boxLike.filter((node) => !String(node.props.className ?? '').split(/\s+/).includes('wsp-box'))
		assert.deepEqual(
			missing.map((node) => node.props.className),
			[],
			'这些盒式行没有复用 wsp-box —— 盒子外观会再次各自漂移'
		)
	})

	it('选项表单与状态链使用同一种盒子行', () => {
		const nodes = renderAllCards()
		const optionsCard = cardByTitle(nodes, 'optionsTitle')
		const box = flatten(optionsCard.children ?? [])
			.find((kid) => String(kid.props.className ?? '').split(/\s+/).includes('wsp-box'))
		assert.ok(box !== undefined, '选项卡的盒子缺失')
		assert.equal(box.type, 'div', '选项卡内容应当包在 div 盒子里')
		assert.ok(flatten(box.children ?? []).some((kid) => String(kid.props.className ?? '').split(/\s+/).includes('wsp-grid')), '盒子内应当装着设置栅格')
	})
})

describe('密钥输入：掩码与明文切换', () => {
	/**
	 * 取出密钥输入行里的输入框与眼睛按钮。
	 * @param {object[]} nodes - 摊平后的节点。
	 * @returns {{ input: object, eye: object }} 输入框与眼睛按钮。
	 */
	function keyInputParts(nodes) {
		const input = nodes.find((node) => node.type === 'input')
		assert.ok(input !== undefined, '没找到密钥输入框')
		const eye = nodes.find((node) => node.type === 'button' && String(node.props.className).includes('wsp-eye'))
		assert.ok(eye !== undefined, '没找到眼睛按钮')
		return { input, eye }
	}

	it('默认是掩码输入（type=password）', () => {
		const { nodes } = renderPage()
		const { input } = keyInputParts(nodes)
		assert.equal(input.props.type, 'password', '密钥输入框默认必须是掩码，不能明文显示')
	})

	it('眼睛按钮可访问：有 aria-label / aria-pressed / title', () => {
		// 用「有草稿」的状态断言可交互语义：无草稿时按钮按设计禁用。
		const { nodes } = renderPage({ drafts: { TAVILY_API_KEY: 'sk-test' } })
		const { eye } = keyInputParts(nodes)
		assert.equal(eye.props['aria-label'], 'keyShow', '未显示时按钮语义应为「显示密钥」')
		assert.equal(eye.props['aria-pressed'], false, 'aria-pressed 初始应为 false')
		assert.equal(eye.props.title, 'keyShow')
		assert.equal(eye.props.type, 'button', '眼睛按钮必须是 type=button，避免触发表单提交')
	})

	it('点击眼睛后切换为明文（type=text），并更新语义', () => {
		// 直接驱动受控状态：模拟点一次眼睛之后的重渲染。
		const { nodes } = renderPage({ revealed: { TAVILY_API_KEY: true }, drafts: { TAVILY_API_KEY: 'sk-test' } })
		const { input, eye } = keyInputParts(nodes)
		assert.equal(input.props.type, 'text', '切换后应为明文输入')
		assert.equal(eye.props['aria-label'], 'keyHide', '明文时语义应变为「隐藏密钥」')
		assert.equal(eye.props['aria-pressed'], true, 'aria-pressed 应为 true')
	})

	it('眼睛按钮内含 SVG 图标（睁眼/闭眼两种形态）', () => {
		const closed = renderPage({ drafts: { TAVILY_API_KEY: 'sk-test' } })
		const closedEye = closed.nodes.find((n) => n.type === 'button' && String(n.props.className).includes('wsp-eye'))
		const closedSvg = flatten(closedEye.children ?? []).filter((n) => n.type === 'svg')
		assert.equal(closedSvg.length, 1, '闭眼状态应有一个 svg')
		assert.equal(closedSvg[0].props['aria-hidden'], 'true', '图标本身应对辅助技术隐藏')

		const open = renderPage({ revealed: { TAVILY_API_KEY: true }, drafts: { TAVILY_API_KEY: 'sk-test' } })
		const openEye = open.nodes.find((n) => n.type === 'button' && String(n.props.className).includes('wsp-eye'))
		const openSvg = flatten(openEye.children ?? []).filter((n) => n.type === 'svg')
		assert.equal(openSvg.length, 1, '睁眼状态应有一个 svg')
		// 两种形态的子节点数不同（睁眼是 路径+圆，闭眼是 三路径+斜线），据此确认真的换了图标。
		assert.notEqual(
			(closedSvg[0].children ?? []).length,
			(openSvg[0].children ?? []).length,
			'睁眼与闭眼应当是不同图标'
		)
	})

	it('眼睛按钮的悬停态同样用交互令牌（不重蹈白底白字）', () => {
		const { mod } = renderPage()
		const css = mod.styles[0] ?? ''
		assert.match(css, /\.wsp-eye:not\(:disabled\):hover\s*\{[^}]*--dsw-alias-interactive-bg-hover/, '眼睛按钮悬停应使用交互令牌')
		assert.match(css, /\.wsp-eye:focus-visible\s*\{/, '眼睛按钮应有键盘焦点样式')
	})

	it('切换状态按槽位隔离，不是全局一个开关', () => {
		const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
		// revealed 以引用名为键：{ [ref]: true }，而不是单个 boolean。
		assert.match(source, /setRevealed\(\(current\) => \(\{ \.\.\.current, \[ref\]: current\[ref\] !== true \}\)\)/, '切换应按槽位记录')
		assert.match(source, /revealed\[slot\.ref\] === true/, '读取时应按槽位取')
	})

	it('掩码不会改变提交的值（掩码只影响显示）', () => {
		const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
		// onSaveKey 读的是 drafts，与 revealed 无关。
		assert.match(source, /const value = \(drafts\[ref\] \?\? ''\)\.trim\(\)/, '保存时应读取草稿值')
		assert.ok(!/value = .*revealed/.test(source), '保存值不应受明文开关影响')
	})
})

describe('密钥显示：有内容就看得见（与是否已保存无关）', () => {
	it('有草稿时输入框显示真实内容（掩码形态）', () => {
		const { nodes } = renderPage({ drafts: { TAVILY_API_KEY: 'sk-live-value' } })
		const input = nodes.find((node) => node.type === 'input')
		assert.equal(input.props.value, 'sk-live-value', '输入框应保留用户输入的内容')
		assert.equal(input.props.type, 'password', '默认以掩码呈现')
		assert.ok(!String(input.props.className).includes('wsp-input-stored'), '有真实内容时不应使用「已保存」占位样式')
	})

	it('有草稿时眼睛可点（能看到明文）', () => {
		const { nodes } = renderPage({ drafts: { TAVILY_API_KEY: 'sk-live-value' } })
		const eye = nodes.find((n) => n.type === 'button' && String(n.props.className).includes('wsp-eye'))
		assert.notEqual(eye.props.disabled, true, '有内容时眼睛必须可用')
	})

	it('已保存但草稿为空时，用点阵占位提示「这里有一把密钥」', () => {
		const { nodes } = renderPage()
		const input = nodes.find((node) => node.type === 'input')
		assert.equal(input.props.value, '', '占位不是真值，value 必须为空')
		assert.match(String(input.props.placeholder), /^•+$/, '占位应为点阵')
		assert.match(String(input.props.className), /wsp-input-stored/, '应使用「已保存」占位样式')
	})

	it('点阵占位绝不参与提交（空草稿时保存按钮禁用）', () => {
		const { nodes } = renderPage()
		const buttons = nodes.filter((n) => n.type === 'button')
		const save = buttons.find((n) => (n.children ?? []).includes('keySave'))
		assert.ok(save !== undefined, '没找到保存密钥按钮')
		assert.equal(save.props.disabled, true, '草稿为空时保存必须禁用，否则会把点阵当成密钥写进去')
	})

	it('已保存且无草稿时眼睛**可用**，点它去取一次明文（本次修复）', () => {
		/*
		 * 旧契约是「草稿为空 ⇒ 眼睛禁用，提示先输入才能查看明文」。但「已保存」的语义
		 * 恰恰是草稿为空、输入框只显示点阵——于是保存过的密钥永远看不了，
		 * 用户报障「保存过的密钥没法点小眼睛显示」。
		 *
		 * 新契约：已保存 ⇒ 眼睛可用，点它调用 onRevealStored 向宿主按需取一次明文。
		 * 这里断言的是**按钮可用且点击会去取值**，而不是「取到的值」——
		 * 取值路径由路由测试与浏览器验收覆盖。
		 */
		const { nodes } = renderPage()
		const eye = nodes.find((n) => n.type === 'button' && String(n.props.className).includes('wsp-eye'))
		assert.equal(eye.props.disabled, false, '已保存的密钥必须能点开查看')
		assert.equal(eye.props.title, 'keyShowStored', '应提示「查看已保存的密钥」')
	})

	it('已保存时点击眼睛调用 onRevealStored；有草稿时仍走本地切换', () => {
		const { mod } = renderPage()
		/**
		 * 直接渲染 KeyInput，收集它触发的回调。
		 * @param {object} overrides - 覆盖的 props。
		 * @returns {{eye: object, calls: object}} 眼睛节点与调用记录。
		 */
		const mount = (overrides) => {
			const calls = { toggled: 0, revealed: 0 }
			const element = mod.KeyInput({
				t: (key) => key,
				value: '',
				revealed: false,
				disabled: false,
				configured: true,
				placeholder: 'p',
				onChange: () => {},
				onToggle: () => { calls.toggled += 1 },
				onRevealStored: () => { calls.revealed += 1 },
				revealing: false,
				...overrides
			})
			const eye = flatten(element).find((node) => node.type === 'button' && String(node.props.className).includes('wsp-eye'))
			assert.ok(eye !== undefined, '没找到眼睛按钮')
			return { eye, calls }
		}

		// 已保存、无草稿 → 点眼睛要去宿主取值
		const stored = mount({})
		stored.eye.props.onClick()
		assert.equal(stored.calls.revealed, 1, '已保存的密钥应触发一次取值')
		assert.equal(stored.calls.toggled, 0, '已保存时不该只做本地切换')

		// 有草稿 → 点眼睛只是本地切换，不该发请求
		const drafted = mount({ value: 'tvly-xxx' })
		drafted.eye.props.onClick()
		assert.equal(drafted.calls.toggled, 1, '有草稿时应本地切换')
		assert.equal(drafted.calls.revealed, 0, '有草稿时不该向宿主取值')

		// 未配置且无草稿 → 眼睛禁用
		const empty = mount({ configured: false })
		assert.equal(empty.eye.props.disabled, true, '没有可揭示的内容时眼睛应禁用')
		assert.equal(empty.eye.props.title, 'keyRevealHint')
	})

	it('保存后不再清空草稿（否则输入框会突然变空）', () => {
		const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
		const saveFn = source.slice(source.indexOf('const onSaveKey'), source.indexOf('const onClearKey'))
		assert.ok(!/setDrafts\(/.test(saveFn), 'onSaveKey 不应清空草稿——那正是「保存后输入框变空」的根因')
	})

	it('已保存密钥的字面值永不来自宿主响应（点阵是占位而非真值）', () => {
		const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
		assert.match(source, /const SAVED_KEY_MASK = '•+'/, '应有固定的点阵常量')
		// 该常量只能出现在 placeholder 里，绝不能出现在 value 或提交体里。
		assert.ok(!/value:\s*SAVED_KEY_MASK/.test(source), '点阵绝不能被当作输入值')
		assert.ok(!/SAVED_KEY_MASK\s*[,)]/.test(source.replace(/placeholder:[^,]*/g, '')), '点阵只能用于 placeholder')
	})
})

describe('设置卡片：迁入「体验优化」平台子插槽 experience-plus.item', () => {
	it('注册名、id、排序与标签都正确，且订阅的是平台子插槽', () => {
		const { mod, ledger } = renderPage()
		const entry = ledger.registered.find((item) => item.spec.id === 'web-search-plus')
		assert.ok(entry !== undefined, '没有注册任何卡片')
		assert.equal(entry.spec.name, 'experience-plus.item', '卡片必须注册进平台子插槽')
		assert.equal(entry.spec.order, 60, 'order 应排在平台自己的功能（10–50）与「扩展能力」分组标题（55）之后')
		assert.equal(entry.spec.locale, mod.NS)
		assert.equal(entry.spec.label(), 'title', '卡片标题应当走字典')
		assert.equal(entry.component, mod.WebSearchPlusCard, '注册的组件必须是本插件的卡片')
		assert.ok(ledger.injected.includes('experience-plus.item'), '没有订阅平台子插槽')
	})

	it('卡片只挂一处：平台可用时不出现在内核「内置插件」页', () => {
		const { ledger } = renderPage()
		ledger.declare('experience-plus.item')
		ledger.declare('plugins.item')
		assert.deepEqual(ledger.slotsInUse(), ['experience-plus.item'], '平台可用时卡片不得同时挂在 plugins.item 上')
	})
})

describe('兜底：平台插槽不可用时退回内核插件页', () => {
	it('平台插槽从未声明：兜底插槽一出现就接管，设置卡片仍能显示', () => {
		// apply() 时两个插槽都还没声明（真实时序：两个页面都还没挂载）。
		const { ledger } = renderPage({ ledger: createSlotLedger([]) })
		assert.deepEqual(ledger.slotsInUse(), [], '插槽还没声明时不该抢先注册')
		ledger.declare('plugins.item')
		const entry = ledger.registered.find((item) => item.spec.id === 'web-search-plus')
		assert.ok(entry !== undefined, '平台不在时卡片必须退回 plugins.item，否则设置够不着')
		assert.equal(entry.spec.name, 'plugins.item')
		// 判据不是「平台回调没触发」：平台那一路回调**一次都没跑**，兜底照样成立。
		assert.deepEqual(ledger.fired, ['plugins.item'], '兜底注册应当由兜底插槽自己的声明驱动，与平台回调无关')
	})

	it('平台后到：卡片从兜底迁到平台，兜底那份同时撤销（不留重复）', () => {
		const { ledger } = renderPage({ ledger: createSlotLedger([]) })
		ledger.declare('plugins.item')
		assert.deepEqual(ledger.slotsInUse(), ['plugins.item'])
		ledger.declare('experience-plus.item')
		assert.deepEqual(ledger.slotsInUse(), ['experience-plus.item'], '平台就绪后必须只剩平台那一份')
		assert.equal(ledger.registered.length, 1, '同一张卡片不得留下两份注册')
	})

	it('平台塌陷：卡片回到兜底插槽，设置项不会凭空消失', () => {
		const { ledger } = renderPage()
		ledger.declare('plugins.item')
		assert.deepEqual(ledger.slotsInUse(), ['experience-plus.item'])
		ledger.collapse('experience-plus.item')
		assert.deepEqual(ledger.slotsInUse(), ['plugins.item'], '平台卸载后卡片必须回到兜底插槽')
		// 平台再次声明：卡片再迁回平台。
		ledger.declare('experience-plus.item')
		assert.deepEqual(ledger.slotsInUse(), ['experience-plus.item'])
	})

	it('平台不可用且兜底插槽也没了：不注册、不抛错，插件照常加载', () => {
		const { ledger } = renderPage({ ledger: createSlotLedger([]) })
		ledger.declare('plugins.item')
		ledger.collapse('plugins.item')
		assert.deepEqual(ledger.slotsInUse(), [])
		ledger.declare('plugins.item')
		assert.deepEqual(ledger.slotsInUse(), ['plugins.item'], '兜底插槽回来时卡片应当自动回来')
	})

	it('插件卸载：两处注册都撤掉（不留孤儿卡片）', () => {
		const { ledger, unload } = renderPage({ ledger: createSlotLedger([]) })
		ledger.declare('plugins.item')
		ledger.declare('experience-plus.item')
		assert.deepEqual(ledger.slotsInUse(), ['experience-plus.item'])
		unload()
		assert.deepEqual(ledger.slotsInUse(), [], '卸载后不得留下任何注册')
	})

	it('判据是同步探测而不是「回调有没有到」：平台已声明时兜底不抢位', () => {
		/*
		 * 这里刻意让平台插槽「已声明但不叫醒监听者」：内核正常工作时两者同步，
		 * 但判据必须选**同步探测**（先探测、后使用），而不是「平台回调没到就认定插槽不存在」——
		 * 后者会把「还没到」当成「不存在」，正是兜底最容易被写错的地方。
		 */
		const { ledger } = renderPage({ ledger: createSlotLedger([]) })
		ledger.declare('experience-plus.item', { notify: false })
		ledger.declare('plugins.item')
		assert.equal(
			ledger.registered.some((entry) => entry.spec.name === 'plugins.item'),
			false,
			'同步探测说平台插槽已声明，兜底就不该抢位'
		)
	})

	it('更老的内核没有 slots.spec：探测答不上来时按「平台不可用」处理，先兜底', () => {
		const ledger = createSlotLedger([])
		// 抹掉同步探测面，模拟更老的内核。
		delete ledger.slots.spec
		const { ledger: used } = renderPage({ ledger })
		used.declare('plugins.item')
		assert.deepEqual(used.slotsInUse(), ['plugins.item'], '没有探测面时应当保守地先走兜底')
		used.declare('experience-plus.item')
		assert.deepEqual(used.slotsInUse(), ['experience-plus.item'], '平台插槽真的出现时再迁回平台')
	})
})

/**
 * 跨版本降级：插槽服务「形状漂移」时，卡片可以停用，插件绝不能被判成 FAILED。
 *
 * 契约 §二.1：任何内核依赖都必须**先探测、后使用**；§二.2：绝不让插件 FAILED、绝不抛穿。
 * `ctx.slots` 存在不等于它有 `inject` / `register`——内核改过方法名，或某个版本只暴露
 * 一部分能力时，直接调用抛出的 `TypeError` 会从 `apply()` 穿出去，把整个插件变成红条。
 *
 * 这三条刻意都用**真实的形状漂移**（删掉某个方法 / 让它抛错）驱动，而不是文本匹配：
 * 只有在真的调用一次时才会暴露，所以它们既能验当前行为，也能当作回归关卡。
 */
describe('跨版本降级：插槽服务形状漂移时不抛穿（契约 §二.1 / §二.2）', () => {
	/**
	 * 在渲染期间捕获插件写出的日志。
	 *
	 * 客户端 bundle 跑在 vm 沙箱里，而沙箱拿到的 `console` 就是本进程这个对象，
	 * 所以替换 `console.warn` 就能把降级日志抓下来。
	 *
	 * @param {Function} work - 要执行的动作。
	 * @returns {{ value: object, warnings: string[] }} 动作的返回值与捕获到的日志。
	 */
	const captureWarnings = (work) => {
		const warnings = []
		const original = console.warn
		console.warn = (...args) => warnings.push(args.map(String).join(' '))
		try {
			return { value: work(), warnings }
		} finally {
			console.warn = original
		}
	}

	it('有 spec/register 但没有 inject：停用这张卡片、不抛错、日志写明缺什么', () => {
		const ledger = createSlotLedger([])
		delete ledger.slots.inject
		const { value, warnings } = captureWarnings(() => renderPage({ ledger }))
		assert.ok(
			warnings.some((line) => line.includes('设置卡片停用') && line.includes('ctx.slots.inject')),
			`日志必须写明「停用」与缺的是 inject，实际：${warnings.join(' / ') || '（无）'}`
		)
		assert.deepEqual(ledger.slotsInUse(), [], '能力不足时不该注册任何卡片')
		// 停用是终局：插槽后来出现也不该「复活」这张卡片（重启后才重新探测）。
		ledger.declare('experience-plus.item')
		ledger.declare('plugins.item')
		assert.deepEqual(ledger.slotsInUse(), [], '停用后不该再注册')
		value.unload()
	})

	it('缺 register：同样停用、不抛错、日志写明缺什么', () => {
		const ledger = createSlotLedger([])
		delete ledger.slots.register
		const { value, warnings } = captureWarnings(() => renderPage({ ledger }))
		assert.ok(
			warnings.some((line) => line.includes('设置卡片停用') && line.includes('ctx.slots.register')),
			`日志必须写明「停用」与缺的是 register，实际：${warnings.join(' / ') || '（无）'}`
		)
		assert.deepEqual(ledger.slotsInUse(), [])
		value.unload()
	})

	it('register 存在但一调就抛错：只记日志、不抛穿、插件照常加载', () => {
		// 默认账本里两个插槽都已声明，于是 inject 回调会同步跑进 mount()。
		const ledger = createSlotLedger()
		ledger.slots.register = () => { throw new Error('内核拒绝注册（模拟形状漂移）') }
		const { value, warnings } = captureWarnings(() => renderPage({ ledger }))
		assert.ok(
			warnings.some((line) => line.includes('设置卡片注册失败') && line.includes('experience-plus.item')),
			`日志必须写明是哪张插槽注册失败，实际：${warnings.join(' / ') || '（无）'}`
		)
		assert.deepEqual(ledger.slotsInUse(), [], '注册抛错时不该留下半成品')
		// 卸载照常可跑（没有半装上的控制器泄漏）。
		value.unload()
	})

	it('inject 一调就抛错：撤掉半装上的控制器、记日志、不抛穿', () => {
		// 形状探测通过（方法在），但调用那一刻失败——这是探测挡不住的那一半。
		const ledger = createSlotLedger()
		ledger.slots.inject = () => { throw new Error('内核拒绝 inject（模拟形状漂移）') }
		const { value, warnings } = captureWarnings(() => renderPage({ ledger }))
		assert.ok(
			warnings.some((line) => line.includes('设置卡片等待插槽失败')),
			`日志必须写明等待插槽失败，实际：${warnings.join(' / ') || '（无）'}`
		)
		assert.deepEqual(ledger.slotsInUse(), [], '注入失败时不该留下半装上的注册')
		value.unload()
	})

	it('register 不返回撤销函数（形状漂移）：平台塌陷后卡片仍回得来', () => {
		/*
		 * 形状漂移：内核的 `register` 改成 fire-and-forget（不返回撤销函数）。
		 * 这时「这张插槽上有没有我们的条目」必须靠 `mounted` 表的**存在性**判断，
		 * 不能靠「撤销函数是不是 undefined」——后者会把「挂过、没有撤销函数」
		 * 误当成「从没挂过」，于是塌陷一次之后平台再声明时卡片回不到平台插槽。
		 *
		 * 真实内核塌陷时会清掉该插槽上的贡献，所以这里也照做（按插槽清账）。
		 */
		const ledger = createSlotLedger()
		const live = []
		ledger.slots.register = (spec) => { live.push(spec.name); return undefined }
		const collapse = ledger.collapse
		ledger.collapse = (key) => {
			collapse(key)
			for (let index = live.length - 1; index >= 0; index -= 1) {
				if (live[index] === key) live.splice(index, 1)
			}
		}
		const { ledger: used } = renderPage({ ledger })
		assert.deepEqual(live, ['experience-plus.item'], '初始应挂在平台插槽')
		used.collapse('experience-plus.item')
		assert.deepEqual(live, ['plugins.item'], '平台塌陷后应回到兜底插槽')
		used.declare('experience-plus.item')
		assert.ok(
			live.includes('experience-plus.item'),
			'平台再声明后卡片必须回到平台插槽（形状漂移不能让它卡在兜底）'
		)
	})
})

describe('按钮互不串联：一个动作在途时只锁自己那一族控件', () => {
	/*
	 * 报障原文：「点按其中一个会导致该页面所有按钮生效」。
	 *
	 * 排查结论：按钮并没有真的被一起点击，但页面级 `busy` 让**全页 23 个按钮同时变灰、
	 * 再同时恢复**，还给同一个绿色提示——视觉上与「全部被触发」无法区分。
	 * 修复成按动作登记 pending 后，这里锁死三件事：
	 *   1. 每个按钮都是显式的 type="button"（宿主若把插槽放进 <form>，缺省 type 会
	 *      让每个按钮都变成 submit，一次点击连带提交整个表单）；
	 *   2. 某个动作在途时，**别族**的按钮不能跟着变灰；
	 *   3. 同一族同一行的控件该锁的仍然锁住（不能为了解耦把互斥也拆掉）。
	 */
	/**
	 * 取出页面里所有按钮节点。
	 * @param {object[]} nodes - 摊平后的节点。
	 * @returns {object[]} button 节点。
	 */
	function buttons(nodes) {
		return nodes.filter((node) => node.type === 'button')
	}

	it('每个按钮都显式声明 type="button"，不会被宿主表单当成 submit', () => {
		const { nodes } = renderPage()
		const list = buttons(nodes)
		assert.ok(list.length >= 14, `应渲染出整页按钮，实际 ${String(list.length)} 个`)
		const missing = list.filter((node) => node.props.type !== 'button')
		assert.equal(missing.length, 0, `${String(missing.length)} 个按钮没有 type="button"：会在宿主 <form> 里触发整表提交`)
	})

	it('密钥区在途时，优先级 / 选项 / 接管按钮都保持可用', () => {
		// 接管前（active:false）的快照：此时「立即接管」本该可用，用它验证解耦。
		// 优先级只有一项，先把顺序换成两项的固定快照，否则「上移」永远禁用、
		// 断言会假绿。
		const snapshot = {
			...SNAPSHOT,
			config: { ...SNAPSHOT.config, priority: ['tavily', 'deepseek-official'] },
			takeover: { ...SNAPSHOT.takeover, active: false, seamProvider: undefined }
		}
		const { nodes } = renderPage({ snapshot, pending: { 'key:TAVILY_API_KEY': true } })
		const list = buttons(nodes)
		/** 列表里所有该文案的按钮。 */
		const all = (text) => list.filter((node) => (node.children ?? [])[0] === text)
		// 首行的「上移」与末行的「下移」按位置本来就被禁用（索引 0 / 末位），
		// 所以这里断言的是**每一项里至少有一个可用**，避免把位置禁用当成串联。
		assert.ok(all('moveUp').some((node) => node.props.disabled !== true), '优先级里的「上移」被密钥动作锁住了')
		assert.ok(all('moveDown').some((node) => node.props.disabled !== true), '优先级里的「下移」被密钥动作锁住了')
		for (const label of ['save', 'takeoverDo', 'probeRun', 'usageCheck']) {
			const button = all(label)[0]
			assert.ok(button !== undefined, `没找到按钮 ${label}`)
			assert.notEqual(button.props.disabled, true, `${label} 不该被密钥保存动作锁住`)
		}
	})

	it('某个密钥槽位在途时，只锁该槽位自己的按钮', () => {
		// 三槽位快照：第 1 个在途，第 2、3 个的清除/移除应保持可用。
		const snapshot = {
			...SNAPSHOT,
			keys: ['TAVILY_API_KEY', 'TAVILY_API_KEY_2', 'TAVILY_API_KEY_3'].map((ref) => (
				{ ref, state: 'ready', sticky: false, configured: true, writable: true, cooldownUntil: 0 }))
		}
		const { nodes } = renderPage({ snapshot, pending: { 'key:TAVILY_API_KEY': true } })
		const list = buttons(nodes)
		const clears = list.filter((node) => (node.children ?? [])[0] === 'keyClear')
		const removes = list.filter((node) => (node.children ?? [])[0] === 'removeKey')
		assert.equal(clears.length, 3, `应有 3 个「清除密钥」按钮，实际 ${String(clears.length)}`)
		assert.equal(removes.length, 3, `应有 3 个「移除」按钮，实际 ${String(removes.length)}`)
		assert.equal(clears[0].props.disabled, true, '在途槽位的清除按钮应锁住')
		assert.notEqual(clears[1].props.disabled, true, '第 2 槽位的清除按钮不该被第 1 槽位锁住')
		assert.notEqual(clears[2].props.disabled, true, '第 3 槽位的清除按钮不该被第 1 槽位锁住')
		assert.notEqual(removes[1].props.disabled, true, '第 2 槽位的移除按钮不该被第 1 槽位锁住')
	})

	it('保存密钥在途只锁本槽位的输入框与保存按钮，别的槽位照常可编辑', () => {
		const snapshot = {
			...SNAPSHOT,
			keys: ['TAVILY_API_KEY', 'TAVILY_API_KEY_2'].map((ref) => (
				{ ref, state: 'ready', sticky: false, configured: true, writable: true, cooldownUntil: 0 }))
		}
		const { nodes } = renderPage({
			snapshot,
			pending: { 'key:TAVILY_API_KEY': true },
			drafts: { TAVILY_API_KEY: 'a', TAVILY_API_KEY_2: 'b' }
		})
		const inputs = nodes.filter((node) => node.type === 'input' && node.props.type === 'password')
		assert.equal(inputs.length, 2, `应有两个密钥输入框，实际 ${String(inputs.length)}`)
		assert.equal(inputs[0].props.disabled, true, '在途槽位的输入框应锁住')
		assert.notEqual(inputs[1].props.disabled, true, '另一槽位的输入框不该被连带锁住')
		const saves = buttons(nodes).filter((node) => (node.children ?? [])[0] === 'keySave')
		assert.equal(saves[0].props.disabled, true, '在途槽位的保存按钮应锁住')
		assert.notEqual(saves[1].props.disabled, true, '另一槽位的保存按钮不该被连带锁住')
	})

	it('试一次搜索在途时，接管 / 交还 / 查额度都不受牵连', () => {
		// 接管前快照：「立即接管」本应可用、「交还」本应禁用——禁用理由只能是自身的
		// active 状态，不能是「试搜正在跑」。
		const snapshot = { ...SNAPSHOT, takeover: { ...SNAPSHOT.takeover, active: false, seamProvider: undefined } }
		const { nodes } = renderPage({ snapshot, pending: { probe: true } })
		const list = buttons(nodes)
		/** 按文案取按钮。 */
		const byText = (text) => list.find((node) => (node.children ?? [])[0] === text)
		const probe = byText('probing')
		assert.ok(probe !== undefined, '在途时「试一次搜索」应显示 probing 文案')
		assert.equal(probe.props.disabled, true, '在途的按钮自己要锁住')
		for (const label of ['takeoverDo', 'usageCheck']) {
			const button = byText(label)
			assert.ok(button !== undefined, `没找到按钮 ${label}`)
			assert.notEqual(button.props.disabled, true, `${label} 不该被「试一次搜索」锁住`)
		}
	})
})

describe('接管状态与配置提醒必须同源、不自相矛盾', () => {
	/*
	 * 报障原文：「圈出来的『已接管』和『配置提醒』是否冲突」。
	 *
	 * 真实缺陷：`routes.js` 读的是 `ctx.web.searchProviderId`，而宿主的 `WebRuntime`
	 * 根本没有这个属性 —— 取值只经由 `config.searchProvider.get()`（volatile
	 * 访问器，`$DSH_WEB_SEARCH_PROVIDER` 是同一字段的覆盖）。于是永远读到
	 * `undefined`，快照报 `active: false` + 「配置有歧义」，
	 * 而 profile 里明明写着 `searchProvider: web-search-plus`、搜索实际跑在链上。
	 *
	 * 下面两条从**两侧**夹住这个 bug：
	 *   1. 宿主真实形状（只有 config 访问器）⇒ active 为真、无歧义告警；
	 *   2. 宿主没配置（访问器返回 undefined）⇒ 才允许报「有歧义」。
	 * 缺了第 1 条，测试会继续认可一个宿主不存在的属性。
	 */
	/**
	 * 用真实 seam 形状跑一次快照。
	 * @param {string|undefined} configured - 宿主 config.searchProvider 的值。
	 * @param {string[]} registered - 注册表里的提供方 id。
	 * @returns {Promise<object>} 快照。
	 */
	async function snapshotWith(configured, registered = ['deepseek-official', 'deepseek-search-api', 'web-search-plus']) {
		const { createRouter } = await import('../lib/routes.js')
		const providers = new Map(registered.map((id) => [id, {}]))
		const ctx = {
			web: {
				searchProviders: providers,
				config: { searchProvider: { get: () => configured }, fetchProvider: { get: () => 'http' } }
			},
			get: () => undefined
		}
		const handle = createRouter({
			ctx,
			readState: () => ({
				config: {
					priority: ['tavily', 'deepseek-official'],
					tavilyKeyRefs: [],
					tavilyBaseURL: 'https://api.tavily.com',
					tavilyMaxResults: 8,
					tavilySearchDepth: 'basic',
					tavilyIncludeAnswer: true,
					tavilyTimeoutMs: 30000,
					tavilyRateLimitCooldownMs: 60000
				},
				warnings: []
			}),
			tavily: {},
			keyRing: { sync() {}, snapshot: () => [] },
			chain: { describe: () => ({ chain: [] }) },
			version: () => '0.1.0'
		})
		const res = {
			writeHead() {},
			end(body) { this.body = JSON.parse(body) }
		}
		await handle({ url: '/api/dsh-web-search-plus', method: 'GET', headers: { host: '127.0.0.1:3124' }, socket: { remoteAddress: '127.0.0.1' }, on() {} }, res)
		return res.body
	}

	it('宿主已配置成本插件时，必须报「已接管」且不得再报「配置有歧义」', async () => {
		const snap = await snapshotWith('web-search-plus')
		assert.equal(snap.takeover.active, true, '宿主已指定 web-search-plus，快照却报未接管')
		assert.equal(snap.takeover.seamProvider, 'web-search-plus', '没有把宿主配置的提供方 id 读回来')
		assert.equal(snap.takeover.ambiguous, false, '已显式配置时不该再判为「有歧义」')
		assert.deepEqual(snap.warnings, [], `已接管时不应有「未指定用哪个」的提醒，实际：${JSON.stringify(snap.warnings)}`)
	})

	it('宿主确实没配置且多个提供方并存时，才报「配置有歧义」', async () => {
		const snap = await snapshotWith(undefined)
		assert.equal(snap.takeover.active, false)
		assert.equal(snap.takeover.ambiguous, true, '无显式配置且多提供方时必须报歧义')
		assert.equal(snap.warnings.length, 1, '歧义状态必须有一条可执行提醒')
		assert.match(snap.warnings[0], /搜索提供方/, '提醒要说明是搜索提供方的问题')
	})

	it('只剩一个提供方时，未显式配置也不算歧义', async () => {
		const snap = await snapshotWith(undefined, ['web-search-plus'])
		assert.equal(snap.takeover.ambiguous, false, '唯一可用提供方时宿主会自动选中，不该报歧义')
	})

	it('环境变量 DSH_WEB_SEARCH_PROVIDER 与配置字段等价', async () => {
		const previous = process.env.DSH_WEB_SEARCH_PROVIDER
		process.env.DSH_WEB_SEARCH_PROVIDER = 'web-search-plus'
		try {
			const snap = await snapshotWith(undefined)
			assert.equal(snap.takeover.active, true, '环境变量是同一字段的覆盖，应视为已接管')
		} finally {
			if (previous === undefined) delete process.env.DSH_WEB_SEARCH_PROVIDER
			else process.env.DSH_WEB_SEARCH_PROVIDER = previous
		}
	})
})
describe('点击后的布局稳定性：提示行必须常驻占位，不能撑高再收回', () => {
	/*
	 * 报障：「点【保存选项】的一瞬间会变成【保存中…】，原本只作用当前点击 UI，
	 * 但整个 UI 会随着闪一下」。
	 *
	 * 逐帧实测（requestAnimationFrame）：状态卡高度 1206 → 1236 跳两次，
	 * 全页 `:disabled` 9 → 20 → 9。成因之一是提示行按「有则渲染、无则摘除」：
	 * 操作一开始 `setMessage(undefined)` 把这一行摘掉，成功后连同新文案重新挂上，
	 * 卡片随之长高再变矮，下方所有内容跟着位移——就是那一下「闪」。
	 *
	 * 现在的契约：提示**容器**始终渲染（类名含 wsp-note-slot、保留一行高度），
	 * 只有里面的文字随消息变化。这条断言锁住「容器常驻」，防止有人再写成条件渲染。
	 */
	/**
	 * 取状态卡里的提示槽位节点。
	 * @param {object[]} nodes - 摊平后的节点。
	 * @returns {object[]} 带 wsp-note-slot 的节点。
	 */
	function noteSlots(nodes) {
		return nodes.filter((node) => String(node.props.className ?? '').split(/\s+/).includes('wsp-note-slot'))
	}

	it('没有消息时，提示容器依然存在（空行占位）', () => {
		const { nodes } = renderPage()
		const slots = noteSlots(nodes)
		assert.equal(slots.length, 1, `应始终有一个提示槽位，实际 ${String(slots.length)} 个`)
		assert.equal(slots[0].props['aria-live'], 'polite', '提示槽位要能播报，但不能每帧打扰读屏')
	})

	it('有消息时，复用同一个槽位而不是额外新增一行', () => {
		const { nodes } = renderPage()
		const slots = noteSlots(nodes)
		assert.equal(slots.length, 1, '有消息时也不该多出第二个提示节点——多一个就会撑高卡片')
	})

	it('提示槽位不携带色调类名时表示「无消息」', () => {
		const { nodes } = renderPage()
		const slot = noteSlots(nodes)[0]
		const classes = String(slot.props.className ?? '').split(/\s+/)
		assert.ok(!classes.some((name) => ['wsp-note-ok', 'wsp-note-err', 'wsp-note-warn'].includes(name)),
			'无消息时空槽位不该带色调类名（会让空行看起来像一条状态）')
	})
})
