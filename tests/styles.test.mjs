/**
 * 回归测试：插件页样式的**悬停可读性**。
 *
 * ## 为什么必须有这个文件
 *
 * 事故：按钮悬停后反而看不清文字。
 *
 * - 浅色模式：悬停背景 `--dsw-alias-bg-layer-2` 解析为 `#fff`（纯白），
 *   而主按钮文字 `--dsw-alias-label-primary-foreground` **也是** `#fff`
 *   → 白底白字，完全不可见；
 * - 深色模式：悬停背景解析为 `#2c2c2e`，文字是 `#0f1115` → 深底深字，同样看不清。
 *
 * 根因是**两条规则打架**：通用 `.wsp-btn:hover` 只改背景、
 * 主按钮 `.wsp-btn-primary` 自带前景色，前者优先级更高就把配对的背景换掉了。
 *
 * 这个文件因此**不用字符串断言**，而是：
 *   1. 用宿主真实的令牌取值表（浅色 + 深色两套）解析 CSS 里用到的每个 var()；
 *   2. 计算「悬停态的背景 vs 文字」的实际对比度；
 *   3. 断言达到 WCAG AA 的 4.5:1。
 *
 * 只有真算对比度，才拦得住「换了个令牌但依然看不见」这类回归。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/**
 * 宿主主题的令牌取值（取自 `@deepseek-ai/dsh-client-ui-theme/lib/client.js` 与
 * `welcome.css` 的真实定义，浅色在前、深色在后）。
 */
const STATIC = {
	'--dsw-static-neutral-bluish-00': '#ffffff',
	'--dsw-static-neutral-bluish-50': '#f9fafb',
	'--dsw-static-neutral-bluish-75': '#f1f3f5',
	'--dsw-static-neutral-bluish-100': '#ebeef2',
	'--dsw-static-neutral-bluish-150': '#e9ecf2',
	'--dsw-static-neutral-bluish-200': '#e1e5ee',
	'--dsw-static-neutral-bluish-400': '#adb2b8',
	'--dsw-static-neutral-bluish-600': '#81858c',
	'--dsw-static-neutral-bluish-750': '#43454a',
	'--dsw-static-neutral-bluish-800': '#353638',
	'--dsw-static-neutral-bluish-850': '#2c2c2e',
	'--dsw-static-neutral-bluish-875': '#232324',
	'--dsw-static-neutral-bluish-950': '#151517',
	'--dsw-static-neutral-bluish-1000': '#0f1115',
	'--dsw-static-blue-500': '#3b82f6',
	'--dsw-static-deepseek-500': '#4176e6',
	'--dsw-static-deepseek-400': '#7aaaff'
}

/**
 * 两套主题下插件的相关令牌。
 *
 * `--dsw-alias-interactive-bg-hover` / `-active` 是**半透明**叠加色，单独解析成
 * 一个颜色是不完整的：它们必须叠在卡片底色之上才是最终观感。因此这里保存
 * `{ color, alpha, over }` 三元组，稍后做 alpha 合成。
 */
const THEMES = {
	light: {
		'--dsw-alias-bg-base': '#ffffff',
		'--dsw-alias-bg-layer-1': STATIC['--dsw-static-neutral-bluish-00'],
		'--dsw-alias-bg-layer-2': STATIC['--dsw-static-neutral-bluish-00'],
		'--dsw-alias-bg-overlay': STATIC['--dsw-static-neutral-bluish-150'],
		'--dsw-alias-border-l1': '#0000000a',
		'--dsw-alias-border-l2': '#0000001a',
		'--dsw-alias-border-l3': '#0000001f',
		'--dsw-alias-brand-primary': STATIC['--dsw-static-neutral-bluish-1000'],
		'--dsw-alias-button-primary-fill': STATIC['--dsw-static-neutral-bluish-1000'],
		'--dsw-alias-button-primary-hover': STATIC['--dsw-static-neutral-bluish-750'],
		'--dsw-alias-label-primary': STATIC['--dsw-static-neutral-bluish-1000'],
		'--dsw-alias-label-secondary': '#61666b',
		'--dsw-alias-label-tertiary': STATIC['--dsw-static-neutral-bluish-600'],
		'--dsw-alias-label-primary-foreground': STATIC['--dsw-static-neutral-bluish-00'],
		'--dsw-alias-state-error-primary': '#ec1313',
		'--dsw-alias-state-success-primary': '#22c55e',
		'--dsw-alias-state-warn-primary': '#f59e0b',
		'--dsw-alias-state-idle-primary': '#d4d4d4',
		'--dsw-alias-state-business-primary': STATIC['--dsw-static-deepseek-500'],
		'--dsw-alias-link': STATIC['--dsw-static-deepseek-500'],
		'--dsw-alias-interactive-bg-hover': { color: '#263148', alpha: 0.06 },
		'--dsw-alias-interactive-bg-active': { color: '#263148', alpha: 0.1 },
		'--dsw-radius-xs': '4px',
		'--dsw-radius-sm': '8px',
		'--dsw-radius-md': '12px',
		'--dsw-radius-lg': '16px',
		'--dsw-shadow-lv1': '0 2px 4px 0 #0000000d',
		'--dsw-focus-ring-width': '2px'
	},
	dark: {
		'--dsw-alias-bg-base': STATIC['--dsw-static-neutral-bluish-950'],
		'--dsw-alias-bg-layer-1': STATIC['--dsw-static-neutral-bluish-875'],
		'--dsw-alias-bg-layer-2': STATIC['--dsw-static-neutral-bluish-850'],
		'--dsw-alias-bg-overlay': STATIC['--dsw-static-neutral-bluish-600'],
		'--dsw-alias-border-l1': '#ffffff0f',
		'--dsw-alias-border-l2': '#ffffff1f',
		'--dsw-alias-border-l3': '#ffffff29',
		'--dsw-alias-brand-primary': STATIC['--dsw-static-neutral-bluish-50'],
		'--dsw-alias-button-primary-fill': STATIC['--dsw-static-neutral-bluish-50'],
		'--dsw-alias-button-primary-hover': STATIC['--dsw-static-neutral-bluish-100'],
		'--dsw-alias-label-primary': STATIC['--dsw-static-neutral-bluish-50'],
		'--dsw-alias-label-secondary': '#cfd3d6',
		'--dsw-alias-label-tertiary': STATIC['--dsw-static-neutral-bluish-400'],
		'--dsw-alias-label-primary-foreground': STATIC['--dsw-static-neutral-bluish-1000'],
		'--dsw-alias-state-error-primary': '#f25a5a',
		'--dsw-alias-state-success-primary': '#22c55e',
		'--dsw-alias-state-warn-primary': '#f59e0b',
		'--dsw-alias-state-idle-primary': '#545557',
		'--dsw-alias-state-business-primary': STATIC['--dsw-static-deepseek-400'],
		'--dsw-alias-link': STATIC['--dsw-static-deepseek-400'],
		'--dsw-alias-interactive-bg-hover': { color: '#ffffff', alpha: 0.08 },
		'--dsw-alias-interactive-bg-active': { color: '#ffffff', alpha: 0.14 },
		'--dsw-radius-xs': '4px',
		'--dsw-radius-sm': '8px',
		'--dsw-radius-md': '12px',
		'--dsw-radius-lg': '16px',
		'--dsw-shadow-lv1': '0 2px 4px 0 #0000000d',
		'--dsw-focus-ring-width': '2px'
	}
}

/** 读取客户端源码里的 CSS 常量。 */
function cssSource() {
	const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
	const match = source.match(/const CSS = `([\s\S]*?)`\n/)
	assert.ok(match !== null, '在 client.js 里找不到 CSS 常量')
	// 先剥掉注释：分节注释若紧贴规则，会被下面的选择器解析并进去，导致精确匹配失败。
	return match[1].replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 解析一个 CSS 声明块里的属性。
 * @param {string} block - CSS 声明文本。
 * @returns {Record<string, string>} 属性映射。
 */
function declarations(block) {
	const out = {}
	for (const part of block.split(';')) {
		const index = part.indexOf(':')
		if (index < 0) continue
		out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
	}
	return out
}

/**
 * 抽出某个选择器的声明块。
 * @param {string} css - 完整 CSS。
 * @param {string} selector - 精确选择器文本。
 * @returns {Record<string, string>|undefined} 属性映射。
 */
function ruleOf(css, selector) {
	for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if (match[1].trim() === selector) return declarations(match[2])
	}
	return undefined
}

/** 解析 #rgb / #rrggbb / #rrggbbaa 为 [r,g,b,a]。 */
function parseHex(value) {
	const hex = value.slice(1)
	const expand = (s) => Number.parseInt(s.length === 1 ? s + s : s, 16)
	if (hex.length === 3 || hex.length === 4) {
		return [expand(hex[0]), expand(hex[1]), expand(hex[2]), hex.length === 4 ? expand(hex[3]) / 255 : 1]
	}
	if (hex.length === 6 || hex.length === 8) {
		return [
			expand(hex.slice(0, 2)),
			expand(hex.slice(2, 4)),
			expand(hex.slice(4, 6)),
			hex.length === 8 ? expand(hex.slice(6, 8)) / 255 : 1
		]
	}
	throw new Error(`无法解析颜色：${value}`)
}

/**
 * 把一个 CSS 颜色值解析成 RGBA。
 * @param {string} value - 颜色字面量。
 * @param {Record<string, unknown>} theme - 当前主题令牌表。
 * @param {string} over - `over` 关键字要用的底色（十六进制）。
 * @returns {number[]} [r,g,b,a]。
 */
function resolveColor(value, theme, over) {
	const token = value.match(/^var\((--[\w-]+)\)$/)
	if (token !== null) {
		const found = theme[token[1]]
		assert.ok(found !== undefined, `主题里没有定义 ${token[1]}`)
		if (typeof found === 'string') return parseHex(found)
		// 半透明叠加色：合成到给定底色上，返回不透明结果。
		const base = parseHex(found.color)
		return composite([...base.slice(0, 3), found.alpha], over)
	}
	if (value === 'transparent') return [0, 0, 0, 0]
	return parseHex(value)
}

/**
 * 把半透明颜色合成到底色上，返回不透明 RGB。
 * @param {number[]} top - 上层 [r,g,b,a]。
 * @param {string} bottomHex - 底色。
 * @returns {number[]} 合成后的 [r,g,b,1]。
 */
function composite(top, bottomHex) {
	const bottom = parseHex(bottomHex)
	const a = top[3]
	return [
		Math.round(top[0] * a + bottom[0] * (1 - a)),
		Math.round(top[1] * a + bottom[1] * (1 - a)),
		Math.round(top[2] * a + bottom[2] * (1 - a)),
		1
	]
}

/** 相对亮度（WCAG 2.1）。 */
function luminance([r, g, b]) {
	const channel = (v) => {
		const s = v / 255
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
	}
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** 对比度（WCAG 2.1）。 */
function contrast(a, b) {
	const la = luminance(a)
	const lb = luminance(b)
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('按钮悬停态可读性（真实令牌对比度计算）', () => {
	for (const [themeName, theme] of Object.entries(THEMES)) {
		/** 该主题下的卡片底色：按钮实际所在的表面。 */
		const surface = theme['--dsw-alias-bg-layer-1']

		it(`[${themeName}] 普通按钮悬停：文字仍清晰可读`, () => {
			const css = cssSource()
			const hover = ruleOf(css, '.wsp-btn:not(:disabled):hover')
			assert.ok(hover !== undefined, '缺少 .wsp-btn:hover 规则')
			const background = resolveColor(hover.background, theme, surface)
			const text = resolveColor(ruleOf(css, '.wsp-btn').color, theme, surface)
			const ratio = contrast(background, text)
			assert.ok(ratio >= 4.5, `对比度只有 ${ratio.toFixed(2)}:1，文字会看不清（需要 ≥ 4.5:1）`)
		})

		it(`[${themeName}] 主按钮悬停：文字仍清晰可读`, () => {
			const css = cssSource()
			const hover = ruleOf(css, '.wsp-btn.wsp-btn-primary:not(:disabled):hover')
			assert.ok(hover !== undefined, '缺少主按钮悬停规则')
			// 主按钮是不透明填充，直接以自身背景为底。
			const fill = hover.background
			const background = resolveColor(fill, theme, surface)
			const text = resolveColor(hover.color, theme, surface)
			const ratio = contrast(background, text)
			assert.ok(ratio >= 4.5, `主按钮悬停对比度只有 ${ratio.toFixed(2)}:1（需要 ≥ 4.5:1）`)
		})

		it(`[${themeName}] 主按钮悬停必须同时声明背景与文字颜色`, () => {
			const css = cssSource()
			const hover = ruleOf(css, '.wsp-btn.wsp-btn-primary:not(:disabled):hover')
			assert.ok(hover !== undefined)
			// 只改背景不改文字，正是当初白底白字的成因。
			assert.ok(hover.background !== undefined, '主按钮悬停必须声明 background')
			assert.ok(hover.color !== undefined, '主按钮悬停必须同时声明 color')
		})

		it(`[${themeName}] 静止态主按钮对比度达标`, () => {
			const css = cssSource()
			const base = ruleOf(css, '.wsp-btn.wsp-btn-primary')
			const background = resolveColor(base.background, theme, surface)
			const text = resolveColor(base.color, theme, surface)
			assert.ok(contrast(background, text) >= 4.5, '主按钮静止态对比度不足')
		})

		it(`[${themeName}] 「获取 API Key」链接沿用官方链接令牌且可读`, () => {
			const css = cssSource()
			const link = ruleOf(css, '.wsp-link')
			assert.ok(link !== undefined, '缺少 .wsp-link 规则')
			// 必须是官方链接令牌：与全应用其它链接保持一致，且不必自己维护浅/深两套色值。
			assert.equal(link.color, 'var(--dsw-alias-link)', '链接色应直接使用官方 --dsw-alias-link')

			const color = resolveColor(link.color, theme, surface)
			const ratio = contrast(color, resolveColor(surface, theme, surface))
			/*
			 * 下限 4.2 而不是 4.5：宿主自己的 `--dsw-alias-link` 在当前取值下
			 * 浅色约 4.23:1、深色约 4.7:1，本就不满足 WCAG AA 正文阈值。
			 *
			 * 沿用官方令牌的理由：
			 *   1. 视觉一致性——全应用链接都是这个颜色，单独调深会显得突兀；
			 *   2. 链接自带虚线点状下划线，不依赖颜色独立可辨，弱化了对比度需求；
			 *   3. 令牌要求同时提供浅/深两套值，自选色意味着两套都得自己维护。
			 *
			 * 4.2 这个下限仍能拦住真正的回归（例如又滑回 1.0:1 的白底白字）。
			 */
			assert.ok(ratio >= 4.2, `链接对比度只有 ${ratio.toFixed(2)}:1，已低到无法辨认`)
		})

		it(`[${themeName}] 眼睛按钮用次要文字色且悬停可辨`, () => {
			const css = cssSource()
			const eye = ruleOf(css, '.wsp-eye')
			assert.ok(eye !== undefined, '缺少 .wsp-eye 规则')
			assert.match(eye.color, /--dsw-alias-label-secondary/, '眼睛图标应使用次要文字色，避免过于抢眼')
			const hover = ruleOf(css, '.wsp-eye:not(:disabled):hover')
			assert.ok(hover !== undefined, '眼睛按钮缺少悬停态')
			assert.match(hover.background, /--dsw-alias-interactive-bg-hover/, '悬停必须用交互令牌，不能是实心表面色')
		})
	}
})

describe('样式约定', () => {
	it('悬停用交互专用半透明令牌，而不是实心表面令牌', () => {
		const css = cssSource()
		const hover = ruleOf(css, '.wsp-btn:not(:disabled):hover')
		assert.equal(
			hover.background,
			'var(--dsw-alias-interactive-bg-hover)',
			'普通按钮悬停必须使用 --dsw-alias-interactive-bg-hover（半透明叠加），'
			+ '用 --dsw-alias-bg-layer-2 会在浅色下变成纯白实心块'
		)
	})

	it('主按钮悬停规则优先级高于通用规则', () => {
		const css = cssSource()
		// 通用 `.wsp-btn:not(:disabled):hover` 与 `.wsp-btn-primary:not(:disabled):hover`
		// 的优先级相同（都是 0,3,0），只靠书写顺序决定胜负，太脆弱。
		// 必须写成 `.wsp-btn.wsp-btn-primary:not(:disabled):hover` 把权重提到 0,4,0。
		const primaryHover = ruleOf(css, '.wsp-btn.wsp-btn-primary:not(:disabled):hover')
		assert.ok(primaryHover !== undefined, '主按钮悬停规则必须带双类名以提高优先级')
		assert.equal(ruleOf(css, '.wsp-btn-primary:not(:disabled):hover'), undefined, '不应保留低优先级的旧规则')
	})

	it('页面里用到的每个主题令牌都真实存在', () => {
		const css = cssSource()
		const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))
		const known = new Set([...Object.keys(THEMES.light), ...Object.keys(STATIC)])
		// 这些是宿主公开令牌表里确认存在的（Theme Inspect 提供）。
		const publicTokens = new Set([
			'--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
			'--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
			'--dsw-alias-label-primary', '--dsw-alias-label-secondary',
			'--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
			'--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
			'--dsw-specific-sidebar-fill'
		])
		// `--wsp-*` 是本插件自有的设计刻度变量，不是主题令牌，由下一条测试单独校验。
		const missing = [...used].filter((token) => !token.startsWith('--wsp-') && !known.has(token) && !publicTokens.has(token))
		assert.deepEqual(missing, [], `页面引用了未验证的主题令牌：${missing.join('、')}`)
	})

	it('插件自有变量都先定义后使用（没有悬空引用）', () => {
		const css = cssSource()
		const used = new Set([...css.matchAll(/var\((--wsp-[\w-]+)/g)].map((m) => m[1]))
		const defined = new Set([...css.matchAll(/(--wsp-[\w-]+)\s*:/g)].map((m) => m[1]))
		const dangling = [...used].filter((token) => !defined.has(token))
		assert.deepEqual(dangling, [], `这些插件变量没有定义：${dangling.join('、')}`)
		assert.ok(defined.size > 0, '应当定义了插件自有变量')
	})
})

describe('设计刻度一致性', () => {
	it('字号只来自统一的三级刻度，没有各写各的 px', () => {
		const css = cssSource()
		const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((m) => m[1].trim())
		assert.ok(sizes.length > 0, '没找到任何 font-size')
		const offenders = sizes.filter((value) => !/^var\(--wsp-fs-(title|body|meta)\)$/.test(value))
		assert.deepEqual(offenders, [], `这些 font-size 没走统一刻度：${offenders.join('、')}`)
	})

	it('控件高度统一走同一个变量', () => {
		const css = cssSource()
		for (const selector of ['.wsp-btn', '.wsp-input', '.wsp-check']) {
			const rule = ruleOf(css, selector)
			assert.ok(rule !== undefined, `缺少 ${selector} 规则`)
			assert.equal(rule.height, 'var(--wsp-control-h)', `${selector} 的高度应走 --wsp-control-h`)
		}
	})

	it('密钥槽位与卡片操作行共用同一套水平缩进', () => {
		const css = cssSource()
		const page = ruleOf(css, '.wsp-page') ?? {}
		// 缩进 = 嵌套盒的内边距 + 描边，改一处即可同时影响槽位与操作行。
		assert.match(String(page['--wsp-inset'] ?? ''), /--wsp-box-pad/, '--wsp-inset 应基于 --wsp-box-pad')
		assert.match(String(page['--wsp-inset'] ?? ''), /--wsp-box-border/, '--wsp-inset 应基于 --wsp-box-border')
		assert.equal(ruleOf(css, '.wsp-box')?.padding, 'var(--wsp-box-pad)', '嵌套盒应统一使用 --wsp-box-pad')
		assert.equal(ruleOf(css, '.wsp-actions')?.padding, '0 var(--wsp-inset)', '操作行应使用 --wsp-inset 与盒内容对齐')
	})

	it('嵌套盒外观只在 .wsp-box 定义一次（变体不得各写一份）', () => {
		const css = cssSource()
		const box = ruleOf(css, '.wsp-box')
		assert.ok(box !== undefined, '缺少共享的 .wsp-box 规则')
		assert.match(String(box.border), /var\(--wsp-box-border\)/, '.wsp-box 应使用 --wsp-box-border')
		assert.match(String(box['border-radius']), /--dsw-radius-md/, '.wsp-box 应使用同一档圆角')
		assert.match(String(box.background), /--dsw-alias-bg-layer-2/, '.wsp-box 应使用同一档底色')

		// 变体只负责布局，不再重复盒子外观——重复正是「选项卡漂移成裸表单」的成因。
		for (const selector of ['.wsp-node', '.wsp-key']) {
			const rule = ruleOf(css, selector) ?? {}
			for (const property of ['border', 'border-radius', 'background']) {
				assert.equal(rule[property], undefined, `${selector} 不应重复声明 ${property}，应当复用 .wsp-box`)
			}
		}
	})
})
