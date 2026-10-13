/**
 * dsh-web-search-plus —— 插件 Config schema。
 *
 * ## 这个文件为什么长这样（一次真实事故的记录）
 *
 * 本插件以「链接目录」形式装进 profile，链接目标在 profile 树之外，因此顶层
 * `import '@deepseek-ai/schemastery'` 解析不到。为了让插件能加载，早先版本写了一个
 * **手搓的 schema 垫片**——这是**根本性错误**，代价是 DSH 直接无法启动：
 *
 * ```
 * SHIM volatileForm FAILED: TypeError: schema.toJSON is not a function
 * ```
 *
 * 原因是 DSH 启动时会调 `settings.describe()`，它对**每个插件**的 Config 跑
 * `volatileForm()` → `plainSchema()` → `new z(schema.toJSON())`。schema 是被宿主
 * **深度内省**的契约对象，不是插件可以自己造的普通数据。
 *
 * 因此本文件的铁律：
 *
 * 1. **永远只用真正的 schemastery**，绝不回退到自制 schema；
 * 2. 解析不到就**大声失败**（抛错），而不是静默降级——让插件加载失败，
 *    总好过让整个 DSH 起不来；
 * 3. 解析方式用 `createRequire` 指向 profile 的 `node_modules`，这条路径已实测可用
 *    （ESM 顶层 import 不行，CJS require 可以）。
 *
 * @module dsh-web-search-plus/schema
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
	DEFAULT_KEY_REF,
	DEFAULT_PRIORITY,
	DEFAULT_RATE_LIMIT_COOLDOWN_MS,
	DEFAULT_TAVILY_BASE_URL,
	DEFAULT_TAVILY_INCLUDE_ANSWER,
	DEFAULT_TAVILY_MAX_RESULTS,
	DEFAULT_TAVILY_SEARCH_DEPTH,
	DEFAULT_TAVILY_TIMEOUT_MS,
	normalizeConfig
} from './config.js'

/** 插件在 Loader 里的名字，也是设置命名空间（patchId）。 */
export const name = 'web-search-plus'

/** schemastery 的包名。 */
const SCHEMASTERY = '@deepseek-ai/schemastery'

/**
 * 收集候选的 `node_modules` 目录：从「最可能命中」到「兜底」。
 *
 * 刻意**不依赖任何 DSH 环境变量作为主要依据**：实测 `DSH_PROFILE_DIR` / `DSH_HOME`
 * 由 `dsh-shell-env` 只注入给模型 shell 工具，宿主进程自身并没有它们。
 *
 * @returns {string[]} 候选目录。
 */
function candidateModuleDirs() {
	const dirs = []
	// 1) 从插件自身位置逐级向上找 node_modules——链接安装下的确定路径。
	let current = dirname(fileURLToPath(import.meta.url))
	for (let depth = 0; depth < 12; depth += 1) {
		const candidate = join(current, 'node_modules')
		if (existsSync(candidate)) dirs.push(candidate)
		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}
	// 2) 正常安装（非链接）时，本插件自己的解析路径里就有。
	try {
		const require = createRequire(import.meta.url)
		for (const p of require.resolve.paths(SCHEMASTERY) ?? []) dirs.push(p)
	} catch {
		// 忽略：还有后面的兜底。
	}
	// 3) DSH 的标准目录布局：默认 `~/.dsh/profiles/<profile>/node_modules`。
	//    用 homedir() 推导，不需要环境变量——这是宿主里最可靠的一条兜底。
	try {
		const profilesDir = join(homedir(), '.dsh', 'profiles')
		for (const profile of readdirSync(profilesDir)) {
			dirs.push(join(profilesDir, profile, 'node_modules'))
		}
	} catch {
		// 忽略：不是标准布局。
	}
	// 4) 环境变量（宿主若恰好提供，就多一条路；不假设它们存在）。
	const home = process.env.DSH_HOME
	const homeDir = typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh')
	try {
		for (const profile of readdirSync(join(homeDir, 'profiles'))) {
			dirs.push(join(homeDir, 'profiles', profile, 'node_modules'))
		}
	} catch {
		// 忽略。
	}
	const profileDir = process.env.DSH_PROFILE_DIR
	if (typeof profileDir === 'string' && profileDir.length > 0) dirs.push(join(profileDir, 'node_modules'))
	// 5) 进程工作目录向上——最后一道保险。
	let cwd = process.cwd()
	for (let depth = 0; depth < 8; depth += 1) {
		const candidate = join(cwd, 'node_modules')
		if (existsSync(candidate)) dirs.push(candidate)
		const parent = dirname(cwd)
		if (parent === cwd) break
		cwd = parent
	}
	return [...new Set(dirs)]
}

/**
 * 解析真正的 schemastery（**同步**）。
 *
 * 两条路径依次尝试，命中即用：
 *
 * 1. `createRequire(import.meta.url)` —— 正常安装时直接命中；链接安装时由 DSH 的
 *    profile 解析器接管（它按 `peerDependencies` 把链接根解析到运行时包）；
 * 2. 显式候选目录 —— 从插件位置回溯、`~/.dsh/profiles/*` 等（见 `candidateModuleDirs`）。
 *
 * 刻意**不用动态 `import()`**：那需要模块顶层 await，会在插件加载阶段引入时序风险。
 * 实测 CJS `require` 能覆盖全部目标环境，因此不需要 ESM 通道。
 *
 * 都不通就抛错。**绝不返回自制 schema**——那会让 DSH 启动失败（见文件头注释）。
 *
 * @returns {Function} Schema 构造函数。
 * @throws {Error} 全部路径都失败时。
 */
function loadSchemastery() {
	const tried = []
	const acceptable = (candidate) => typeof candidate === 'function' && typeof candidate.object === 'function'

	// 1) 从本模块位置直接 require。
	try {
		const require = createRequire(import.meta.url)
		const mod = require(SCHEMASTERY)
		const candidate = typeof mod === 'function' ? mod : (mod?.default ?? mod?.Schema)
		if (acceptable(candidate)) return candidate
		tried.push('createRequire（导出形状不符）')
	} catch (error) {
		tried.push(`createRequire（${String(error?.code ?? error?.message ?? error)}）`)
	}

	// 2) 逐个候选目录。
	for (const dir of candidateModuleDirs()) {
		try {
			const require = createRequire(pathToFileURL(join(dir, 'noop.js')).href)
			const mod = require(SCHEMASTERY)
			const candidate = typeof mod === 'function' ? mod : (mod?.default ?? mod?.Schema)
			if (acceptable(candidate)) return candidate
			tried.push(`${dir}（导出形状不符）`)
		} catch (error) {
			tried.push(`${dir}（${String(error?.code ?? error?.message ?? error)}）`)
		}
	}

	throw new Error(
		`网页搜索++ 无法解析 ${SCHEMASTERY}，插件拒绝加载：Config schema 必须由真正的 `
		+ `schemastery 构造（DSH 会深度内省它，自制替身会让整个应用无法启动）。`
		+ `已尝试：${tried.join('；')}`
	)
}

/** 真正的 schemastery。解析失败直接抛错，绝不静默降级。 */
const z = loadSchemastery()

/** 字段声明表：字段名、类型、默认值与取值范围。 */
const FIELDS = [
	{ key: 'priority', kind: 'array', default: [...DEFAULT_PRIORITY] },
	{ key: 'tavilyKeyRefs', kind: 'array', default: [DEFAULT_KEY_REF] },
	{ key: 'tavilyBaseURL', kind: 'string', default: DEFAULT_TAVILY_BASE_URL },
	{ key: 'tavilyMaxResults', kind: 'number', default: DEFAULT_TAVILY_MAX_RESULTS, min: 1, max: 20, step: 1 },
	{ key: 'tavilySearchDepth', kind: 'string', default: DEFAULT_TAVILY_SEARCH_DEPTH },
	{ key: 'tavilyIncludeAnswer', kind: 'boolean', default: DEFAULT_TAVILY_INCLUDE_ANSWER },
	{ key: 'tavilyTimeoutMs', kind: 'number', default: DEFAULT_TAVILY_TIMEOUT_MS, min: 1000, max: 600000, step: 1 },
	{ key: 'tavilyRateLimitCooldownMs', kind: 'number', default: DEFAULT_RATE_LIMIT_COOLDOWN_MS, min: 0, max: 86400000, step: 1 },
	{ key: 'tavilyQuotaCooldownMs', kind: 'number', default: 0, min: 0, max: 604800000, step: 1 },
	{ key: 'fallbackOnEmpty', kind: 'boolean', default: false }
]

/**
 * 用给定的 schemastery 构造字段 schema。
 * @param {Function} z - schemastery。
 * @returns {object} schemastery schema。
 */
function build(z) {
	const dict = {}
	for (const field of FIELDS) {
		let node
		if (field.kind === 'array') node = z.array(z.string()).default([...field.default])
		else if (field.kind === 'boolean') node = z.boolean().default(field.default)
		else if (field.kind === 'number') {
			node = z.number().step(field.step).min(field.min).max(field.max).default(field.default)
		} else node = z.string().default(field.default)
		// 每个叶子字段单独 volatile：设置页可就地修改，不必重挂载插件。
		dict[field.key] = node.volatile()
	}
	return z.object(dict)
}

/** 本插件的 Config schema。 */
export const Config = build(z)

/**
 * 判断一个值是否是 volatile 引用（有 `.get()`）。
 * @param {unknown} value - 待判断的值。
 * @returns {boolean} 是否是 volatile 引用。
 */
function isVolatileRef(value) {
	return typeof value === 'object' && value !== null && typeof value.get === 'function'
}

/**
 * 从插件 Config（volatile 引用树）里取出普通值。
 * @param {unknown} value - Config 或其字段。
 * @returns {unknown} 普通值。
 */
function plain(value) {
	if (isVolatileRef(value)) return plain(value.get())
	if (Array.isArray(value)) return value.map(plain)
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]))
	}
	return value
}

/**
 * 读取并归一化当前 Config。
 *
 * 每次调用都重新读出当前值（volatile），因此设置页保存后下一次搜索立即生效。
 *
 * @param {object} config - `apply(ctx, config)` 收到的 Config。
 * @returns {{ config: Record<string, unknown>, warnings: string[] }} 归一化配置与告警。
 */
export function readConfig(config) {
	return normalizeConfig(plain(config))
}

export { DEFAULT_KEY_REF }
