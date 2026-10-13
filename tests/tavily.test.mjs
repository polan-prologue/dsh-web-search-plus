/**
 * 纯逻辑单测：Tavily 提供方（请求构造、响应映射、错误分类、多密钥轮换）。
 *
 * 全部用注入的假 `fetch`，因此不产生任何网络流量，也不接触真实密钥。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
	classifyHttpFailure,
	KeyRing,
	mapTavilyResponse,
	TavilySearchProvider
} from '../lib/tavily.js'
import { CODES } from '../lib/errors.js'

const CONFIG = {
	priority: ['tavily', 'deepseek-official'],
	tavilyKeyRefs: ['K1', 'K2'],
	tavilyBaseURL: 'https://api.tavily.test',
	tavilyMaxResults: 8,
	tavilySearchDepth: 'basic',
	tavilyIncludeAnswer: true,
	tavilyTimeoutMs: 5000,
	tavilyRateLimitCooldownMs: 60_000,
	tavilyQuotaCooldownMs: 3_600_000,
	fallbackOnEmpty: false
}

/** 构造一个成功响应。 */
function okResponse(body) {
	return {
		ok: true,
		status: 200,
		headers: new Headers({ 'content-type': 'application/json' }),
		json: async () => body
	}
}

/** 构造一个失败响应。 */
function errResponse(status, body = {}, headers = {}) {
	return {
		ok: false,
		status,
		headers: new Headers(headers),
		json: async () => body
	}
}

/**
 * 造一个受控的提供方实例。
 * @param {object} options - 测试选项。
 * @returns {{ provider: TavilySearchProvider, calls: object[], ring: KeyRing }} 实例、调用记录与状态机。
 */
function makeProvider(options = {}) {
	const calls = []
	const keys = options.keys ?? { K1: 'key-one', K2: 'key-two' }
	const ring = new KeyRing({ now: () => 0 })
	const provider = new TavilySearchProvider({
		getConfig: () => ({ ...CONFIG, ...(options.config ?? {}) }),
		resolveKey: async (ref) => keys[ref],
		keyRing: ring,
		fetchImpl: async (url, init) => {
			calls.push({ url, init })
			const handler = options.handler ?? (() => okResponse({ results: [{ url: 'https://a.test', title: 'A', content: 'aa' }] }))
			return await handler(url, init, calls.length)
		}
	})
	return { provider, calls, ring }
}

describe('mapTavilyResponse', () => {
	it('把 results 映射为 seam 的来源字段', () => {
		const result = mapTavilyResponse({
			answer: '一句话答案',
			results: [
				{ url: 'https://a.test', title: 'A', content: '摘要 A', published_date: 'Thu, 24 Sep 2026 13:00:00 GMT' },
				{ url: 'https://b.test', title: 'B' }
			]
		})
		assert.equal(result.content, '一句话答案')
		assert.equal(result.truncated, false)
		assert.deepEqual(result.sources[0], {
			url: 'https://a.test',
			title: 'A',
			snippet: '摘要 A',
			publishedAt: 'Thu, 24 Sep 2026 13:00:00 GMT'
		})
		assert.deepEqual(result.sources[1], { url: 'https://b.test', title: 'B' })
	})

	it('按 url 去重并跳过无 url 的条目', () => {
		const result = mapTavilyResponse({
			results: [
				{ url: 'https://a.test', title: 'A' },
				{ url: 'https://a.test', title: 'A again' },
				{ title: 'no url' },
				null
			]
		})
		assert.equal(result.sources.length, 1)
		assert.equal(result.sources[0].title, 'A')
	})

	it('没有 answer 时不产生 content', () => {
		const result = mapTavilyResponse({ results: [] })
		assert.ok(!Object.hasOwn(result, 'content'))
		assert.deepEqual(result.sources, [])
	})

	it('容忍畸形输入', () => {
		assert.deepEqual(mapTavilyResponse(null).sources, [])
		assert.deepEqual(mapTavilyResponse({ results: 'nope' }).sources, [])
		assert.deepEqual(mapTavilyResponse(undefined).sources, [])
	})
})

describe('classifyHttpFailure', () => {
	it('401/403 视为密钥无效', () => {
		assert.equal(classifyHttpFailure(401, '', undefined).kind, 'invalid-key')
		assert.equal(classifyHttpFailure(403, '', undefined).kind, 'invalid-key')
	})

	it('429 视为限流并读取 Retry-After', () => {
		const headers = new Headers({ 'retry-after': '30' })
		const classified = classifyHttpFailure(429, 'too many', headers)
		assert.equal(classified.kind, 'rate-limited')
		assert.equal(classified.retryAfterMs, 30_000)
		assert.match(classified.message, /30 秒/u)
	})

	it('432/433 视为额度耗尽', () => {
		assert.equal(classifyHttpFailure(432, '', undefined).kind, 'quota-exhausted')
		assert.equal(classifyHttpFailure(433, '', undefined).kind, 'quota-exhausted')
	})

	it('422 视为请求非法（不轮换）', () => {
		assert.equal(classifyHttpFailure(422, '', undefined).kind, 'request-invalid')
	})

	it('400 视为该密钥不接受此请求（继续轮换）', () => {
		// 实测：无效密钥配正常查询返回 401，而有效密钥配单字符查询返回 400，
		// 因此 400 不是 schema 级问题，换一个密钥确实可能成功。
		assert.equal(classifyHttpFailure(400, '', undefined).kind, 'transient')
		assert.match(classifyHttpFailure(400, '', undefined).message, /下一个密钥/u)
	})

	it('5xx 视为临时故障', () => {
		assert.equal(classifyHttpFailure(500, '', undefined).kind, 'transient')
		assert.equal(classifyHttpFailure(503, '', undefined).kind, 'transient')
	})

	it('把响应细节并入消息', () => {
		assert.match(classifyHttpFailure(401, 'invalid api key', undefined).message, /invalid api key/u)
	})
})

describe('TavilySearchProvider 请求构造', () => {
	it('使用 Bearer 鉴权并发送配置里的参数', async () => {
		const { provider, calls } = makeProvider()
		await provider.search({ query: '你好' })
		assert.equal(calls.length, 1)
		assert.equal(calls[0].url, 'https://api.tavily.test/search')
		assert.equal(calls[0].init.method, 'POST')
		assert.equal(calls[0].init.headers.authorization, 'Bearer key-one')
		const body = JSON.parse(calls[0].init.body)
		assert.equal(body.query, '你好')
		assert.equal(body.max_results, 8)
		assert.equal(body.search_depth, 'basic')
		assert.equal(body.include_answer, true)
		assert.equal(body.include_published_date, true)
	})

	it('请求的 maxResults 不超过配置上限', async () => {
		const { provider, calls } = makeProvider()
		await provider.search({ query: 'q', maxResults: 3 })
		assert.equal(JSON.parse(calls[0].init.body).max_results, 3)
	})

	it('关闭摘要答案时不请求 answer', async () => {
		const { provider, calls } = makeProvider({ config: { tavilyIncludeAnswer: false } })
		await provider.search({ query: 'q' })
		assert.equal(JSON.parse(calls[0].init.body).include_answer, false)
	})
})

describe('TavilySearchProvider 多密钥轮换', () => {
	it('第一个密钥限流后改用第二个', async () => {
		let attempt = 0
		const { provider, calls, ring } = makeProvider({
			handler: () => {
				attempt += 1
				if (attempt === 1) return errResponse(429, { detail: { error: 'rate limited' } })
				return okResponse({ results: [{ url: 'https://ok.test' }] })
			}
		})
		const result = await provider.search({ query: 'q' })
		assert.equal(calls.length, 2)
		assert.equal(calls[0].init.headers.authorization, 'Bearer key-one')
		assert.equal(calls[1].init.headers.authorization, 'Bearer key-two')
		assert.equal(result.sources.length, 1)
		// 首选密钥进入冷却，第二个成为粘滞选择。
		const slots = ring.snapshot()
		assert.equal(slots.find((slot) => slot.ref === 'K1').state, 'cooldown')
		assert.equal(slots.find((slot) => slot.ref === 'K2').sticky, true)
	})

	it('密钥无效时跳过它', async () => {
		const { provider } = makeProvider({
			handler: (unusedUrl, init) => init.headers.authorization === 'Bearer key-one'
				? errResponse(401, { detail: { error: 'unauthorized' } })
				: okResponse({ results: [{ url: 'https://ok.test' }] })
		})
		const result = await provider.search({ query: 'q' })
		assert.equal(result.sources.length, 1)
	})

	it('并发密钥全部耗尽时抛出可识别错误', async () => {
		const { provider } = makeProvider({
			handler: () => errResponse(432, { detail: { error: 'plan limit exceeded' } })
		})
		await assert.rejects(
			() => provider.search({ query: 'q' }),
			(error) => {
				assert.equal(error.code, CODES.TAVILY_KEYS_EXHAUSTED)
				assert.match(error.message, /K1/u)
				assert.match(error.message, /K2/u)
				return true
			}
		)
	})

	it('请求非法（422）不轮换，直接上抛', async () => {
		let attempt = 0
		const { provider, calls } = makeProvider({
			handler: () => {
				attempt += 1
				return errResponse(422, { detail: [{ msg: 'bad query' }] })
			}
		})
		await assert.rejects(() => provider.search({ query: 'q' }), /bad query/u)
		assert.equal(calls.length, 1, '请求非法时不应换密钥重试')
	})

	it('没有任何密钥配置时给出明确错误', async () => {
		const { provider, calls } = makeProvider({ keys: {} })
		await assert.rejects(
			() => provider.search({ query: 'q' }),
			(error) => {
				assert.equal(error.code, CODES.TAVILY_CREDENTIAL_MISSING)
				return true
			}
		)
		assert.equal(calls.length, 0)
	})

	it('单个密钥解析失败不影响其他槽位', async () => {
		const calls = []
		const ring = new KeyRing({ now: () => 0 })
		const provider = new TavilySearchProvider({
			getConfig: () => ({ ...CONFIG }),
			resolveKey: async (ref) => {
				if (ref === 'K1') throw new Error('凭据域不可用')
				return 'key-two'
			},
			keyRing: ring,
			fetchImpl: async (url, init) => {
				calls.push(init)
				return okResponse({ results: [{ url: 'https://ok.test' }] })
			}
		})
		const result = await provider.search({ query: 'q' })
		assert.equal(calls.length, 1)
		assert.equal(calls[0].headers.authorization, 'Bearer key-two')
		assert.equal(result.sources.length, 1)
	})

	it('网络异常时改用下一个密钥', async () => {
		let attempt = 0
		const { provider, calls } = makeProvider({
			handler: () => {
				attempt += 1
				if (attempt === 1) throw new Error('connect ECONNREFUSED')
				return okResponse({ results: [{ url: 'https://ok.test' }] })
			}
		})
		const result = await provider.search({ query: 'q' })
		assert.equal(calls.length, 2)
		assert.equal(result.sources.length, 1)
	})

	it('调用方取消时立刻穿透，不轮换', async () => {
		const controller = new AbortController()
		const { provider, calls } = makeProvider({
			handler: () => {
				controller.abort()
				const error = new Error('aborted')
				error.name = 'AbortError'
				throw error
			}
		})
		await assert.rejects(
			() => provider.search({ query: 'q' }, controller.signal),
			(error) => {
				// 取消被归一化成稳定的 WEB_ABORTED 码，原始 AbortError 挂在 cause 上。
				assert.equal(error.code, CODES.ABORTED)
				return true
			}
		)
		assert.equal(calls.length, 1)
	})

	it('已取消的信号在发起请求前就被检查', async () => {
		const controller = new AbortController()
		controller.abort(new Error('提前取消'))
		const { provider, calls } = makeProvider()
		await assert.rejects(() => provider.search({ query: 'q' }, controller.signal))
		assert.equal(calls.length, 0)
	})
})

describe('TavilySearchProvider 用量查询', () => {
	it('逐密钥查询并汇集结果', async () => {
		const { provider } = makeProvider({
			handler: () => okResponse({ account: { plan_usage: 5, plan_limit: 1000 } })
		})
		const usage = await provider.usage(['K1', 'K2'])
		assert.equal(usage.length, 2)
		assert.ok(usage.every((entry) => entry.ok))
	})

	it('未配置的槽位直接标注', async () => {
		const { provider } = makeProvider({ keys: { K1: 'key-one' } })
		const usage = await provider.usage(['K1', 'K2'])
		assert.equal(usage.find((entry) => entry.ref === 'K2').ok, false)
		assert.match(usage.find((entry) => entry.ref === 'K2').error, /未配置/u)
	})

	it('查询失败只影响该槽位', async () => {
		const { provider } = makeProvider({
			handler: (unusedUrl, init) => init.headers.authorization === 'Bearer key-one'
				? okResponse({ account: {} })
				: errResponse(401, {})
		})
		const usage = await provider.usage(['K1', 'K2'])
		assert.equal(usage.find((entry) => entry.ref === 'K1').ok, true)
		assert.equal(usage.find((entry) => entry.ref === 'K2').ok, false)
	})
})
