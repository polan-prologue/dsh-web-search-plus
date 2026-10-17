/**
 * dsh-web-search-plus —— 宿主管理路由族（`/api/dsh-web-search-plus`）。
 *
 * 浏览器半侧的插件页只跟这一组 JSON 端点对话，因此页面状态只有一处真源：宿主。
 * 三条硬性约束贯穿本模块：
 *
 * 1. **密钥明文只进不出，唯一例外是用户主动点「显示密钥」**：写入走凭据域
 *    （`ctx.credentials.set`）；快照（`GET /`）一律只报告「是否已配置 / 来源 /
 *    可否写入」，任何响应体里都不含明文。要看到已保存密钥的字面值，只能调用
 *    单独的 `POST keys/value/reveal`——它要求回环地址、禁用缓存、每次只回一个引用名，
 *    且不做任何自动调用（页面不会在加载时偷偷拉取）。
 * 2. **只服务本机**：管理端点拒绝非回环地址，避免局域网内其他主机改写搜索配置。
 * 3. **配置写入走官方持久化路径**：优先 `settings.mutate`（带修订号冲突检测），
 *    不可用时回退 `configEditor.edit`；两者都会落到 profile patch 层并由 Loader 协调。
 *
 * @module dsh-web-search-plus/routes
 */

import { isCredentialRefName, keyRefForSlot } from './config.js'
import { CHAIN_PROVIDER_ID } from './chain.js'

/** 本插件的路由前缀。 */
export const ROUTE_PREFIX = '/api/dsh-web-search-plus'

/** 请求体大小上限：配置项都是小对象，密钥也就几十字节。 */
const MAX_BODY_BYTES = 64 * 1024

/** profile 里 `web` 行的条目 id。 */
const WEB_ENTRY_ID = 'web'

/** 官方 DeepSeek 搜索提供方的 id。 */
const DEEPSEEK_PROVIDER_ID = 'deepseek-official'

/** 本插件路由族里已知的子路径与各自允许的方法。 */
const ROUTES = {
	'': ['GET'],
	priority: ['PUT'],
	options: ['PUT'],
	keys: ['POST', 'DELETE'],
	'keys/value': ['POST', 'DELETE'],
	'keys/value/reveal': ['POST'],
	'keys/reset': ['POST'],
	'keys/usage': ['POST'],
	takeover: ['POST'],
	probe: ['POST']
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应对象。
 * @param {unknown} payload - 响应体。
 * @param {number} [status] - HTTP 状态码。
 */
function json(res, payload, status = 200) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
	res.end(JSON.stringify(payload))
}

/**
 * 读一个有界的请求体并解析成 JSON。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @returns {Promise<Record<string, unknown>>} 解析后的对象（空体视为 `{}`）。
 */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let total = 0
		req.on('data', (chunk) => {
			total += chunk.length
			if (total > MAX_BODY_BYTES) {
				reject(new Error(`请求体超过 ${String(MAX_BODY_BYTES)} 字节`))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8').trim()
			if (text.length === 0) {
				resolve({})
				return
			}
			try {
				const parsed = JSON.parse(text)
				resolve(typeof parsed === 'object' && parsed !== null ? parsed : {})
			} catch (error) {
				reject(new Error(`请求体不是合法 JSON：${String(error?.message ?? error)}`))
			}
		})
		req.on('error', reject)
	})
}

/**
 * 判断请求是否来自本机回环地址。
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @returns {boolean} 是否允许。
 */
function isLoopback(req) {
	const address = req.socket?.remoteAddress ?? ''
	return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 读一个可能抛错或尚不可用的 webServer 属性。
 *
 * `webServer.origin` 在监听器尚未绑定端口时会抛错，`host` 在某些版本上也可能缺席。
 * 来源校验**绝不能因为读部署信息而抛穿**——那会把一次正常请求变成 500。
 * 读不到就当作「没有该信息」，退化为只认回环，而不是放宽。
 *
 * @param {() => unknown} read - 读取函数。
 * @returns {string | undefined} 字符串值或 undefined。
 */
function safeRead(read) {
	try {
		const value = read()
		return typeof value === 'string' && value.length > 0 ? value : undefined
	} catch {
		return undefined
	}
}

/**
 * 读一个可能抛错或尚不可用的字符串数组（如 `connection.trustedHosts`）。
 *
 * 与 `safeRead` 同理：**读不到就当作没有**，绝不让一次读取失败把正常请求
 * 变成 500。返回空数组时来源校验会跳过该判据，而不是放宽成「谁都放行」。
 *
 * @param {() => unknown} read - 读取函数。
 * @returns {readonly string[]} 字符串数组，读不到时为空数组。
 */
function safeReadList(read) {
	try {
		const value = read()
		if (!Array.isArray(value)) return []
		return value.filter((item) => typeof item === 'string' && item.length > 0)
	} catch {
		return []
	}
}

/** 回环地址（可带端口）。 */
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?$/iu

/**
 * 请求来源校验：挡掉「浏览器里另一个页面」冒充本页来调管理接口。
 *
 * ## 为什么必须有这一层（实测出来的，不是理论风险）
 *
 * 插件路由挂在 `webServer` 的前缀路由上，**不经过宿主的浏览器会话鉴权**
 * （宿主 `/api/settings/*` 无 cookie 返回 401；本插件路由无 cookie 返回 200）。
 * 于是 `isLoopback()` 只能证明「请求来自本机进程」，挡不住**用户浏览器里任意
 * 一个恶意页面**——它可以 `fetch('http://127.0.0.1:<port>/api/...')`。
 *
 * 加这层之前，实测三条路径全部成立：
 * - 伪造 `Host: evil.example.com` → 200（DNS rebinding 的典型手法）；
 * - 任意 `Origin` → 200；
 * - 跨站 `text/plain` POST（**属于简单请求，浏览器不预检**）→ 200 且能读到响应体，
 *   明文密钥被页面脚本直接取走。
 *
 * ## 判据必须**对齐宿主自己的部署**，而不是写死 127.0.0.1
 *
 * 第一版把 Host 写死成回环地址，结果把「DSH 部署在服务器、经公网 IP 访问」这种
 * 正常用法全挡了（报障：服务器上安装成功，打开插件页「读取失败：只接受 Host 为
 * 本机回环地址的请求（收到『192.144.175.20:10443』）」）。
 *
 * 第二版加了「绑定地址 + origin」两条，但**仍然漏了最关键的 `trustedHosts`**：
 * 服务器部署通常是「webserver 绑 127.0.0.1 + 反向代理对外」，此时浏览器发来的
 * Host 是公网域名/地址，既不等于绑定地址也不等于 origin，照样 403。
 *
 * 现在与宿主 `isTrustedApiRequest()` **逐条对齐**，四个判据：
 *
 * 1. **回环地址**——本机直连；
 * 2. **`webServer.host`**（监听器的绑定地址字面量）——直接暴露该 IP 时浏览器带的就是它；
 * 3. **`connection.trustedHosts`**（宿主 `--trusted-host` 声明的 authority）——
 *    反向代理 / 域名部署的正解。带端口的条目精确匹配 `host:port`，不带端口的匹配任意端口；
 * 4. **`webServer.origin` 的 authority**——兜底，与部署自报的对外地址一致。
 *
 * 前三项与宿主完全一致；第四项是本插件额外的兜底（宿主没有这条，但它只认自己
 * 报出来的 origin，不扩大攻击面）。读不到某项就跳过该项，绝不放宽成「谁都放行」。
 *
 * 其余判据同样与宿主一致：带了 `Origin` 必须同源、`sec-fetch-site` 不得是
 * `cross-site`、写操作必须是 JSON。这些才是真正挡跨站读写的部分。
 *
 * 任一条不满足即 403，且**不回显任何配置或密钥信息**。
 *
 * @param {import('node:http').IncomingMessage} req - 请求对象。
 * @param {string} method - HTTP 方法。
 * @param {{ binding?: string, origin?: string, trustedHosts?: readonly string[] }} [deployment] - 本机部署信息。
 * @returns {string | undefined} 拒绝原因；允许时为 `undefined`。
 */
function rejectUnsafeOrigin(req, method, deployment = {}) {
	const host = String(req.headers?.host ?? '')
	const hostname = host.replace(/:\d+$/u, '').toLowerCase()
	const binding = typeof deployment.binding === 'string' ? deployment.binding.toLowerCase() : ''
	/**
	 * Host 是否与某个 `trustedHosts` 条目匹配。
	 *
	 * 与宿主 `isTrustedAuthority()` 同语义：带端口的条目**精确匹配** `host:port`，
	 * 不带端口的条目匹配该主机名的**任意端口**。
	 *
	 * @param {readonly string[]} entries - 声明的 authority 列表。
	 * @returns {boolean} 是否命中。
	 */
	const matchesTrusted = (entries) => {
		for (const entry of entries) {
			if (typeof entry !== 'string' || entry.length === 0) continue
			let parsed
			try {
				parsed = new URL(`http://${entry}`)
			} catch {
				continue
			}
			const entryHost = parsed.hostname.toLowerCase()
			if (parsed.port.length > 0) {
				// 条目带端口 → 必须连同端口一起相等。
				if (`${entryHost}:${parsed.port}` === host.toLowerCase()) return true
			} else if (entryHost === hostname) {
				// 条目不带端口 → 只比主机名，任意端口都算。
				return true
			}
		}
		return false
	}
	/** Host 是否属于「我们自己」：回环、绑定地址、声明的 trustedHosts，或部署 origin。 */
	const isOwnHost = (() => {
		if (LOOPBACK_HOST.test(host)) return true
		if (binding.length > 0 && hostname === binding) return true
		const trusted = Array.isArray(deployment.trustedHosts) ? deployment.trustedHosts : []
		if (trusted.length > 0 && matchesTrusted(trusted)) return true
		if (typeof deployment.origin === 'string' && deployment.origin.length > 0) {
			try {
				return new URL(deployment.origin).host.toLowerCase() === host.toLowerCase()
			} catch {
				return false
			}
		}
		return false
	})()
	if (!isOwnHost) {
		return `拒绝来源不明的 Host「${host || '(空)'}」：只接受回环地址、本部署的绑定地址，或宿主的 --trusted-host 中声明的地址。`
	}
	/*
	 * 纵深防御：浏览器主动标记的跨站请求一律拒绝。
	 *
	 * 正常同源页面调用带 `sec-fetch-site: same-origin`；跨站页面发起的是
	 * `cross-site`；`curl`、脚本、Node 客户端**根本不会带这个头**。
	 *
	 * 这条不依赖任何配置——即使上面那条 Host 判据被放宽（远程访问、反代域名），
	 * 它仍然拦得住跨站请求。宿主 `isTrustedApiRequest` 同样有这一条。
	 */
	if (String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
		return '跨站请求被拒绝（sec-fetch-site: cross-site）。'
	}
	/*
	 * 带了 Origin 就必须与 Host **同源**。
	 *
	 * 比较的是 authority（host:port），并且**按 scheme + authority 归一化**：
	 * 服务器部署常用 https + 非默认端口，而 Host 头里不带 scheme，
	 * 因此只比较去掉 scheme 后的 authority，允许 http/https 都成立。
	 * 这仍然挡得住「跨源读取」——攻击者页面的 Origin 是它自己的域名，永远对不上。
	 */
	const origin = req.headers?.origin
	if (origin !== undefined) {
		let originAuthority
		try {
			const parsed = new URL(String(origin))
			originAuthority = parsed.host.toLowerCase()
		} catch {
			return `跨源请求被拒绝（Origin「${String(origin)}」不是合法来源）。`
		}
		if (originAuthority !== host.toLowerCase()) {
			return `跨源请求被拒绝（Origin「${String(origin)}」与 Host「${host}」不同源）。`
		}
	}
	// GET 不读请求体，不限制类型；其余（写操作）一律要求 JSON。
	if (method !== 'GET') {
		const type = String(req.headers?.['content-type'] ?? '').toLowerCase()
		if (!type.startsWith('application/json')) {
			return '写操作必须使用 application/json；其它类型属于 CORS 简单请求，会被任意网页利用。'
		}
	}
	return undefined
}

/**
 * 构建路由处理器。
 *
 * @param {object} deps - 依赖（全部由 `index.js` 注入，便于单测替换）。
 * @param {object} deps.ctx - 插件上下文。
 * @param {() => { config: Record<string, unknown>, warnings: string[] }} deps.readState - 读取归一化配置与告警。
 * @param {import('./tavily.js').TavilySearchProvider} deps.tavily - Tavily 节点。
 * @param {import('./tavily.js').KeyRing} deps.keyRing - 密钥轮换状态机。
 * @param {import('./chain.js').ChainSearchProvider} deps.chain - 链式提供方。
 * @param {() => string} deps.version - 插件版本。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} 处理器。
 */
export function createRouter(deps) {
	const { ctx, readState, tavily, keyRing, chain, version } = deps

	/**
	 * 当前的 seam 搜索提供方配置值。
	 *
	 * ## 真源是 `ctx.web.config.searchProvider` 的 volatile 访问器
	 *
	 * `@deepseek-ai/dsh-web` 的 `WebRuntime` 只有这样一个取配置的入口：
	 *
	 * ```js
	 * const configuredId = this.config.searchProvider.get() ?? this.searchProviderEnv;
	 * ```
	 *
	 * 也就是说：**配置值来自 `config.searchProvider.get()`，环境变量
	 * `$DSH_WEB_SEARCH_PROVIDER` 与它等价、是同一字段的覆盖而不是另一条链**；
	 * `WebRuntime` 上**没有** `searchProviderId` 这个属性。
	 *
	 * 早先这里读的正是 `ctx.web.searchProviderId`，于是永远是 `undefined`：
	 * 即使 profile 里已经写了 `searchProvider: web-search-plus`、联网搜索实际跑在
	 * 本插件的链上，快照仍然报 `active: false` + 「配置有歧义」——界面上就是
	 * 「已接管」与「配置提醒：没指定用哪个」自相矛盾。用户截图报障的正是这一处。
	 *
	 * 取值顺序与宿主完全一致：先 volatile 访问器，再环境变量。访问器在不同版本上
	 * 可能是函数、也可能是已经取好值的字段，两种都认；任何形状异常都按「未知」
	 * 返回 `undefined`，绝不让探测本身抛穿路由。
	 *
	 * @returns {string | undefined} 配置的提供方 id，未配置时为 `undefined`。
	 */
	function configuredSeamProvider() {
		const web = ctx.web
		const field = web?.config?.searchProvider
		let value
		try {
			// 0.1.x 起是 volatile 访问器（函数）；更老的/被换过的实现可能直接给值。
			value = typeof field?.get === 'function' ? field.get() : field
			if (typeof value !== 'string' || value.length === 0) {
				const fromEnv = typeof process === 'object' ? process.env?.DSH_WEB_SEARCH_PROVIDER : undefined
				value = typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined
			}
		} catch {
			return undefined
		}
		return typeof value === 'string' && value.length > 0 ? value : undefined
	}

	/** 当前生效的 seam 搜索提供方 id（与宿主同一真源，见 `configuredSeamProvider`）。 */
	function currentSeamProvider() {
		return configuredSeamProvider()
	}

	/**
	 * 取官方 DeepSeek 提供方实例——用于在链上复用它的配置与错误语义。
	 * @returns {object | undefined} 提供方实例。
	 */
	function deepSeekProvider() {
		const registry = ctx.web?.searchProviders
		if (!(registry instanceof Map)) return undefined
		return registry.get(DEEPSEEK_PROVIDER_ID)
	}

	/**
	 * 读取每个密钥槽位的凭据状态——只报告配置状态，绝不返回明文。
	 * @param {readonly string[]} refs - 密钥引用名顺序。
	 * @returns {Promise<Record<string, { configured: boolean, source?: string, writable: boolean }>>} 状态映射。
	 */
	async function describeKeys(refs) {
		const credentials = ctx.get('credentials')
		const described = {}
		for (const ref of refs) {
			if (credentials === undefined) {
				const fromEnv = process.env[ref]
				described[ref] = {
					configured: typeof fromEnv === 'string' && fromEnv.length > 0,
					...(typeof fromEnv === 'string' && fromEnv.length > 0 ? { source: 'env' } : {}),
					writable: false
				}
				continue
			}
			try {
				const info = await credentials.describe(ref)
				described[ref] = {
					configured: info.configured === true,
					...(info.source === undefined ? {} : { source: info.source }),
					writable: info.writable !== false
				}
			} catch (error) {
				described[ref] = { configured: false, writable: false, error: String(error?.message ?? error) }
			}
		}
		return described
	}

	/**
	 * 组装完整快照——插件页唯一的读取入口。
	 * @returns {Promise<object>} 快照。
	 */
	async function snapshot() {
		const { config, warnings } = readState()
		const refs = Array.isArray(config.tavilyKeyRefs) ? config.tavilyKeyRefs : []
		keyRing.sync(refs)
		const credentials = await describeKeys(refs)
		const seamProvider = currentSeamProvider()
		const editor = ctx.get('configEditor')
		const registered = ctx.web?.searchProviders instanceof Map ? [...ctx.web.searchProviders.keys()] : []
		/*
		 * 歧义检测：seam 只有在「显式指定了提供方」或「注册表里恰好一个可用提供方」时
		 * 才不歧义。本插件注册后若又没有显式选择，宿主会抛 WEB_PROVIDER_AMBIGUOUS，
		 * 表现为**联网搜索整体不可用**——这种状态必须在界面上说清楚，不能让它静默。
		 */
		const ambiguous = seamProvider === undefined && registered.length > 1
		const noted = ambiguous
			? [...warnings, `检测到 ${registered.length} 个搜索提供方（${registered.join('、')}）但没有指定用哪个，联网搜索会直接失败。点「立即接管」或手工在 profile 的 cordis.patch.yml 里为 web 行指定 searchProvider。`]
			: warnings
		return {
			ok: true,
			version: version(),
			config,
			warnings: noted,
			chain: chain.describe().chain,
			keys: keyRing.snapshot().map((slot) => ({
				...slot,
				...(credentials[slot.ref] ?? { configured: false, writable: false })
			})),
			takeover: {
				active: seamProvider === CHAIN_PROVIDER_ID,
				seamProvider,
				registered,
				ambiguous,
				canRepair: editor !== undefined,
				deepSeekRegistered: deepSeekProvider() !== undefined,
				message: ambiguous
					? '配置有歧义：注册了多个搜索提供方却没指定用哪个，联网搜索当前不可用。'
					: seamProvider === CHAIN_PROVIDER_ID
						? '已接管：联网搜索按下面的优先级依次尝试。'
						: `尚未接管：当前 seam 固定使用「${seamProvider ?? '自动选择'}」，本插件的优先级不会生效。`
			}
		}
	}

	/**
	 * 持久化本插件配置。
	 *
	 * 优先走 `settings.mutate`（只允许 volatile 字段，带修订号冲突检测）；没有该服务时
	 * 回退到 `configEditor.edit`，直接改写 profile patch 层里的本插件行。
	 *
	 * @param {Record<string, unknown>} patch - 要设置的字段（扁平键）。
	 * @param {string[]} [unsets] - 要恢复默认的字段。
	 * @param {number} [expectedRevision] - 客户端读到的修订号，用于拒绝过期写入。
	 * @returns {Promise<string>} 实际使用的持久化通道。
	 */
	async function persist(patch, unsets = [], expectedRevision) {
		const settings = ctx.get('settings')
		// 不只看服务在不在，还要看方法在不在：不同 DSH 版本的 settings 面可能不同，
		// 直接调用不存在的方法会抛 TypeError，把「能降级」变成「直接失败」。
		if (typeof settings?.mutate === 'function') {
			const ops = [
				...Object.entries(patch).map(([key, value]) => ({ op: 'set', path: [key], value })),
				...unsets.map((key) => ({ op: 'unset', path: [key] }))
			]
			if (ops.length > 0) await settings.mutate('web-search-plus', ops, expectedRevision)
			return 'settings'
		}
		const editor = ctx.get('configEditor')
		if (typeof editor?.edit !== 'function' || typeof editor?.entries !== 'function') {
			throw new Error('本部署既没有可用的 settings 也没有 configEditor 服务，无法保存插件配置。')
		}
		const entry = editor.entries().find((row) => row.options.id === 'web-search-plus')
		if (entry === undefined) {
			throw new Error('profile 里找不到「web-search-plus」条目，无法保存配置。请确认插件已作为组合包启用。')
		}
		await editor.edit(entry, (current, inherited) => {
			const next = { ...inherited, ...current }
			for (const [key, value] of Object.entries(patch)) next[key] = value
			for (const key of unsets) delete next[key]
			return next
		})
		return 'configEditor'
	}

	/**
	 * 接管或撤销接管：改写 profile 里 `web` 行的 `searchProvider`。
	 *
	 * ## 为什么必须重述完整配置
	 *
	 * profile patch **不做深度合并**：只写 `searchProvider` 会把 `fetchProvider` 一起
	 * 丢掉。所以以继承层为基底再覆盖目标字段——这也是本函数用
	 * `{ ...inherited, ...current, searchProvider: resolved }` 的原因。
	 *
	 * ## 交还时写的是「官方默认 id」，但**行本身会被宿主删掉**
	 *
	 * 这里显式写入 `deepseek-official` 而不是删字段，语义上要求「结果必须是官方提供方」。
	 * 不过 `configEditor.edit()` 有一条去重规则：当算出的 `next` 与继承层 `inherited`
	 * **深度相等**时，它会把该行的 `config` 删掉，行内只剩 id/name 时连行一起删。
	 *
	 * 因此默认状态下（`searchProvider` 与 `fetchProvider` 都等于基础层默认值）交还之后，
	 * `web` 行会从 profile patch 里消失——**这是宿主的设计，不是本插件丢配置**：
	 * 生效值仍由基础层提供 `deepseek-official` + `http`，与显式写死完全等价。
	 *
	 * 反过来，一旦用户改过 `web` 行的任何字段（例如换过 `fetchProvider`），
	 * `next` 就不再等于 `inherited`，行会被保留并完整写回，自定义字段不会丢。
	 * 换句话说：宿主只固定「你真正改过的东西」，没改过的跟随上游默认值——上游将来
	 * 调整默认 `fetchProvider` 时，这类用户会自动跟上。
	 *
	 * ⚠️ 不要试图「显式写死以保住这一行」：写死 `deepseek-official` 得到的 `next`
	 * 依然等于 `inherited`，照样被去重删除，只是让代码看起来像固定了而已。
	 *
	 * ## 为什么不能干脆删掉 searchProvider 字段
	 *
	 * seam 的选取规则是「显式指定了提供方」或「注册表里恰好只有一个可用提供方」。
	 * 本插件始终把自己注册进注册表，若只是把字段抹空而**不**保证回落到官方值，
	 * 注册表里就同时存在官方与本插件两个可用提供方且没有显式选择，宿主随即抛
	 * `WEB_PROVIDER_AMBIGUOUS`，**联网搜索彻底不可用**。写入 `deepseek-official`
	 * 让「结果确定是官方」成为本函数的硬约束，而不是依赖去重规则的副作用。
	 *
	 * @param {string | null} target - 目标提供方 id；`null` 表示交还官方默认提供方。
	 * @returns {Promise<{ applied: string, seamProvider: string | undefined }>} 应用结果。
	 */
	async function takeOver(target) {
		const editor = ctx.get('configEditor')
		if (editor === undefined) {
			throw new Error('本部署没有 configEditor 服务，无法自动改写联网搜索提供方。请手工编辑 profile 的 cordis.patch.yml。')
		}
		const entry = editor.entries().find((row) => row.options.id === WEB_ENTRY_ID)
		if (entry === undefined) {
			throw new Error('profile 里找不到「web」条目，无法改写搜索提供方。')
		}
		const resolved = target === null ? DEEPSEEK_PROVIDER_ID : target
		await editor.edit(entry, (current, inherited) => ({ ...inherited, ...current, searchProvider: resolved }))
		return { applied: resolved, seamProvider: currentSeamProvider() }
	}

	/**
	 * 用给定引用名写入一个密钥值。
	 * @param {string} ref - 凭据引用名。
	 * @param {string} value - 密钥明文（只在本函数栈与凭据域写入路径上存在）。
	 * @returns {Promise<object>} 该引用名写入后的状态。
	 */
	async function writeKey(ref, value) {
		if (!isCredentialRefName(ref)) {
			throw new Error(`「${ref}」不是合法的凭据引用名：需要形如 TAVILY_API_KEY 的环境变量名。`)
		}
		if (typeof value !== 'string' || value.trim().length === 0) {
			throw new Error('密钥不能为空。')
		}
		const credentials = ctx.get('credentials')
		if (credentials === undefined) {
			throw new Error('本部署没有凭据服务，无法安全保存密钥。')
		}
		await credentials.set(ref, value.trim())
		const info = await credentials.describe(ref)
		return { configured: info.configured === true, source: info.source, writable: info.writable !== false }
	}

	/**
	 * 清除一个密钥值。
	 * @param {string} ref - 凭据引用名。
	 * @returns {Promise<void>} 完成。
	 */
	async function clearKey(ref) {
		if (!isCredentialRefName(ref)) throw new Error(`「${ref}」不是合法的凭据引用名。`)
		const credentials = ctx.get('credentials')
		if (credentials === undefined) return
		await credentials.unset(ref)
	}

	/**
	 * 把「管理动作」里允许写入的配置字段挑出来并做类型校正。
	 * @param {Record<string, unknown>} body - 请求体。
	 * @returns {{ patch: Record<string, unknown>, unsets: string[] }} 待写入的字段与待恢复的字段。
	 */
	function optionPatch(body) {
		const patch = {}
		const unsets = []
		const options = typeof body.options === 'object' && body.options !== null ? body.options : body
		const numeric = {
			tavilyMaxResults: [1, 20],
			tavilyTimeoutMs: [1000, 600000],
			tavilyRateLimitCooldownMs: [0, 86400000],
			tavilyQuotaCooldownMs: [0, 604800000]
		}
		for (const [key, range] of Object.entries(numeric)) {
			if (!Object.hasOwn(options, key)) continue
			const raw = options[key]
			if (raw === null || raw === '' || raw === undefined) {
				unsets.push(key)
				continue
			}
			const value = Number(raw)
			if (!Number.isFinite(value)) throw new Error(`「${key}」需要是数字。`)
			patch[key] = Math.min(Math.max(Math.trunc(value), range[0]), range[1])
		}
		if (Object.hasOwn(options, 'tavilyBaseURL')) {
			const raw = options.tavilyBaseURL
			if (raw === null || (typeof raw === 'string' && raw.trim().length === 0)) unsets.push('tavilyBaseURL')
			else if (typeof raw === 'string') patch.tavilyBaseURL = raw.trim().replace(/\/+$/u, '')
			else throw new Error('「tavilyBaseURL」需要是字符串。')
		}
		if (Object.hasOwn(options, 'tavilySearchDepth')) {
			const raw = options.tavilySearchDepth
			if (raw === null) unsets.push('tavilySearchDepth')
			else patch.tavilySearchDepth = String(raw)
		}
		for (const key of ['tavilyIncludeAnswer', 'fallbackOnEmpty']) {
			if (!Object.hasOwn(options, key)) continue
			const raw = options[key]
			if (raw === null) unsets.push(key)
			else patch[key] = Boolean(raw)
		}
		return { patch, unsets }
	}

	/**
	 * 路由分派。
	 * @param {import('node:http').IncomingMessage} req - 请求。
	 * @param {import('node:http').ServerResponse} res - 响应。
	 * @returns {Promise<void>} 完成。
	 */
	return async function handle(req, res, deploymentOverride) {
		if (!isLoopback(req)) {
			json(res, { ok: false, error: '该管理接口只接受本机请求。' }, 403)
			return
		}
		const method = req.method ?? 'GET'
		/*
		 * 来源校验必须在这里、在解析任何请求体之前完成。
		 *
		 * 把部署信息传进去：`webServer.host` 是监听器的绑定地址字面量，
		 * `webServer.origin` 是外部访问用的 origin。服务器部署（DSH 跑在远端、
		 * 浏览器经公网 IP / 域名访问）就靠这两个值认出「自己人」——
		 * 只认 127.0.0.1 会把这种正常用法全挡掉。
		 * 两者都取不到时退化为「只认回环」，不会因此放宽。
		 */
		const rejected = rejectUnsafeOrigin(req, method, deploymentOverride ?? {
			binding: safeRead(() => ctx.webServer?.host),
			origin: safeRead(() => ctx.webServer?.origin),
			/*
			 * `trustedHosts` 的真源在 `connection` 服务上（宿主 `--trusted-host` 声明的
			 * authority 列表，见 `HostConnectionService.trustedHosts`）。
			 * 反代 / 域名部署的 Host 只能靠它认出来——只看绑定地址和 origin 会漏，
			 * 那正是 0.1.4 在某些服务器上仍然报「拒绝来源不明的 Host」的原因。
			 */
			trustedHosts: safeReadList(() => ctx.get('connection')?.trustedHosts)
		})
		if (rejected !== undefined) {
			json(res, { ok: false, error: rejected }, 403)
			return
		}
		const raw = (req.url ?? '').split('?')[0]
		const sub = raw === ROUTE_PREFIX
			? ''
			: raw.startsWith(`${ROUTE_PREFIX}/`) ? raw.slice(ROUTE_PREFIX.length + 1) : null
		if (sub === null) {
			json(res, { ok: false, error: `未知路径：${raw}` }, 404)
			return
		}

		// 路径与方法的区分要如实：未知子路径是 404，已知子路径上不支持的方法才是 405。
		// 混为一谈会让调用方把「我拼错了 URL」误读成「这个端点不支持该动作」。
		const allowed = Object.hasOwn(ROUTES, sub) ? ROUTES[sub] : undefined
		if (allowed === undefined) {
			json(res, { ok: false, error: `未知路径：${raw}` }, 404)
			return
		}
		if (!allowed.includes(method)) {
			json(res, { ok: false, error: `路径 ${raw} 只接受 ${allowed.join('、')}。` }, 405)
			return
		}

		try {
			if (sub === '' && method === 'GET') {
				json(res, await snapshot())
				return
			}

			if (sub === 'priority' && method === 'PUT') {
				const body = await readJsonBody(req)
				if (!Array.isArray(body.priority)) throw new Error('缺少 priority 列表。')
				const priority = body.priority.filter((node) => typeof node === 'string')
				await persist({ priority }, [], typeof body.revision === 'number' ? body.revision : undefined)
				json(res, await snapshot())
				return
			}

			if (sub === 'options' && method === 'PUT') {
				const body = await readJsonBody(req)
				const { patch, unsets } = optionPatch(body)
				if (Object.keys(patch).length === 0 && unsets.length === 0) throw new Error('没有需要保存的选项。')
				await persist(patch, unsets, typeof body.revision === 'number' ? body.revision : undefined)
				json(res, await snapshot())
				return
			}

			if (sub === 'keys' && method === 'POST') {
				const body = await readJsonBody(req)
				const { config } = readState()
				const refs = [...config.tavilyKeyRefs]
				const requested = typeof body.ref === 'string' && body.ref.trim().length > 0 ? body.ref.trim() : undefined
				const ref = requested ?? keyRefForSlot(refs.length)
				if (!isCredentialRefName(ref)) {
					throw new Error(`「${ref}」不是合法的凭据引用名：需要形如 TAVILY_API_KEY 的环境变量名。`)
				}
				if (!refs.includes(ref)) refs.push(ref)
				await persist({ tavilyKeyRefs: refs })
				json(res, await snapshot())
				return
			}

			if (sub === 'keys' && method === 'DELETE') {
				const body = await readJsonBody(req)
				const ref = typeof body.ref === 'string' ? body.ref : ''
				const { config } = readState()
				const refs = config.tavilyKeyRefs.filter((item) => item !== ref)
				if (refs.length === 0) refs.push('TAVILY_API_KEY')
				const notes = []
				try {
					await clearKey(ref)
				} catch (error) {
					notes.push(`槽位已移除，但已存密钥未能清除（${String(error?.message ?? error)}）。`)
				}
				await persist({ tavilyKeyRefs: refs })
				keyRing.reset(ref)
				const next = await snapshot()
				json(res, notes.length === 0 ? next : { ...next, warnings: [...next.warnings, ...notes] })
				return
			}

			if (sub === 'keys/value' && method === 'POST') {
				const body = await readJsonBody(req)
				const ref = typeof body.ref === 'string' ? body.ref.trim() : ''
				const value = typeof body.value === 'string' ? body.value : ''
				const state = await writeKey(ref, value)
				const { config } = readState()
				if (!config.tavilyKeyRefs.includes(ref)) {
					await persist({ tavilyKeyRefs: [...config.tavilyKeyRefs, ref] })
				}
				keyRing.reset(ref)
				json(res, { ok: true, ref, ...state, snapshot: await snapshot() })
				return
			}

			if (sub === 'keys/value' && method === 'DELETE') {
				const body = await readJsonBody(req)
				const ref = typeof body.ref === 'string' ? body.ref : ''
				await clearKey(ref)
				keyRing.reset(ref)
				json(res, await snapshot())
				return
			}

			if (sub === 'keys/value/reveal' && method === 'POST') {
				/*
				 * 读取**已保存**密钥的明文，供页面上的「小眼睛」使用。
				 *
				 * 为什么要有这个端点：凭据域的 `describe()` 只回答「已配置/可写」，
				 * 从不回传字面值；官方 `SettingsSecretField` 也一样。于是用户把密钥存进去
				 * 之后就再也核对不了自己到底存了哪一把——报障「保存过的密钥没法点小眼睛显示」
				 * 正是这个缺口。
				 *
				 * 安全边界（每一条都必要，改动前先想清楚）：
				 * - 只接受回环地址（由 `handle()` 统一拦截，非本机直接 403）；
				 * - 只回应**配置里真实存在**的槽位引用名，不接受任意字符串探测；
				 * - 每次只回一个引用名，不提供「全部解密」；
				 * - 响应带 `cache-control: no-store`，避免明文进任何缓存；
				 * - 不做任何自动调用：只有用户点小眼睛时才发这一次请求。
				 */
				const body = await readJsonBody(req)
				const ref = typeof body.ref === 'string' ? body.ref.trim() : ''
				if (!isCredentialRefName(ref)) {
					json(res, { ok: false, error: `「${ref}」不是合法的凭据引用名。` }, 400)
					return
				}
				const { config } = readState()
				const refs = Array.isArray(config.tavilyKeyRefs) ? config.tavilyKeyRefs : []
				if (!refs.includes(ref)) {
					json(res, { ok: false, error: `「${ref}」不在当前密钥槽位里。` }, 404)
					return
				}
				const credentials = ctx.get('credentials')
				let value
				if (credentials !== undefined) {
					const resolved = await credentials.resolve(ref)
					value = typeof resolved?.value === 'string' ? resolved.value : undefined
				} else {
					// 没有凭据服务时与 resolveKey() 一致：退回环境变量。
					const fromEnv = process.env[ref]
					value = typeof fromEnv === 'string' ? fromEnv : undefined
				}
				if (typeof value !== 'string' || value.length === 0) {
					json(res, { ok: false, error: `「${ref}」尚未配置密钥。` }, 404)
					return
				}
				res.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store, no-cache, must-revalidate',
					pragma: 'no-cache'
				})
				res.end(JSON.stringify({ ok: true, ref, value }))
				return
			}

			if (sub === 'keys/reset' && method === 'POST') {
				const body = await readJsonBody(req)
				keyRing.reset(typeof body.ref === 'string' && body.ref.length > 0 ? body.ref : undefined)
				json(res, await snapshot())
				return
			}

			if (sub === 'keys/usage' && method === 'POST') {
				const { config } = readState()
				const usage = await tavily.usage(config.tavilyKeyRefs)
				json(res, { ok: true, usage })
				return
			}

			if (sub === 'takeover' && method === 'POST') {
				const body = await readJsonBody(req)
				const target = body.target === undefined
					? CHAIN_PROVIDER_ID
					: body.target === null || body.target === 'default' ? null : String(body.target)
				const applied = await takeOver(target)
				json(res, { ok: true, ...applied, snapshot: await snapshot() })
				return
			}

			if (sub === 'probe' && method === 'POST') {
				const body = await readJsonBody(req)
				const query = typeof body.query === 'string' && body.query.trim().length > 0
					? body.query.trim()
					: 'DeepSeek Harness DSH'
				const maxResults = typeof body.maxResults === 'number' ? body.maxResults : 5
				const controller = new AbortController()
				const timer = setTimeout(() => controller.abort(new Error('探测超时')), 60000)
				try {
					/*
					 * 「试一次搜索」必须反映**当前真实生效的那条链路**，而不是无条件走本插件。
					 *
					 * 真实报障：点了「交还官方搜索」之后，seam 已经指回 deepseek-official，
					 * 但这里仍然执行本插件的优先级链，于是探测结果照样显示「Tavily 命中」——
					 * 用户看到的是「已交还官方，却还在按插件优先级判定」，自相矛盾。
					 *
					 * 判据与 `snapshot()` 的 `takeover.active` 完全同源（同一个
					 * `currentSeamProvider()`），因此界面上的「已接管 / 尚未接管」与探测
					 * 实际走的路径不可能再对不上。
					 */
					const seamProvider = currentSeamProvider()
					const takenOver = seamProvider === CHAIN_PROVIDER_ID
					if (!takenOver) {
						/*
						 * 未接管：如实走 seam 当前选中的那个提供方。
						 *
						 * 只代跑**官方 DeepSeek**。其它情况（例如 seam 被手工指到
						 * `deepseek-search-api`、或根本没指定）不能用官方兜底冒充——
						 * 那会把「实际没跑这个提供方」显示成「跑通了」，比不显示更糟。
						 */
						const provider = seamProvider ?? '自动选择'
						if (seamProvider !== DEEPSEEK_PROVIDER_ID) {
							throw new Error(
								`当前 seam 使用「${provider}」，本插件只能代跑官方 DeepSeek 探测。`
								+ '要按优先级链试搜，请先点「立即接管」。'
							)
						}
						const official = deepSeekProvider()
						if (official === undefined) {
							throw new Error(`当前 seam 使用「${provider}」，但该提供方不在注册表里，无法代跑探测。`)
						}
						const started = Date.now()
						const result = await official.search({ query, maxResults }, controller.signal)
						const elapsedMs = Date.now() - started
						/*
						 * 官方提供方**不保证**遵守 `maxResults`：实测请求 5 条时返回了 10 条
						 * （seam 的 `capSources()` 只在 `ctx.web.search()` 那一层裁剪，
						 * 直接调用 provider 不会经过它）。这里自己裁一次，否则界面上的
						 * 「N 条来源」会比请求的条数还大，看起来像插件算错了。
						 */
						const found = Array.isArray(result?.sources) ? result.sources : []
						const capped = found.slice(0, maxResults)
						json(res, {
							ok: true,
							query,
							// `route: undefined` + `takenOver: false`：这次没有走优先级链。
							route: undefined,
							takenOver: false,
							seamProvider,
							attempts: [{
								node: 'deepseek-official',
								label: 'DeepSeek 原生搜索',
								ok: true,
								elapsedMs,
								reason: `当前 seam 固定使用「${provider}」，未走本插件的优先级链`
							}],
							sourceCount: capped.length,
							hasContent: typeof result?.content === 'string' && result.content.length > 0,
							sources: capped.slice(0, 5)
						})
						return
					}
					const report = await chain.searchWithReport({ query, maxResults }, controller.signal)
					json(res, {
						ok: true,
						query,
						route: report.route,
						takenOver: true,
						seamProvider,
						attempts: report.attempts,
						sourceCount: report.result.sources.slice(0, maxResults).length,
						hasContent: typeof report.result.content === 'string' && report.result.content.length > 0,
						sources: report.result.sources.slice(0, 5)
					})
				} finally {
					clearTimeout(timer)
				}
				return
			}

			// 已知路径与允许的方法都已在进入分派前校验，因此走到这里说明分派表与实现
			// 不同步——这是本插件自身的缺陷，如实报 500 而不是伪装成调用方的错。
			json(res, { ok: false, error: `内部错误：路径 ${raw} 已声明但未实现。` }, 500)
		} catch (error) {
			// 失败信息回给页面；错误里不含密钥内容（凭据层抛出的错误只带引用名）。
			json(res, { ok: false, error: String(error?.message ?? error) }, 400)
		}
	}
}
