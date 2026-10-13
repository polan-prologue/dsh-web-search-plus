/**
 * dsh-web-search-plus —— 错误类型与稳定错误码。
 *
 * seam（`ctx.web`）的 `WebError.code` 是**开放字符串**，消费方必须容忍未知取值；
 * 本插件自定义的 code 一律带 `WEB_SEARCH_PLUS_` 前缀，避免与上游码混淆。
 *
 * `WebError` 在本包内以「动态导入 + 本地回退」的方式取得，原因有两条：
 *  1. 生产组合里 `@deepseek-ai/dsh-web` 由运行时解析表提供，`WebError` 与工具层
 *     检查的 `HarnessError` 是同一个类，抛出的错误会带上结构化 code；
 *  2. 单元测试直接以 `node --test` 运行，此时没有 DSH 运行时，导入会失败——回退
 *     实现保持相同的 `name`/`code`/`cause` 形状，纯逻辑因此可独立测试。
 *
 * @module dsh-web-search-plus/errors
 */

import { createRequire } from 'node:module'

/** 本插件使用的稳定错误码。 */
export const CODES = {
	/** 优先级链上的每个提供方都失败了。 */
	CHAIN_EXHAUSTED: 'WEB_SEARCH_CHAIN_EXHAUSTED',
	/** 优先级链上没有任何可用节点。 */
	NO_USABLE_NODE: 'WEB_SEARCH_PLUS_NO_USABLE_NODE',
	/** Tavily 的所有密钥都不可用（无效 / 冷却 / 未配置）。 */
	TAVILY_KEYS_EXHAUSTED: 'WEB_SEARCH_PLUS_TAVILY_KEYS_EXHAUSTED',
	/** Tavily 一个密钥都没有配置。 */
	TAVILY_CREDENTIAL_MISSING: 'WEB_SEARCH_PLUS_TAVILY_CREDENTIAL_MISSING',
	/** Tavily 拒绝了请求本身（换密钥与换提供方都无意义）。 */
	TAVILY_REQUEST_INVALID: 'WEB_SEARCH_PLUS_TAVILY_REQUEST_INVALID',
	/** DeepSeek 原生提供方未注册（例如其 Loader 行被禁用）。 */
	DEEPSEEK_NOT_REGISTERED: 'WEB_SEARCH_PLUS_DEEPSEEK_NOT_REGISTERED',
	/** 调用方取消。 */
	ABORTED: 'WEB_ABORTED'
}

/**
 * `WebError` 的本地回退实现：只在 `@deepseek-ai/dsh-web` 不可解析时使用。
 * 形状与上游保持一致（`name`、`code`、标准 `cause`）。
 */
class FallbackWebError extends Error {
	/**
	 * @param {string} message - 面向人的失败描述。
	 * @param {string} code - 机器可路由的稳定错误码。
	 * @param {{ cause?: unknown }} [options] - 标准错误选项。
	 */
	constructor(message, code, options) {
		super(message, options)
		this.code = code
		this.name = 'WebError'
	}
}

/** 上游 `WebError` 的惰性解析结果：`undefined` 表示还没试过。 */
let upstreamWebError

/**
 * 尝试取上游的 `WebError` 类。
 *
 * 刻意**惰性**（首次抛错时才解析）而不是模块顶层的 `await import`：
 * 顶层 await 会在插件加载阶段引入时序与解析风险，而这个类只影响错误对象的
 * 具体类型，晚一点拿到完全没关系。
 *
 * @returns {Function} 上游类或本地回退类。
 */
function resolveWebErrorClass() {
	if (upstreamWebError !== undefined) return upstreamWebError
	upstreamWebError = FallbackWebError
	// 同步 require 优先（链接安装下这条可用），失败就算了——回退实现形状一致。
	try {
		const require = createRequire(import.meta.url)
		const mod = require('@deepseek-ai/dsh-web')
		if (typeof mod?.WebError === 'function') upstreamWebError = mod.WebError
	} catch {
		// 裁剪组合或测试环境：保留回退实现。
	}
	return upstreamWebError
}

/** 本插件抛出的 Web 错误（上游类可用时即为上游类）。 */
export class WebError extends FallbackWebError {
	/**
	 * @param {string} message - 面向人的失败描述。
	 * @param {string} code - 机器可路由的稳定错误码。
	 * @param {{ cause?: unknown }} [options] - 标准错误选项。
	 */
	constructor(message, code, options) {
		super(message, code, options)
	}
}

/**
 * 构造一个带稳定 code 的 Web 错误。
 *
 * 用上游类（若存在）以便 `instanceof HarnessError` 的判断在 dsh-tools 里成立；
 * 拿不到时用本地回退类，形状与上游一致（`name` / `code` / `cause`）。
 *
 * @param {string} message - 面向人的失败描述。
 * @param {string} code - 机器可路由的稳定错误码。
 * @param {unknown} [cause] - 被包装的原始失败。
 * @returns {Error} 可直接抛给 seam 的错误。
 */
export function webError(message, code, cause) {
	const Base = resolveWebErrorClass()
	return cause === undefined ? new Base(message, code) : new Base(message, code, { cause })
}

/** 判断一个值是否携带指定的稳定错误码。 */
export function hasCode(value, code) {
	return typeof value === 'object' && value !== null && value.code === code
}

/**
 * 判断一个失败是否是取消（调用方 abort 或超时导致的 abort）。
 * 取消必须原样穿透整条链，绝不能被当成「换一个提供方再试」。
 */
export function isAbortError(value) {
	if (value === undefined || value === null) return false
	if (typeof DOMException === 'function' && value instanceof DOMException) {
		return value.name === 'AbortError'
	}
	return typeof value === 'object' && (value.name === 'AbortError' || value.name === 'TimeoutError')
}

/**
 * 调用方已经取消时立刻抛出，避免向已放弃的请求继续派发网络调用。
 * @param {AbortSignal} [signal] - 调用方的取消信号。
 */
export function throwIfAborted(signal) {
	if (signal?.aborted !== true) return
	const reason = signal.reason
	throw reason instanceof Error && hasCode(reason, CODES.ABORTED)
		? reason
		: webError('网页搜索++：调用方已取消本次搜索。', CODES.ABORTED, reason)
}
