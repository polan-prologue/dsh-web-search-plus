/**
 * dsh-web-search-plus —— 宿主管理路由族（`/api/dsh-web-search-plus`）。
 *
 * 浏览器半侧的插件页只跟这一组 JSON 端点对话，因此页面状态只有一处真源：宿主。
 * 三条硬性约束贯穿本模块：
 *
 * 1. **密钥明文只进不出**：写入走凭据域（`ctx.credentials.set`），读回一律只报告
 *    「是否已配置 / 来源 / 可否写入」（`credentials.describe`），任何响应体里都不含明文。
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

	/** 当前生效的 seam 搜索提供方 id（`web.searchProviderId` 是运行时真源）。 */
	function currentSeamProvider() {
		const configured = ctx.web?.searchProviderId
		return typeof configured === 'string' && configured.length > 0 ? configured : undefined
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
	 * 这里必须重述完整配置——profile patch **不做深度合并**，只写 `searchProvider`
	 * 会丢掉 `fetchProvider`，所以以继承层为基底再覆盖目标字段。
	 *
	 * 撤销时**写入官方默认提供方 id，而不是删除该字段**。原因是 seam 的选取规则：
	 * 只有「显式指定了 searchProvider」或「注册表里恰好只有一个可用提供方」时才不歧义。
	 * 本插件始终把自己注册进注册表，所以一旦删掉字段，注册表里就同时存在
	 * 官方与本插件两个可用提供方，而没有任何显式选择 —— 宿主随即抛
	 * `WEB_PROVIDER_AMBIGUOUS`，**联网搜索彻底不可用**。
	 * 写回显式 id 既恢复了「用官方搜索」的原意，又避免了这场静默事故。
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
	return async function handle(req, res) {
		if (!isLoopback(req)) {
			json(res, { ok: false, error: '该管理接口只接受本机请求。' }, 403)
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
		const method = req.method ?? 'GET'

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
					const report = await chain.searchWithReport({ query, maxResults }, controller.signal)
					json(res, {
						ok: true,
						query,
						route: report.route,
						attempts: report.attempts,
						sourceCount: report.result.sources.length,
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
