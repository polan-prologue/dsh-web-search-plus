/**
 * dsh-web-search-plus —— Tavily 搜索提供方（含多密钥轮换）。
 *
 * 设计要点（全部针对「同一接口、多个密钥」这一目标）：
 *
 * - **粘滞密钥**：上一次成功的密钥优先复用，搜索行为因此在密钥之间保持稳定；
 *   只有它失败时才轮到下一个。
 * - **错误分类决定动作**，而不是笼统地「失败就换」：
 *   - `401` / `403`（密钥无效）→ 本次运行内标记 `invalid`，不再重试该密钥；
 *   - `429`（限流）/ `432` / `433`（额度或套餐上限）→ 进入 `cooldown`，到期自动恢复，
 *     这正是「免费版每天有额度上限，配多个密钥轮换」所针对的场景；
 *   - `400`（该密钥不接受此次请求，如查询过短）→ **换下一个密钥**：换个密钥确实可能成功；
 *   - `422`（请求体不符合接口 schema）→ **不轮换**：换密钥不会让非法请求变合法；
 *   - `5xx` / 网络错误 / 超时 → 视为该密钥的临时故障，换下一个继续；
 *   - 调用方取消 → 立即穿透，绝不换密钥。
 * - **每次操作重新解析密钥**，不做跨操作的缓存——凭据域约定「每次操作解析一次」，
 *   这样在设置页里写入的新密钥无需重启即可被下一次搜索用上。
 *
 * @module dsh-web-search-plus/tavily
 */

import {
	CODES,
	isAbortError,
	throwIfAborted,
	webError
} from './errors.js'

/** 密钥槽位状态：可用。 */
export const KEY_READY = 'ready'
/** 密钥槽位状态：被判定无效（401/403），本次运行内跳过。 */
export const KEY_INVALID = 'invalid'
/** 密钥槽位状态：冷却中（限流或额度耗尽），到期自动恢复。 */
export const KEY_COOLDOWN = 'cooldown'
/** 密钥槽位状态：未配置值。 */
export const KEY_MISSING = 'missing'

/** 冷却原因：限流。 */
export const COOLDOWN_RATE_LIMIT = 'rate-limit'
/** 冷却原因：额度/套餐上限。 */
export const COOLDOWN_QUOTA = 'quota'

/**
 * 一个密钥槽位在运行时的状态。
 * 只保存引用名与状态，**绝不保存密钥明文**——明文只在单次请求的局部变量里存在。
 */
export class KeyRing {
	/**
	 * @param {object} [options] - 构造选项。
	 * @param {() => number} [options.now] - 时钟，便于测试注入。
	 */
	constructor(options = {}) {
		this.now = options.now ?? (() => Date.now())
		/** @type {Map<string, { ref: string, state: string, cooldownUntil: number, cooldownReason: string | undefined, reason: string | undefined }>} */
		this.slots = new Map()
		/** 上一次成功的密钥引用名，用于粘滞选择。 */
		this.sticky = undefined
	}

	/**
	 * 按给定顺序登记本次要考虑的密钥槽位，并同步当前配置。
	 * 新出现的槽位从 `ready` 开始；被移出配置的槽位被丢弃。
	 * @param {readonly string[]} refs - 配置里的密钥引用名顺序。
	 */
	sync(refs) {
		const next = new Map()
		for (const ref of refs) {
			const existing = this.slots.get(ref)
			next.set(ref, existing ?? {
				ref,
				state: KEY_READY,
				cooldownUntil: 0,
				cooldownReason: undefined,
				reason: undefined
			})
		}
		this.slots = next
		if (this.sticky !== undefined && !next.has(this.sticky)) this.sticky = undefined
	}

	/**
	 * 把一个过期的冷却槽位恢复为可用。惰性求值，因此不需要定时器。
	 * @param {{ state: string, cooldownUntil: number, cooldownReason: string | undefined, reason: string | undefined }} slot - 槽位状态。
	 * @returns {boolean} 本次是否发生了恢复。
	 */
	reviveIfExpired(slot) {
		if (slot.state !== KEY_COOLDOWN) return false
		if (this.now() < slot.cooldownUntil) return false
		slot.state = KEY_READY
		slot.cooldownUntil = 0
		slot.cooldownReason = undefined
		slot.reason = undefined
		return true
	}

	/**
	 * 排出本次尝试的密钥顺序：粘滞密钥优先，其后按配置顺序补齐可用槽位。
	 * @returns {string[]} 引用名顺序（可能为空）。
	 */
	order() {
		const ready = []
		for (const slot of this.slots.values()) {
			this.reviveIfExpired(slot)
			if (slot.state === KEY_READY) ready.push(slot.ref)
		}
		if (this.sticky === undefined) return ready
		const index = ready.indexOf(this.sticky)
		if (index <= 0) return ready
		return [ready[index], ...ready.slice(0, index), ...ready.slice(index + 1)]
	}

	/**
	 * 记录一次成功：该密钥成为粘滞选择，状态恢复可用。
	 * @param {string} ref - 成功的密钥引用名。
	 */
	markSuccess(ref) {
		const slot = this.slots.get(ref)
		if (slot !== undefined) {
			slot.state = KEY_READY
			slot.cooldownUntil = 0
			slot.cooldownReason = undefined
			slot.reason = undefined
		}
		this.sticky = ref
	}

	/**
	 * 记录一次失败，按分类更新槽位状态。
	 * @param {string} ref - 失败的密钥引用名。
	 * @param {{ kind: string, message: string, retryAfterMs?: number }} classification - 失败分类。
	 * @param {{ rateLimitCooldownMs: number, quotaCooldownMs: number }} policy - 冷却策略。
	 */
	markFailure(ref, classification, policy) {
		const slot = this.slots.get(ref)
		if (slot === undefined) return
		if (classification.kind === 'invalid-key') {
			slot.state = KEY_INVALID
			slot.reason = classification.message
			if (this.sticky === ref) this.sticky = undefined
			return
		}
		if (classification.kind === 'rate-limited' || classification.kind === 'quota-exhausted') {
			const configured = classification.kind === 'rate-limited' ? policy.rateLimitCooldownMs : policy.quotaCooldownMs
			// 显式配成 0 表示「不自动恢复」：保持冷却，直到用户在设置页手动重置。
			// 这是有意的语义——额度耗尽往往是「今天到此为止」，自动恢复会假装额度回来了。
			const duration = configured === 0
				? Number.POSITIVE_INFINITY
				: classification.retryAfterMs !== undefined && classification.retryAfterMs > configured
					? classification.retryAfterMs
					: configured
			slot.state = KEY_COOLDOWN
			slot.cooldownUntil = Number.isFinite(duration) ? this.now() + duration : Number.POSITIVE_INFINITY
			slot.cooldownReason = classification.kind === 'rate-limited' ? COOLDOWN_RATE_LIMIT : COOLDOWN_QUOTA
			slot.reason = classification.message
			if (this.sticky === ref) this.sticky = undefined
		}
		// 其他分类（临时故障、请求非法）不改变槽位状态。
	}

	/**
	 * 清除所有冷却与无效标记，并把粘滞选择复位。
	 * @param {string} [ref] - 只重置该引用名；省略则重置全部。
	 */
	reset(ref) {
		if (ref !== undefined) {
			const slot = this.slots.get(ref)
			if (slot !== undefined) {
				slot.state = KEY_READY
				slot.cooldownUntil = 0
				slot.cooldownReason = undefined
				slot.reason = undefined
			}
			if (this.sticky === ref) this.sticky = undefined
			return
		}
		for (const slot of this.slots.values()) {
			slot.state = KEY_READY
			slot.cooldownUntil = 0
			slot.cooldownReason = undefined
			slot.reason = undefined
		}
		this.sticky = undefined
	}

	/**
	 * 导出可发送给 UI 的状态快照——只含引用名与状态，不含任何密钥内容。
	 * @returns {Array<{ ref: string, state: string, cooldownUntil: number, cooldownReason?: string, reason?: string, sticky: boolean }>} 状态列表。
	 */
	snapshot() {
		const list = []
		for (const slot of this.slots.values()) {
			this.reviveIfExpired(slot)
			list.push({
				ref: slot.ref,
				state: slot.state,
				cooldownUntil: slot.cooldownUntil,
				...(slot.cooldownReason === undefined ? {} : { cooldownReason: slot.cooldownReason }),
				...(slot.reason === undefined ? {} : { reason: slot.reason }),
				sticky: this.sticky === slot.ref
			})
		}
		return list
	}
}

/**
 * 从 HTTP 状态码与响应正文里解析出 `Retry-After` 提示的毫秒数。
 * @param {Headers | undefined} headers - 响应头。
 * @returns {number | undefined} 毫秒数。
 */
function retryAfterMs(headers) {
	const raw = headers?.get?.('retry-after')
	if (typeof raw !== 'string' || raw.length === 0) return undefined
	const seconds = Number(raw)
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
	const date = Date.parse(raw)
	if (Number.isFinite(date)) return Math.max(0, date - Date.now())
	return undefined
}

/**
 * 从 Tavily 的错误响应里取出人类可读的细节。
 * @param {Response} response - 失败的响应。
 * @returns {Promise<string>} 细节文本（可能为空）。
 */
async function errorDetail(response) {
	try {
		const parsed = await response.json()
		const detail = parsed?.detail
		if (typeof detail === 'string') return detail
		if (typeof detail?.error === 'string') return detail.error
		if (Array.isArray(detail) && typeof detail[0]?.msg === 'string') return detail[0].msg
		if (typeof parsed?.error === 'string') return parsed.error
		if (typeof parsed?.message === 'string') return parsed.message
		return ''
	} catch {
		return ''
	}
}

/**
 * 把一个失败的 HTTP 响应分类。
 *
 * 分类依据的是**真实观测到的 Tavily 行为**，而不是 HTTP 语义的教科书含义：
 *
 * | 状态 | 实测含义 | 动作 |
 * |---|---|---|
 * | 401 / 403 | 该密钥无效 | 标记失效，换下一个密钥 |
 * | 429 | 该密钥触发限流 | 冷却，换下一个密钥 |
 * | 432 / 433 | 该密钥额度或套餐上限用尽 | 冷却，换下一个密钥 |
 * | 400 | 该密钥下这个请求不被接受（例如查询过短） | **换下一个密钥**——换个密钥确实可能成功 |
 * | 422 | 请求体不符合接口 schema | 不轮换：换密钥不会让非法请求变合法 |
 * | 5xx | 上游故障 | 换下一个密钥（临时） |
 *
 * 其中 400 归入轮换这一类是刻意的：实测「无效密钥 + 正常查询」返回 401，而
 * 「有效密钥 + 单字符查询」返回 400，两者都不是 schema 级问题，因此轮换是对的。
 *
 * @param {number} status - HTTP 状态码。
 * @param {string} detail - 响应里的细节文本。
 * @param {Headers | undefined} headers - 响应头（用于 `Retry-After`）。
 * @returns {{ kind: string, message: string, retryAfterMs?: number, status: number }} 分类结果。
 */
export function classifyHttpFailure(status, detail, headers) {
	const suffix = detail.length > 0 ? `：${detail}` : ''
	const message = `Tavily 返回 HTTP ${String(status)}${suffix}`
	const hint = retryAfterMs(headers)
	if (status === 401 || status === 403) return { kind: 'invalid-key', message, status }
	if (status === 429) {
		return hint === undefined
			? { kind: 'rate-limited', message: `${message}（该密钥触发限流，将按冷却时间稍后恢复）`, status }
			: { kind: 'rate-limited', message: `${message}（建议 ${String(Math.round(hint / 1000))} 秒后再用该密钥）`, status, retryAfterMs: hint }
	}
	if (status === 432 || status === 433) {
		return { kind: 'quota-exhausted', message: `${message}（该密钥的额度或套餐上限已用尽）`, status }
	}
	if (status === 422) return { kind: 'request-invalid', message, status }
	if (status === 400) return { kind: 'transient', message: `${message}（该密钥未被接受此次请求，将改用下一个密钥）`, status }
	return { kind: 'transient', message, status }
}

/**
 * 把 Tavily 的响应正文映射成 seam 的 `WebSearchResult`。
 *
 * 字段对应关系：`url` → `url`、`title` → `title`、`content` → `snippet`、
 * `published_date` → `publishedAt`；`answer`（若请求了）→ `content`。
 *
 * @param {unknown} body - 已解析的响应正文。
 * @returns {{ content?: string, sources: Array<{ url: string, title?: string, snippet?: string, publishedAt?: string }>, truncated: boolean }} 规范化结果。
 */
export function mapTavilyResponse(body) {
	const record = typeof body === 'object' && body !== null ? body : {}
	const rawResults = Array.isArray(record.results) ? record.results : []
	const sources = []
	const seen = new Set()
	for (const item of rawResults) {
		if (typeof item !== 'object' || item === null) continue
		const url = typeof item.url === 'string' ? item.url : ''
		if (url.length === 0 || seen.has(url)) continue
		seen.add(url)
		const snippet = typeof item.content === 'string' && item.content.length > 0 ? item.content : undefined
		const published = typeof item.published_date === 'string' && item.published_date.length > 0
			? item.published_date
			: undefined
		sources.push({
			url,
			...(typeof item.title === 'string' && item.title.length > 0 ? { title: item.title } : {}),
			...(snippet === undefined ? {} : { snippet }),
			...(published === undefined ? {} : { publishedAt: published })
		})
	}
	const answer = typeof record.answer === 'string' && record.answer.length > 0 ? record.answer : undefined
	return {
		...(answer === undefined ? {} : { content: answer }),
		sources,
		// 上限由 seam 统一执行，这里不做二次截断。
		truncated: false
	}
}

/**
 * Tavily 搜索提供方。
 *
 * 它自己不是注册进 `ctx.web` 的那个提供方——注册的是 `chain.js` 里的链式提供方；
 * 本类只负责「一次 Tavily 搜索 + 多密钥轮换」，因此可以脱离 DSH 运行时被直接测试。
 */
export class TavilySearchProvider {
	/**
	 * @param {object} options - 依赖与配置来源。
	 * @param {() => Record<string, unknown>} options.getConfig - 读取当前归一化配置。
	 * @param {(ref: string) => Promise<string | undefined>} options.resolveKey - 解析一个密钥引用名。
	 * @param {KeyRing} options.keyRing - 密钥轮换状态机。
	 * @param {typeof fetch} [options.fetchImpl] - 可注入的 fetch（测试用）。
	 * @param {() => number} [options.now] - 可注入的时钟。
	 */
	constructor(options) {
		this.getConfig = options.getConfig
		this.resolveKey = options.resolveKey
		this.keyRing = options.keyRing
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch
		this.now = options.now ?? (() => Date.now())
	}

	/** 提供方 id（用于日志与路由展示；不注册进 seam）。 */
	get id() {
		return 'tavily'
	}

	/**
	 * 是否存在至少一个「已配置」的密钥槽位。
	 *
	 * 这是一项廉价的本地检查（不发起网络调用），seam 的 `available()` 语义正是如此；
	 * 真正的可用性在读秒级的冷却状态里体现，由搜索流程负责。
	 *
	 * @param {Record<string, string | undefined>} resolved - 引用名到密钥的映射（由 `probeAvailability` 预解析）。
	 * @returns {boolean} 是否有密钥。
	 */
	available(resolved) {
		return Object.values(resolved).some((value) => typeof value === 'string' && value.length > 0)
	}

	/**
	 * 预解析所有密钥槽位，返回引用名到密钥的映射。
	 *
	 * 解析失败（凭据域不可用等）按「未配置」处理而不抛出：一个槽位的解析失败
	 * 不应该让整条链失效。
	 *
	 * @param {readonly string[]} refs - 密钥引用名顺序。
	 * @returns {Promise<Record<string, string | undefined>>} 映射。
	 */
	async resolveKeys(refs) {
		const resolved = {}
		for (const ref of refs) {
			try {
				const value = await this.resolveKey(ref)
				resolved[ref] = typeof value === 'string' && value.length > 0 ? value : undefined
			} catch {
				resolved[ref] = undefined
			}
		}
		return resolved
	}

	/**
	 * 执行一次 Tavily 搜索，必要时在密钥之间轮换。
	 *
	 * @param {{ query: string, maxResults?: number }} request - seam 的搜索请求。
	 * @param {AbortSignal} [signal] - 调用方取消信号。
	 * @returns {Promise<{ content?: string, sources: Array<object>, truncated: boolean }>} 规范化结果。
	 * @throws {Error} 全部密钥不可用时抛 `WEB_SEARCH_PLUS_TAVILY_KEYS_EXHAUSTED`。
	 */
	async search(request, signal) {
		const config = this.getConfig()
		const refs = config.tavilyKeyRefs
		this.keyRing.sync(refs)
		throwIfAborted(signal)

		const keys = await this.resolveKeys(refs)
		throwIfAborted(signal)

		const usable = refs.filter((ref) => keys[ref] !== undefined)
		if (usable.length === 0) {
			throw webError(
				`Tavily 搜索没有可用的密钥：${refs.join('、')} 都没有配置值。请在「网页搜索++」设置页填入至少一个 Tavily 密钥。`,
				CODES.TAVILY_CREDENTIAL_MISSING
			)
		}

		const order = this.keyRing.order()
		const attempts = order.length > 0 ? order : []
		const failures = []
		for (const ref of attempts) {
			const apiKey = keys[ref]
			if (apiKey === undefined) continue
			throwIfAborted(signal)
			try {
				const result = await this.searchWithKey(ref, apiKey, config, request, signal)
				this.keyRing.markSuccess(ref)
				return result
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw error
				const classification = error?.webSearchPlusClassification
				if (classification !== undefined) {
					this.keyRing.markFailure(ref, classification, {
						rateLimitCooldownMs: config.tavilyRateLimitCooldownMs,
						quotaCooldownMs: config.tavilyQuotaCooldownMs
					})
					failures.push(`${ref}：${classification.message}`)
					// 请求本身非法：换密钥与换提供方都不会改变结果。
					if (classification.kind === 'request-invalid') throw error
					continue
				}
				failures.push(`${ref}：${String(error?.message ?? error)}`)
			}
		}

		throw webError(
			`Tavily 搜索的所有密钥都不可用（共 ${String(refs.length)} 个槽位）：\n${failures.map((line) => `- ${line}`).join('\n')}`,
			CODES.TAVILY_KEYS_EXHAUSTED
		)
	}

	/**
	 * 用指定密钥发起一次 Tavily 搜索。
	 * @param {string} ref - 密钥引用名（仅用于错误消息）。
	 * @param {string} apiKey - 密钥明文（只存在于本方法栈内）。
	 * @param {Record<string, unknown>} config - 归一化配置。
	 * @param {{ query: string, maxResults?: number }} request - 搜索请求。
	 * @param {AbortSignal} [signal] - 取消信号。
	 * @returns {Promise<{ content?: string, sources: Array<object>, truncated: boolean }>} 规范化结果。
	 */
	async searchWithKey(ref, apiKey, config, request, signal) {
		const endpoint = `${config.tavilyBaseURL}/search`
		const body = {
			query: request.query,
			max_results: Math.min(
				typeof request.maxResults === 'number' && request.maxResults > 0 ? request.maxResults : config.tavilyMaxResults,
				config.tavilyMaxResults
			),
			search_depth: config.tavilySearchDepth,
			include_answer: config.tavilyIncludeAnswer,
			include_published_date: true
		}

		const timeoutMs = config.tavilyTimeoutMs
		const timeoutSignal = AbortSignal.timeout(timeoutMs)
		const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])

		let response
		try {
			response = await this.fetchImpl(endpoint, {
				method: 'POST',
				redirect: 'error',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': 'application/json',
					accept: 'application/json'
				},
				body: JSON.stringify(body),
				signal: combined
			})
		} catch (error) {
			if (signal?.aborted === true) throwIfAborted(signal)
			const classification = {
				kind: 'transient',
				message: `无法连接 ${endpoint}：${String(error?.message ?? error)}`
			}
			throw attachClassification(error instanceof Error ? error : new Error(String(error)), classification)
		}

		if (!response.ok) {
			const detail = await errorDetail(response)
			const classification = classifyHttpFailure(response.status, detail, response.headers)
			const error = webError(classification.message, CODES.TAVILY_REQUEST_INVALID)
			throw attachClassification(error, classification)
		}

		let parsed
		try {
			parsed = await response.json()
		} catch (error) {
			if (signal?.aborted === true) throwIfAborted(signal)
			throw attachClassification(
				error instanceof Error ? error : new Error(String(error)),
				{ kind: 'transient', message: 'Tavily 返回了无法解析的响应正文。' }
			)
		}
		return mapTavilyResponse(parsed)
	}

	/**
	 * 查询每个密钥的用量（Tavily `GET /usage`），供设置页展示。
	 *
	 * 这是只读的辅助调用：任一密钥查询失败只标注该槽位，不影响其他槽位。
	 *
	 * @param {readonly string[]} refs - 密钥引用名顺序。
	 * @param {AbortSignal} [signal] - 取消信号。
	 * @returns {Promise<Array<{ ref: string, ok: boolean, usage?: unknown, error?: string }>>} 逐槽位结果。
	 */
	async usage(refs, signal) {
		const config = this.getConfig()
		const keys = await this.resolveKeys(refs)
		const results = []
		for (const ref of refs) {
			const apiKey = keys[ref]
			if (apiKey === undefined) {
				results.push({ ref, ok: false, error: '未配置密钥' })
				continue
			}
			const endpoint = `${config.tavilyBaseURL}/usage`
			try {
				const timeoutSignal = AbortSignal.timeout(Math.min(config.tavilyTimeoutMs, 15000))
				const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal])
				const response = await this.fetchImpl(endpoint, {
					method: 'GET',
					redirect: 'error',
					headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
					signal: combined
				})
				if (!response.ok) {
					const detail = await errorDetail(response)
					results.push({ ref, ok: false, error: `HTTP ${String(response.status)}${detail.length > 0 ? `：${detail}` : ''}` })
					continue
				}
				results.push({ ref, ok: true, usage: await response.json() })
			} catch (error) {
				results.push({ ref, ok: false, error: String(error?.message ?? error) })
			}
		}
		return results
	}
}

/**
 * 给错误挂上本插件的失败分类，供轮换逻辑读取。
 * 用不可枚举属性，避免污染序列化后的错误对象。
 * @param {Error} error - 原始错误。
 * @param {{ kind: string, message: string }} classification - 分类。
 * @returns {Error} 同一个错误对象。
 */
function attachClassification(error, classification) {
	Object.defineProperty(error, 'webSearchPlusClassification', {
		value: classification,
		enumerable: false,
		configurable: true
	})
	return error
}
