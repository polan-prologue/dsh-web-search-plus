/**
 * 纯逻辑单测：优先级链式提供方。
 *
 * 覆盖本插件的核心承诺——「优先 Tavily，失败回退 DeepSeek 原生」，以及取消穿透、
 * 空结果语义、全失败时的聚合错误。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CHAIN_PROVIDER_ID, ChainSearchProvider } from '../lib/chain.js'
import { CODES } from '../lib/errors.js'
import { PROVIDER_DEEPSEEK, PROVIDER_TAVILY } from '../lib/config.js'

/** 一个可编程的假 Tavily 节点。 */
function fakeTavily(behavior) {
	const calls = []
	return {
		calls,
		search: async (request, signal) => {
			calls.push({ request, signal })
			return await behavior(request)
		}
	}
}

/** 一个可编程的假 DeepSeek 提供方。 */
function fakeDeepSeek(behavior, available = true) {
	const calls = []
	return {
		calls,
		provider: {
			available: () => available,
			search: async (request, signal) => {
				calls.push({ request, signal })
				return await behavior(request)
			}
		}
	}
}

/**
 * 造一个链式提供方。
 * @param {object} options - 测试选项。
 * @returns {{ chain: ChainSearchProvider, events: object[], deepSeek: object }} 实例与观测记录。
 */
function makeChain(options = {}) {
	const events = []
	const deepSeek = options.deepSeek ?? fakeDeepSeek(() => ({ sources: [{ url: 'https://deepseek.test' }], truncated: false }))
	const chain = new ChainSearchProvider({
		getConfig: () => ({
			priority: [PROVIDER_TAVILY, PROVIDER_DEEPSEEK],
			tavilyKeyRefs: ['K1'],
			fallbackOnEmpty: false,
			...options.config
		}),
		tavily: options.tavily ?? fakeTavily(() => ({ sources: [{ url: 'https://tavily.test' }], truncated: false })),
		getDeepSeek: () => (options.deepSeekMissing === true ? undefined : deepSeek.provider),
		record: (event, payload) => events.push({ event, payload })
	})
	return { chain, events, deepSeek }
}

describe('链式提供方：优先级与回退', () => {
	it('首选 Tavily 成功时不再触碰 DeepSeek', async () => {
		const tavily = fakeTavily(() => ({ sources: [{ url: 'https://tavily.test' }], truncated: false }))
		const { chain, deepSeek, events } = makeChain({ tavily })
		const result = await chain.search({ query: 'q' })
		assert.equal(result.sources[0].url, 'https://tavily.test')
		assert.equal(deepSeek.calls.length, 0)
		assert.equal(events.at(-1).event, 'web/search-plus-route')
		assert.equal(events.at(-1).payload.provider, PROVIDER_TAVILY)
	})

	it('Tavily 失败时回退到 DeepSeek 原生', async () => {
		const tavily = fakeTavily(() => {
			const error = new Error('Tavily 挂了')
			error.code = CODES.TAVILY_KEYS_EXHAUSTED
			throw error
		})
		const { chain, deepSeek, events } = makeChain({ tavily })
		const result = await chain.search({ query: 'q' })
		assert.equal(result.sources[0].url, 'https://deepseek.test')
		assert.equal(deepSeek.calls.length, 1)
		assert.ok(events.some((entry) => entry.event === 'web/search-plus-fallback' && entry.payload.from === PROVIDER_TAVILY))
		assert.equal(events.at(-1).payload.provider, PROVIDER_DEEPSEEK)
	})

	it('顺序反过来时先走 DeepSeek', async () => {
		const tavily = fakeTavily(() => ({ sources: [{ url: 'https://tavily.test' }], truncated: false }))
		const { chain, deepSeek } = makeChain({
			tavily,
			config: { priority: [PROVIDER_DEEPSEEK, PROVIDER_TAVILY] }
		})
		const result = await chain.search({ query: 'q' })
		assert.equal(result.sources[0].url, 'https://deepseek.test')
		assert.equal(tavily.calls.length, 0)
		assert.equal(deepSeek.calls.length, 1)
	})

	it('DeepSeek 未注册时记为未注册并继续其他节点', async () => {
		const { chain } = makeChain({
			deepSeekMissing: true,
			config: { priority: [PROVIDER_DEEPSEEK, PROVIDER_TAVILY] }
		})
		const result = await chain.search({ query: 'q' })
		assert.equal(result.sources[0].url, 'https://tavily.test')
	})

	it('DeepSeek 不可用时也跳过', async () => {
		const { chain } = makeChain({
			deepSeek: fakeDeepSeek(() => ({ sources: [] }), false),
			config: { priority: [PROVIDER_DEEPSEEK, PROVIDER_TAVILY] }
		})
		const result = await chain.search({ query: 'q' })
		assert.equal(result.sources[0].url, 'https://tavily.test')
	})
})

describe('链式提供方：全部失败', () => {
	it('抛出带每条原因的聚合错误', async () => {
		const tavily = fakeTavily(() => { throw new Error('Tavily 全部密钥耗尽') })
		const deepSeek = fakeDeepSeek(() => { throw new Error('DeepSeek 没有 API Key') })
		const { chain } = makeChain({ tavily, deepSeek })
		await assert.rejects(
			() => chain.search({ query: 'q' }),
			(error) => {
				assert.equal(error.code, CODES.CHAIN_EXHAUSTED)
				assert.match(error.message, /Tavily 全部密钥耗尽/u)
				assert.match(error.message, /DeepSeek 没有 API Key/u)
				return true
			}
		)
	})
})

describe('链式提供方：取消语义', () => {
	it('调用方取消时立刻穿透，不回退', async () => {
		const controller = new AbortController()
		const tavily = fakeTavily(() => {
			controller.abort()
			const error = new Error('aborted')
			error.name = 'AbortError'
			throw error
		})
		const { chain, deepSeek } = makeChain({ tavily })
		await assert.rejects(() => chain.search({ query: 'q' }, controller.signal))
		assert.equal(deepSeek.calls.length, 0, '取消不应触发回退')
	})

	it('已取消的信号在第一个节点前就被检查', async () => {
		const controller = new AbortController()
		controller.abort(new Error('提前取消'))
		const tavily = fakeTavily(() => ({ sources: [] }))
		const { chain } = makeChain({ tavily })
		await assert.rejects(() => chain.search({ query: 'q' }, controller.signal))
		assert.equal(tavily.calls.length, 0)
	})
})

describe('链式提供方：空结果语义', () => {
	it('默认把 0 结果当成有效答案，不回退', async () => {
		const tavily = fakeTavily(() => ({ sources: [], truncated: false }))
		const { chain, deepSeek } = makeChain({ tavily })
		const result = await chain.search({ query: 'q' })
		assert.deepEqual(result.sources, [])
		assert.equal(deepSeek.calls.length, 0)
	})

	it('开启 fallbackOnEmpty 后 0 结果继续下一个节点', async () => {
		const tavily = fakeTavily(() => ({ sources: [], truncated: false }))
		const { chain, deepSeek } = makeChain({ tavily, config: { fallbackOnEmpty: true } })
		const result = await chain.search({ query: 'q' })
		assert.equal(result.sources[0].url, 'https://deepseek.test')
		assert.equal(deepSeek.calls.length, 1)
	})

	it('只有 content 没有来源也算非空', async () => {
		const tavily = fakeTavily(() => ({ content: '一段摘要', sources: [], truncated: false }))
		const { chain, deepSeek } = makeChain({ tavily, config: { fallbackOnEmpty: true } })
		const result = await chain.search({ query: 'q' })
		assert.equal(result.content, '一段摘要')
		assert.equal(deepSeek.calls.length, 0)
	})
})

describe('链式提供方：可用性与链路描述', () => {
	it('id 是 seam 注册用的固定值', () => {
		const { chain } = makeChain()
		assert.equal(chain.id, CHAIN_PROVIDER_ID)
	})

	it('有密钥槽位时视为可用', () => {
		const { chain } = makeChain()
		assert.equal(chain.available(), true)
	})

	it('没有密钥槽位且 DeepSeek 缺失时不可用', () => {
		const { chain } = makeChain({ deepSeekMissing: true, config: { tavilyKeyRefs: [] } })
		assert.equal(chain.available(), false)
	})

	it('优先级只剩 DeepSeek 时按其可用性判断', () => {
		const available = makeChain({ config: { priority: [PROVIDER_DEEPSEEK] } })
		assert.equal(available.chain.available(), true)
		const unavailable = makeChain({
			config: { priority: [PROVIDER_DEEPSEEK] },
			deepSeek: fakeDeepSeek(() => ({ sources: [] }), false)
		})
		assert.equal(unavailable.chain.available(), false)
	})

	it('链路描述如实反映每个节点的状态', () => {
		const { chain } = makeChain()
		const { chain: described } = chain.describe()
		assert.equal(described.length, 2)
		assert.equal(described[0].node, PROVIDER_TAVILY)
		assert.equal(described[0].available, true)
		assert.match(described[0].detail, /K1/u)
		assert.equal(described[1].node, PROVIDER_DEEPSEEK)
		assert.equal(described[1].available, true)
	})

	it('DeepSeek 未注册时描述里标为不可用', () => {
		const { chain } = makeChain({ deepSeekMissing: true })
		const deepseekNode = chain.describe().chain.find((node) => node.node === PROVIDER_DEEPSEEK)
		assert.equal(deepseekNode.available, false)
		assert.match(deepseekNode.detail, /未注册/u)
	})
})

describe('链式提供方：探测报告', () => {
	it('报告命中节点与路径上的每次尝试', async () => {
		const tavily = fakeTavily(() => { throw new Error('失败') })
		const { chain } = makeChain({ tavily })
		const report = await chain.searchWithReport({ query: 'q' })
		assert.equal(report.route, PROVIDER_DEEPSEEK)
		assert.equal(report.attempts.length, 2)
		assert.equal(report.attempts[0].ok, false)
		assert.match(report.attempts[0].reason, /失败/u)
		assert.equal(report.attempts[1].ok, true)
	})

	it('首个节点成功时报告里只有一次尝试', async () => {
		const { chain } = makeChain()
		const report = await chain.searchWithReport({ query: 'q' })
		assert.equal(report.route, PROVIDER_TAVILY)
		assert.equal(report.attempts.length, 1)
		assert.equal(report.attempts[0].ok, true)
	})

	it('探测报告不含任何密钥内容字段', async () => {
		const { chain } = makeChain()
		const report = await chain.searchWithReport({ query: 'q' })
		const serialized = JSON.stringify(report.attempts)
		assert.ok(!/Bearer|api[_-]?key/iu.test(serialized))
	})
})
