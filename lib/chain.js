/**
 * dsh-web-search-plus —— 优先级链式搜索提供方。
 *
 * ## 为什么需要这一层
 *
 * `ctx.web` 的提供方选择语义是「按 id 固定一个」：配置了 id 就只用它，没有配置时
 * 若存在多个可用提供方则直接以 `WEB_PROVIDER_AMBIGUOUS` 失败。seam 里**没有**优先级
 * 或回退链，而本插件要提供的恰恰是「先用 Tavily，失败了再用 DeepSeek 原生」。
 *
 * 因此本模块把自己注册成 seam 上**唯一**被选中的提供方（id `web-search-plus`），
 * 由它在内部按用户配置的顺序依次调用真正的提供方：
 *
 * - `tavily` 节点 → 本插件的 `TavilySearchProvider`（内部再对多个密钥轮换）；
 * - `deepseek-official` 节点 → 复用 seam 注册表里官方 DeepSeek 提供方的实例。
 *
 * 复用官方实例（而不是自己再实现一份 DeepSeek 调用）保证了三件事：密钥、账号令牌、
 * 接口地址、搜索次数上限等全部沿用官方「网页搜索」设置页的配置；失败消息与错误码与
 * 直连时完全一致；上游改动无需本插件跟进。
 *
 * ## 失败语义
 *
 * - 单个节点失败 → 记录原因，继续下一个节点；
 * - 节点**未注册**（例如官方行被禁用）→ 记为「未注册」，继续下一个节点；
 * - 调用方取消 → 立刻穿透，**不**回退（回退只针对提供方自身的失败）；
 * - 全部节点失败 → 抛 `WEB_SEARCH_CHAIN_EXHAUSTED`，消息逐条列出每个节点的原因。
 *
 * @module dsh-web-search-plus/chain
 */

import {
	CODES,
	isAbortError,
	throwIfAborted,
	webError
} from './errors.js'
import {
	PROVIDER_DEEPSEEK,
	PROVIDER_LABELS,
	PROVIDER_TAVILY
} from './config.js'

/** 本插件注册到 `ctx.web` 的提供方 id —— 它才是 seam 实际选中的那一个。 */
export const CHAIN_PROVIDER_ID = 'web-search-plus'

/**
 * 链式搜索提供方：`ctx.web` 的 `WebSearchProvider` 实现。
 */
export class ChainSearchProvider {
	/**
	 * @param {object} options - 依赖。
	 * @param {() => Record<string, unknown>} options.getConfig - 读取当前归一化配置。
	 * @param {import('./tavily.js').TavilySearchProvider} options.tavily - Tavily 节点。
	 * @param {() => { search: (request: object, signal?: AbortSignal) => Promise<object>, available: () => boolean } | undefined} options.getDeepSeek - 取官方 DeepSeek 提供方实例。
	 * @param {(event: string, payload: object) => void} [options.record] - 观测回调（不含任何密钥内容）。
	 */
	constructor(options) {
		this.getConfig = options.getConfig
		this.tavily = options.tavily
		this.getDeepSeek = options.getDeepSeek
		this.record = options.record ?? (() => {})
	}

	/** @returns {string} 注册进 seam 的 id。 */
	get id() {
		return CHAIN_PROVIDER_ID
	}

	/**
	 * seam 的可用性检查：链上至少有一个节点可用即算可用。
	 *
	 * 这里必须是**同步且廉价**的（seam 约定：可用性检查不发起网络调用）。
	 * 它只回答「这个提供方能否被选中」，不回答「这次搜索会不会命中」——真正的
	 * 选择在 `search()` 内按顺序发生。
	 *
	 * @returns {boolean} 是否可用。
	 */
	available() {
		const config = this.getConfig()
		for (const node of config.priority) {
			if (node === PROVIDER_TAVILY) {
				// 只要配置了任意一个密钥槽位就认为 Tavily 节点「可能可用」；
				// 密钥是否真的有值由 search() 读取凭据域判定（那是异步的）。
				if (Array.isArray(config.tavilyKeyRefs) && config.tavilyKeyRefs.length > 0) return true
				continue
			}
			if (node === PROVIDER_DEEPSEEK) {
				// 官方提供方的 `available()` 是一次廉价的同步检查（本地判断有无密钥），
				// 正是 seam 允许在可用性检查里做的事，因此直接沿用它而不是只看实例是否存在。
				const provider = this.getDeepSeek()
				if (provider !== undefined && provider.available()) return true
			}
		}
		return false
	}

	/**
	 * 按优先级执行一次搜索。
	 *
	 * @param {{ query: string, maxResults?: number }} request - seam 的搜索请求。
	 * @param {AbortSignal} [signal] - 调用方取消信号。
	 * @returns {Promise<{ content?: string, sources: readonly object[], truncated: boolean }>} 第一个成功节点的结果。
	 * @throws {Error} 全部节点失败时抛 `WEB_SEARCH_CHAIN_EXHAUSTED`。
	 */
	async search(request, signal) {
		return (await this.searchWithReport(request, signal)).result
	}

	/**
	 * 与 `search()` 同一条路径，但额外报告「实际命中了哪个节点」以及途中每次尝试。
	 *
	 * 设置页的「试一次」按钮用它把选择过程如实展示给用户——没有这一步，用户只能看到
	 * 「搜索成功了」，无从判断究竟是 Tavily 还是 DeepSeek 出的结果。
	 *
	 * @param {{ query: string, maxResults?: number }} request - 搜索请求。
	 * @param {AbortSignal} [signal] - 取消信号。
	 * @returns {Promise<{ result: object, route: string | undefined, attempts: Array<{ node: string, label: string, ok: boolean, elapsedMs: number, reason?: string }> }>} 结果与路由报告。
	 * @throws {Error} 全部节点失败时抛 `WEB_SEARCH_CHAIN_EXHAUSTED`。
	 */
	async searchWithReport(request, signal) {
		const config = this.getConfig()
		const failures = []
		/** @type {Array<{ node: string, label: string, ok: boolean, elapsedMs: number, reason?: string }>} */
		const attempts = []

		for (const node of config.priority) {
			throwIfAborted(signal)
			const label = PROVIDER_LABELS[node] ?? node
			const started = Date.now()
			try {
				const result = await this.runNode(node, request, signal)
				if (this.isEmptyResult(result) && config.fallbackOnEmpty === true) {
					const reason = '没有返回任何结果'
					failures.push(`${label}：${reason}`)
					attempts.push({ node, label, ok: false, elapsedMs: Date.now() - started, reason })
					this.record('web/search-plus-fallback', {
						from: node,
						reason: 'empty-result',
						elapsedMs: Date.now() - started
					})
					continue
				}
				attempts.push({ node, label, ok: true, elapsedMs: Date.now() - started })
				this.record('web/search-plus-route', {
					provider: node,
					elapsedMs: Date.now() - started,
					sourceCount: Array.isArray(result?.sources) ? result.sources.length : 0,
					warnings: failures.length
				})
				return { result, route: node, attempts }
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw error
				const reason = String(error?.message ?? error)
				failures.push(`${label}：${reason}`)
				attempts.push({ node, label, ok: false, elapsedMs: Date.now() - started, reason })
				this.record('web/search-plus-fallback', {
					from: node,
					reason: typeof error?.code === 'string' ? error.code : 'ERROR',
					elapsedMs: Date.now() - started
				})
			}
		}

		throw webError(
			`联网搜索失败：优先级链上的 ${String(attempts.length)} 个提供方都没有成功。\n`
			+ failures.map((line) => `- ${line}`).join('\n'),
			CODES.CHAIN_EXHAUSTED
		)
	}

	/**
	 * 执行链上某一个节点。
	 * @param {string} node - 节点 id。
	 * @param {{ query: string, maxResults?: number }} request - 搜索请求。
	 * @param {AbortSignal} [signal] - 取消信号。
	 * @returns {Promise<object>} 该节点的结果。
	 */
	async runNode(node, request, signal) {
		if (node === PROVIDER_TAVILY) return await this.tavily.search(request, signal)
		if (node === PROVIDER_DEEPSEEK) {
			const provider = this.getDeepSeek()
			if (provider === undefined) {
				throw webError(
					'DeepSeek 原生搜索提供方（deepseek-official）未注册：它的 Loader 行可能被禁用了。',
					CODES.DEEPSEEK_NOT_REGISTERED
				)
			}
			if (!provider.available()) {
				throw webError(
					'DeepSeek 原生搜索当前不可用：通常是没有可用的 API Key，也没有使用 DeepSeek 账号模型登录。'
					+ '可在「设置 → 插件 → 网页搜索」里配置，或改用账号模型对话。',
					CODES.DEEPSEEK_NOT_REGISTERED
				)
			}
			return await provider.search(request, signal)
		}
		throw webError(`未知的搜索提供方节点「${node}」。`, CODES.NO_USABLE_NODE)
	}

	/**
	 * 判断一个结果是否「空」（没有任何来源也没有摘要内容）。
	 * @param {object} result - 提供方结果。
	 * @returns {boolean} 是否为空结果。
	 */
	isEmptyResult(result) {
		if (result === null || typeof result !== 'object') return true
		const sources = Array.isArray(result.sources) ? result.sources : []
		const content = typeof result.content === 'string' ? result.content : ''
		return sources.length === 0 && content.length === 0
	}

	/**
	 * 探测当前优先级链会命中哪个节点，以及如果首选节点失败会退到哪个节点。
	 *
	 * 这是只读的**能力探测**，用来让设置页如实展示「当前会不会真的走 Tavily」，
	 * 不发起任何搜索请求。
	 *
	 * @returns {{ chain: Array<{ node: string, label: string, available: boolean, detail: string }> }} 链路状态。
	 */
	describe() {
		const config = this.getConfig()
		const chain = config.priority.map((node) => {
			if (node === PROVIDER_TAVILY) {
				const refs = Array.isArray(config.tavilyKeyRefs) ? config.tavilyKeyRefs : []
				return {
					node,
					label: PROVIDER_LABELS[node],
					available: refs.length > 0,
					detail: refs.length > 0
						? `${String(refs.length)} 个密钥槽位（${refs.join('、')}），密钥未配置时会自动尝试下一个`
						: '没有配置任何密钥槽位'
				}
			}
			const provider = this.getDeepSeek()
			if (provider === undefined) {
				return { node, label: PROVIDER_LABELS[node] ?? node, available: false, detail: '提供方未注册（Loader 行可能被禁用）' }
			}
			const ok = provider.available()
			return {
				node,
				label: PROVIDER_LABELS[node] ?? node,
				available: ok,
				detail: ok ? '已注册且可用' : '已注册但当前不可用（缺少 API Key 或未使用账号模型）'
			}
		})
		return { chain }
	}
}
