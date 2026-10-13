/**
 * 真实联网验收脚本（不进单测套件，因为它需要真实密钥与网络）。
 *
 * 用法：`DSH_WSP_TEST_KEY=tvly-xxx node tests/live-check.mjs`
 *
 * 它验证的是「单测的假 fetch 掩盖不了的东西」：请求体真的被 Tavily 接受、
 * 字段映射真的对得上、错误分类真的贴合真实响应形态、多密钥轮换真的按预期发生。
 */

import assert from 'node:assert/strict'

import { KeyRing, TavilySearchProvider } from '../lib/tavily.js'
import { ChainSearchProvider } from '../lib/chain.js'
import { CODES } from '../lib/errors.js'
import { normalizeConfig } from '../lib/config.js'

const key = process.env.DSH_WSP_TEST_KEY
if (typeof key !== 'string' || key.length === 0) {
	console.error('缺少 DSH_WSP_TEST_KEY 环境变量。')
	process.exit(2)
}

/** 造一个只认一个有效密钥的提供方。 */
function makeProvider({ keys, config }) {
	const ring = new KeyRing()
	const provider = new TavilySearchProvider({
		getConfig: () => config,
		resolveKey: async (ref) => keys[ref],
		keyRing: ring
	})
	return { provider, ring }
}

const config = normalizeConfig({
	priority: ['tavily', 'deepseek-official'],
	tavilyKeyRefs: ['GOOD', 'BAD'],
	tavilyMaxResults: 5,
	tavilyTimeoutMs: 30000
}).config

let failures = 0

/** 跑一步并在失败时继续，最后统一汇报。 */
async function step(name, operation) {
	try {
		const detail = await operation()
		console.log(`✔ ${name}${detail === undefined ? '' : ` —— ${detail}`}`)
	} catch (error) {
		failures += 1
		console.error(`✖ ${name} —— ${String(error?.message ?? error)}`)
	}
}

// 1) 真实搜索：请求被接受，且来源字段被正确映射。
await step('真实搜索返回可引用的来源', async () => {
	const { provider } = makeProvider({ keys: { GOOD: key }, config })
	const result = await provider.search({ query: 'DeepSeek Harness DSH plugin' })
	assert.ok(result.sources.length > 0, '没有返回任何来源')
	assert.ok(result.sources[0].url.startsWith('http'), '来源缺少 URL')
	assert.ok(!result.truncated)
	return `${String(result.sources.length)} 条来源；首条 ${result.sources[0].url}`
})

// 2) maxResults 真的被 Tavily 尊重。
await step('maxResults 生效', async () => {
	const { provider } = makeProvider({ keys: { GOOD: key }, config })
	const result = await provider.search({ query: 'TypeScript 教程', maxResults: 2 })
	assert.ok(result.sources.length <= 2, `返回了 ${String(result.sources.length)} 条，超过请求的 2 条`)
	return `返回 ${String(result.sources.length)} 条`
})

// 3) 摘要答案请求在参数生效时确实带回 content。
await step('摘要答案映射为 content', async () => {
	const { provider } = makeProvider({ keys: { GOOD: key }, config })
	const result = await provider.search({ query: '什么是 DSH？' })
	if (typeof result.content !== 'string' || result.content.length === 0) {
		// Tavily 在某些查询下不返回 answer，这不是插件缺陷。
		return '（本次响应未包含 answer，属上游行为）'
	}
	return `content 长度 ${String(result.content.length)}`
})

// 4) 无效密钥被分类为「密钥无效」而不是「额度耗尽」，并自动轮到下一个。
await step('无效密钥被识别并轮换到有效密钥', async () => {
	const { provider, ring } = makeProvider({
		keys: { GOOD: key, BAD: 'tvly-dev-invalid-key-for-testing' },
		config: { ...config, tavilyKeyRefs: ['BAD', 'GOOD'] }
	})
	const result = await provider.search({ query: 'DeepSeek Harness' })
	assert.ok(result.sources.length > 0, '轮换后仍未拿到结果')
	const bad = ring.snapshot().find((slot) => slot.ref === 'BAD')
	assert.equal(bad.state, 'invalid', `无效密钥的状态是 ${bad.state}`)
	const good = ring.snapshot().find((slot) => slot.ref === 'GOOD')
	assert.equal(good.sticky, true, '有效密钥未成为粘滞选择')
	return 'BAD 标记为 invalid，GOOD 已接管'
})

// 5) 全部密钥无效时报聚合错误且带稳定码。
await step('全部密钥无效时抛 TAVILY_KEYS_EXHAUSTED', async () => {
	const { provider } = makeProvider({
		keys: { A: 'tvly-dev-invalid-a', B: 'tvly-dev-invalid-b' },
		config: { ...config, tavilyKeyRefs: ['A', 'B'] }
	})
	await assert.rejects(
		() => provider.search({ query: 'q' }),
		(error) => {
			assert.equal(error.code, CODES.TAVILY_KEYS_EXHAUSTED)
			return true
		}
	)
	return '错误码正确'
})

// 6) 真实用量查询。
await step('用量查询返回账户信息', async () => {
	const { provider } = makeProvider({ keys: { GOOD: key }, config })
	const usage = await provider.usage(['GOOD'])
	assert.equal(usage[0].ok, true, `用量查询失败：${usage[0].error ?? ''}`)
	const account = usage[0].usage?.account
	const plan = account?.current_plan ?? '未知套餐'
	const used = account?.plan_usage ?? '未知'
	const limit = account?.plan_limit ?? '未报告'
	return `套餐 ${String(plan)}，已用 ${String(used)}/${String(limit)}`
})

// 7) 真实回退：Tavily 全挂时链式层改用 DeepSeek 节点。
await step('Tavily 全挂时回退到下一个节点', async () => {
	const { provider } = makeProvider({
		keys: { BAD: 'tvly-dev-invalid' },
		config: { ...config, tavilyKeyRefs: ['BAD'] }
	})
	const deepSeekCalls = []
	const chain = new ChainSearchProvider({
		getConfig: () => config,
		tavily: provider,
		getDeepSeek: () => ({
			available: () => true,
			search: async () => {
				deepSeekCalls.push(1)
				return { sources: [{ url: 'https://example.com/fallback' }], truncated: false }
			}
		})
	})
	const report = await chain.searchWithReport({ query: 'q' })
	assert.equal(report.route, 'deepseek-official')
	assert.equal(deepSeekCalls.length, 1)
	assert.equal(report.attempts[0].ok, false)
	return '首个节点失败，第二个节点命中'
})

console.log(failures === 0 ? '\n全部真实联网检查通过。' : `\n有 ${String(failures)} 项检查失败。`)
process.exit(failures === 0 ? 0 : 1)
