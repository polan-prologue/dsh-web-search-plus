/**
 * 回归测试：Config schema 必须能被 **DSH 宿主**接纳。
 *
 * ## 为什么必须有这个文件
 *
 * 这是本项目最严重的一次事故：为了让插件能加载，曾经手搓了一个「假 schemastery
 * schema」。插件确实能加载了，但 **DSH 直接无法启动**：
 *
 * ```
 * SHIM volatileForm FAILED: TypeError: schema.toJSON is not a function
 * ```
 *
 * 链路是：DSH 启动 → `settings.describe()` 遍历**每个插件**的 Config →
 * `volatileForm()` → `plainSchema()` → `new z(schema.toJSON())`。schema 是被宿主
 * **深度内省**的契约对象，自制替身必炸。
 *
 * 而当时的 100+ 单测全部通过——因为它们只检查「我自己的代码怎么用 schema」，
 * 从不检查「宿主怎么内省 schema」。这个文件补上后者。
 *
 * 断言逐字复刻 `@deepseek-ai/dsh-settings` 的实现（redactSecrets / plainSchema /
 * volatileForm），任何一条失败都意味着**用户的 DSH 起不来**。
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

import { Config, readConfig } from '../lib/schema.js'

/**
 * 解析宿主同款的 schemastery（测试用）。
 * @returns {Function|undefined} Schema 构造函数，或 undefined（无宿主环境）。
 */
function hostSchemastery() {
	const dirs = []
	const profileDir = process.env.DSH_PROFILE_DIR
	if (typeof profileDir === 'string' && profileDir.length > 0) dirs.push(join(profileDir, 'node_modules'))
	const home = process.env.DSH_HOME
	if (typeof home === 'string' && home.length > 0) {
		try {
			for (const profile of readdirSync(join(home, 'profiles'))) dirs.push(join(home, 'profiles', profile, 'node_modules'))
		} catch { /* 没有 profiles 目录 */ }
	}
	for (const dir of dirs) {
		try {
			const require = createRequire(pathToFileURL(join(dir, 'noop.js')).href)
			const mod = require('@deepseek-ai/schemastery')
			const candidate = typeof mod === 'function' ? mod : (mod?.default ?? mod?.Schema)
			if (typeof candidate === 'function' && typeof candidate.object === 'function') return candidate
		} catch { /* 试下一个 */ }
	}
	return undefined
}

const z = hostSchemastery()

// ---- 以下三个函数逐字复刻 @deepseek-ai/dsh-settings/lib/index.js ----

/** 脱敏占位（测试里不做真实脱敏，只需保持形状）。 */
function redactSecrets(node, value) {
	return { value }
}

/** dsh-settings 的 plainSchema：把 volatile schema 转成普通表单 schema。 */
function plainSchema(schema) {
	const result = new z(schema.toJSON())
	const walk = (node) => {
		delete node.meta.volatile
		if (node.meta.role === 'secret') {
			delete node.meta.default
			delete node.meta.required
		} else if (node.meta.default !== void 0) node.meta.default = redactSecrets(node, node.meta.default).value
		for (const child of Object.values(node.dict ?? {})) walk(child)
		if (node.inner) walk(node.inner)
		for (const child of node.list ?? []) walk(child)
	}
	walk(result)
	return result
}

/** dsh-settings 的 volatileForm：挑出可热改字段。 */
function volatileForm(schema) {
	if (schema.meta.volatile) return plainSchema(schema)
	if (schema.type === 'object') {
		const dict = Object.fromEntries(Object.entries(schema.dict ?? {}).flatMap(([key, child]) => {
			const field = volatileForm(child)
			return field === undefined ? [] : [[key, field]]
		}))
		return Object.keys(dict).length === 0 ? undefined : z.object(dict)
	}
	return undefined
}

describe('Config 是真正的 schemastery schema', () => {
	it('导出的 Config 由 schemastery 构造（不是手搓替身）', () => {
		assert.equal(typeof Config, 'function', 'Config 应当是 schemastery 的 Schema 函数')
		assert.equal(typeof Config.toJSON, 'function', 'Config 必须有 toJSON')
		assert.ok(Config.meta !== undefined, 'Config 必须有 meta')
		assert.equal(Config.type, 'object')
	})

	it('每个字段都是真正的 schema 节点（带 toJSON）', () => {
		const dict = Config.dict ?? {}
		assert.ok(Object.keys(dict).length > 0, 'Config 应当有字段')
		for (const [key, node] of Object.entries(dict)) {
			assert.equal(typeof node.toJSON, 'function', `字段 ${key} 缺少 toJSON —— 宿主内省时必炸`)
			assert.ok(node.meta !== undefined, `字段 ${key} 缺少 meta`)
		}
	})

	it('没有 /noop|shim|fallback/ 之类的自制 schema 标记', () => {
		assert.notEqual(Config['~standard']?.vendor, 'dsh-web-search-plus', '自定义 ~standard 说明用了替身 schema')
	})
})

describe('宿主内省路径（dsh-settings 真实实现）', () => {
	it('volatileForm 不抛错并返回全部字段', { skip: z === undefined ? '无宿主 schemastery 环境' : false }, () => {
		// 这一条正是当初让 DSH 无法启动的地方。
		const form = volatileForm(Config)
		assert.notEqual(form, undefined, 'volatileForm 应当返回表单 schema')
		const fields = Object.keys(form.dict ?? {})
		assert.ok(fields.includes('priority'), '表单里应当有 priority')
		assert.ok(fields.includes('tavilyKeyRefs'), '表单里应当有 tavilyKeyRefs')
	})

	it('plainSchema 可以往返（toJSON → new z）', { skip: z === undefined ? '无宿主 schemastery 环境' : false }, () => {
		assert.doesNotThrow(() => plainSchema(Config))
	})

	it('describe() 里的 JSON.stringify([uid, schema.toJSON(), config]) 可用', () => {
		assert.doesNotThrow(() => {
			const raw = JSON.stringify([1, Config.toJSON(), {}])
			assert.ok(raw.length > 0)
		})
	})
})

describe('cordis 的 Standard Schema 校验', () => {
	it('validate 返回 volatile 引用并填充默认值', () => {
		const result = Config['~standard'].validate({})
		assert.equal(result.issues, undefined)
		assert.deepEqual(result.value.priority.get(), ['tavily', 'deepseek-official'])
		assert.equal(result.value.tavilyMaxResults.get(), 8)
	})

	it('validate 接受用户提供的值', () => {
		const result = Config['~standard'].validate({ priority: ['deepseek-official', 'tavily'], tavilyMaxResults: 5 })
		assert.equal(result.issues, undefined)
		assert.deepEqual(result.value.priority.get(), ['deepseek-official', 'tavily'])
		assert.equal(result.value.tavilyMaxResults.get(), 5)
	})

	it('readConfig 能从校验结果读出归一化配置', () => {
		const { config, warnings } = readConfig(Config['~standard'].validate({}).value)
		assert.deepEqual(config.priority, ['tavily', 'deepseek-official'])
		assert.deepEqual(config.tavilyKeyRefs, ['TAVILY_API_KEY'])
		assert.equal(config.tavilyBaseURL, 'https://api.tavily.com')
		assert.ok(Array.isArray(warnings))
	})
})
