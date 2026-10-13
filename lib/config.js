/**
 * dsh-web-search-plus —— 配置词汇与归一化（纯函数，无外部依赖）。
 *
 * 这里不导入 schemastery：schema 在 `schema.js`，本模块只处理**已经取出的普通值**，
 * 因此可以被 `node --test` 直接测试。
 *
 * @module dsh-web-search-plus/config
 */

/** Tavily（第三方）搜索的节点 id。 */
export const PROVIDER_TAVILY = 'tavily'

/** DeepSeek 官方搜索提供方注册的稳定 id。 */
export const PROVIDER_DEEPSEEK = 'deepseek-official'

/** 优先级链允许出现的节点，顺序即 UI 展示顺序。 */
export const KNOWN_PROVIDERS = [PROVIDER_TAVILY, PROVIDER_DEEPSEEK]

/** 节点的中文标签，Host 与浏览器半侧共用同一份文案。 */
export const PROVIDER_LABELS = {
	[PROVIDER_TAVILY]: 'Tavily 搜索（第三方）',
	[PROVIDER_DEEPSEEK]: 'DeepSeek 原生搜索'
}

/** 默认优先级：Tavily 优先，DeepSeek 兜底。 */
export const DEFAULT_PRIORITY = [PROVIDER_TAVILY, PROVIDER_DEEPSEEK]

/** Tavily 接口默认地址（`/search` 与 `/usage` 都拼在它后面）。 */
export const DEFAULT_TAVILY_BASE_URL = 'https://api.tavily.com'

/** 单次 Tavily 搜索默认返回条数。 */
export const DEFAULT_TAVILY_MAX_RESULTS = 8

/** 默认搜索深度。 */
export const DEFAULT_TAVILY_SEARCH_DEPTH = 'basic'

/** Tavily 支持的搜索深度。 */
export const TAVILY_SEARCH_DEPTHS = ['basic', 'fast', 'ultra-fast', 'advanced']

/** 默认是否请求 Tavily 的 LLM 摘要答案（映射到结果的 `content`）。 */
export const DEFAULT_TAVILY_INCLUDE_ANSWER = true

/** 默认单次 Tavily 请求超时。 */
export const DEFAULT_TAVILY_TIMEOUT_MS = 30000

/** 命中限流（HTTP 429）后默认冷却时长：一分钟。 */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60000

/** 默认的第一个密钥槽引用名。 */
export const DEFAULT_KEY_REF = 'TAVILY_API_KEY'

/** 槽位数上限，避免 UI 与配置被无限撑大。 */
export const MAX_KEY_SLOTS = 20

/**
 * 凭据引用名的语法，与 `@deepseek-ai/dsh-credentials` 的 `REF_PATTERN` 一致。
 * 引用名必须是合法的 POSIX 环境变量名——凭据域按环境变量名寻址。
 */
export const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 判断一个字符串能否作为凭据引用名。
 * @param {unknown} value - 候选值。
 * @returns {boolean} 是否合法。
 */
export function isCredentialRefName(value) {
	return typeof value === 'string' && REF_PATTERN.test(value)
}

/**
 * 第 n 个密钥槽的引用名：首槽沿用约定俗成的 `TAVILY_API_KEY`，其后追加序号。
 * @param {number} index - 从 0 开始的槽位序号。
 * @returns {string} 该槽位使用的凭据引用名。
 */
export function keyRefForSlot(index) {
	return index === 0 ? DEFAULT_KEY_REF : `${DEFAULT_KEY_REF}_${String(index + 1)}`
}

/**
 * 归一化优先级：剔除未知节点、去重、保序；空结果回落到默认顺序。
 * @param {unknown} raw - 配置里的原始值。
 * @returns {{ priority: string[], warnings: string[] }} 归一化结果与告警。
 */
export function normalizePriority(raw) {
	const warnings = []
	const priority = []
	// 完全没配置时不产生告警：默认顺序本来就是正确的初始状态，不是「被修正的错误」。
	if (raw === undefined || raw === null) return { priority: [...DEFAULT_PRIORITY], warnings }
	if (Array.isArray(raw)) {
		for (const node of raw) {
			if (typeof node !== 'string' || node.length === 0) {
				warnings.push('优先级里有一项不是字符串，已忽略。')
				continue
			}
			if (!KNOWN_PROVIDERS.includes(node)) {
				warnings.push(`优先级里的「${node}」不是本插件支持的提供方，已忽略。`)
				continue
			}
			if (priority.includes(node)) {
				warnings.push(`优先级里的「${node}」重复出现，已保留第一次的位置。`)
				continue
			}
			priority.push(node)
		}
	} else {
		warnings.push('优先级不是一个列表，已使用默认顺序。')
	}
	if (priority.length === 0) {
		warnings.push('优先级为空，已使用默认顺序（Tavily 优先，DeepSeek 兜底）。')
		return { priority: [...DEFAULT_PRIORITY], warnings }
	}
	return { priority, warnings }
}

/**
 * 归一化密钥槽引用名列表：只保留合法引用名、去重、限制槽位数。
 * @param {unknown} raw - 配置里的原始值。
 * @returns {{ refs: string[], warnings: string[] }} 归一化结果与告警。
 */
export function normalizeKeyRefs(raw) {
	const warnings = []
	const refs = []
	// 同 priority：未配置是正常初始状态，不产生告警。
	if (raw === undefined || raw === null) return { refs: [DEFAULT_KEY_REF], warnings }
	if (Array.isArray(raw)) {
		for (const ref of raw) {
			if (!isCredentialRefName(ref)) {
				warnings.push(`密钥槽位「${String(ref)}」不是合法的环境变量名（需形如 TAVILY_API_KEY_2），已忽略。`)
				continue
			}
			if (refs.includes(ref)) {
				warnings.push(`密钥槽位「${ref}」重复出现，已合并。`)
				continue
			}
			if (refs.length >= MAX_KEY_SLOTS) {
				warnings.push(`密钥槽位最多 ${String(MAX_KEY_SLOTS)} 个，多余项已忽略。`)
				break
			}
			refs.push(ref)
		}
	} else {
		warnings.push('密钥槽位不是一个列表，已使用默认槽位。')
	}
	if (refs.length === 0) {
		warnings.push('没有可用的密钥槽位，已使用默认槽位 TAVILY_API_KEY。')
		refs.push(DEFAULT_KEY_REF)
	}
	return { refs, warnings }
}

/**
 * 归一化接口地址：去掉尾部斜杠；非法或空值回落到默认地址。
 * @param {unknown} raw - 配置里的原始值。
 * @returns {{ baseURL: string, warning?: string }} 归一化结果与可选告警。
 */
export function normalizeBaseURL(raw) {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		return { baseURL: DEFAULT_TAVILY_BASE_URL }
	}
	const trimmed = raw.trim().replace(/\/+$/u, '')
	try {
		const url = new URL(trimmed)
		if (url.protocol !== 'https:' && url.protocol !== 'http:') {
			return { baseURL: DEFAULT_TAVILY_BASE_URL, warning: 'Tavily 接口地址必须是 http(s) 地址，已使用默认地址。' }
		}
		return { baseURL: trimmed }
	} catch {
		return { baseURL: DEFAULT_TAVILY_BASE_URL, warning: `Tavily 接口地址「${raw}」无法解析，已使用默认地址。` }
	}
}

/**
 * 把一个数值限制在闭区间内；非法值返回回退值。
 * @param {unknown} raw - 候选值。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @param {number} fallback - 非法或越界时的回退值。
 * @returns {number} 归一化后的整数。
 */
function clampInteger(raw, min, max, fallback) {
	const value = typeof raw === 'number' ? raw : Number(raw)
	if (!Number.isFinite(value)) return fallback
	const rounded = Math.trunc(value)
	if (rounded < min) return min
	if (rounded > max) return max
	return rounded
}

/**
 * 把一个可选的冷却时长归一化：允许 0（表示「只在手动重置后恢复」）。
 * @param {unknown} raw - 候选值。
 * @param {number} fallback - 非法时的回退值。
 * @returns {number} 毫秒数。
 */
function clampCooldown(raw, fallback) {
	const value = typeof raw === 'number' ? raw : Number(raw)
	if (!Number.isFinite(value) || value < 0) return fallback
	return Math.trunc(value)
}

/**
 * 从配置里读出搜索深度，非法值回落到默认深度。
 * @param {unknown} raw - 候选值。
 * @returns {string} 合法的搜索深度。
 */
export function normalizeSearchDepth(raw) {
	return typeof raw === 'string' && TAVILY_SEARCH_DEPTHS.includes(raw) ? raw : DEFAULT_TAVILY_SEARCH_DEPTH
}

/**
 * 计算距离下一个「本地午夜」的毫秒数——额度类失败的默认冷却时长。
 * @param {number} now - 当前时间戳（毫秒）。
 * @returns {number} 距离次日 00:00 的毫秒数（至少 1 秒）。
 */
export function msUntilNextLocalMidnight(now) {
	const current = new Date(now)
	const next = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, 0, 0, 0, 0)
	return Math.max(1000, next.getTime() - now)
}

/**
 * 归一化整份配置。
 *
 * 输入是「已经取出的普通值」（volatile 字段已 `.get()`，见 `schema.js` 的 `readConfig`），
 * 输出永远是完整、可用的配置对象，附带的告警用于 UI 提示，不阻塞任何调用。
 *
 * @param {Record<string, unknown>} [raw] - 原始配置值。
 * @param {number} [now] - 当前时间戳，用于计算额度冷却默认值。
 * @returns {{ config: Record<string, unknown>, warnings: string[] }} 归一化配置与告警。
 */
export function normalizeConfig(raw = {}, now = Date.now()) {
	const warnings = []
	const { priority, warnings: priorityWarnings } = normalizePriority(raw.priority)
	warnings.push(...priorityWarnings)
	const { refs, warnings: refWarnings } = normalizeKeyRefs(raw.tavilyKeyRefs)
	warnings.push(...refWarnings)
	const { baseURL, warning: baseURLWarning } = normalizeBaseURL(raw.tavilyBaseURL)
	if (baseURLWarning !== undefined) warnings.push(baseURLWarning)

	return {
		config: {
			priority,
			tavilyKeyRefs: refs,
			tavilyBaseURL: baseURL,
			tavilyMaxResults: clampInteger(raw.tavilyMaxResults, 1, 20, DEFAULT_TAVILY_MAX_RESULTS),
			tavilySearchDepth: normalizeSearchDepth(raw.tavilySearchDepth),
			tavilyIncludeAnswer: raw.tavilyIncludeAnswer === undefined ? DEFAULT_TAVILY_INCLUDE_ANSWER : Boolean(raw.tavilyIncludeAnswer),
			tavilyTimeoutMs: clampInteger(raw.tavilyTimeoutMs, 1000, 600000, DEFAULT_TAVILY_TIMEOUT_MS),
			tavilyRateLimitCooldownMs: clampCooldown(raw.tavilyRateLimitCooldownMs, DEFAULT_RATE_LIMIT_COOLDOWN_MS),
			tavilyQuotaCooldownMs: clampCooldown(raw.tavilyQuotaCooldownMs, msUntilNextLocalMidnight(now)),
			fallbackOnEmpty: raw.fallbackOnEmpty === undefined ? false : Boolean(raw.fallbackOnEmpty)
		},
		warnings
	}
}
