/**
 * 纯逻辑单测：多密钥轮换状态机（KeyRing）。
 *
 * 这是「多个 Tavily 密钥应对免费额度上限」的核心：测试覆盖粘滞选择、按错误分类
 * 标记失效/冷却、冷却到期自动恢复、手动重置，以及快照里绝不含密钥明文。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
	COOLDOWN_QUOTA,
	COOLDOWN_RATE_LIMIT,
	KEY_COOLDOWN,
	KEY_INVALID,
	KEY_READY,
	KeyRing
} from '../lib/tavily.js'

/** 构造一个可手动推进的时钟。 */
function fakeClock(start = 1_000_000) {
	let current = start
	return {
		now: () => current,
		advance: (ms) => { current += ms },
		set: (value) => { current = value }
	}
}

const POLICY = { rateLimitCooldownMs: 60_000, quotaCooldownMs: 3_600_000 }

describe('KeyRing 选择顺序', () => {
	it('按配置顺序返回全部可用槽位', () => {
		const ring = new KeyRing({ now: () => 0 })
		ring.sync(['A', 'B', 'C'])
		assert.deepEqual(ring.order(), ['A', 'B', 'C'])
	})

	it('成功过的密钥成为粘滞首选', () => {
		const ring = new KeyRing({ now: () => 0 })
		ring.sync(['A', 'B', 'C'])
		ring.markSuccess('C')
		assert.deepEqual(ring.order(), ['C', 'A', 'B'])
	})

	it('粘滞密钥被移出配置后不再出现', () => {
		const ring = new KeyRing({ now: () => 0 })
		ring.sync(['A', 'B'])
		ring.markSuccess('B')
		ring.sync(['A'])
		assert.deepEqual(ring.order(), ['A'])
	})

	it('新出现的槽位排在已有槽位之后', () => {
		const ring = new KeyRing({ now: () => 0 })
		ring.sync(['A'])
		ring.markSuccess('A')
		ring.sync(['A', 'B'])
		assert.deepEqual(ring.order(), ['A', 'B'])
	})
})

describe('KeyRing 失效与冷却', () => {
	it('401/403 标记为失效并让出粘滞位', () => {
		const ring = new KeyRing({ now: () => 0 })
		ring.sync(['A', 'B'])
		ring.markSuccess('A')
		ring.markFailure('A', { kind: 'invalid-key', message: '密钥无效' }, POLICY)
		assert.deepEqual(ring.order(), ['B'])
		const slots = ring.snapshot()
		assert.equal(slots.find((slot) => slot.ref === 'A').state, KEY_INVALID)
		assert.ok(!slots.some((slot) => slot.sticky))
	})

	it('限流进入冷却，到期后自动恢复', () => {
		const clock = fakeClock()
		const ring = new KeyRing({ now: clock.now })
		ring.sync(['A', 'B'])
		ring.markFailure('A', { kind: 'rate-limited', message: '太频繁' }, POLICY)
		assert.deepEqual(ring.order(), ['B'])
		assert.equal(ring.snapshot().find((slot) => slot.ref === 'A').state, KEY_COOLDOWN)
		assert.equal(ring.snapshot().find((slot) => slot.ref === 'A').cooldownReason, COOLDOWN_RATE_LIMIT)

		clock.advance(59_999)
		assert.deepEqual(ring.order(), ['B'])

		clock.advance(2)
		assert.deepEqual(ring.order(), ['A', 'B'])
		assert.equal(ring.snapshot().find((slot) => slot.ref === 'A').state, KEY_READY)
	})

	it('额度耗尽使用额度冷却时长', () => {
		const clock = fakeClock()
		const ring = new KeyRing({ now: clock.now })
		ring.sync(['A'])
		ring.markFailure('A', { kind: 'quota-exhausted', message: '额度已尽' }, POLICY)
		const slot = ring.snapshot().find((item) => item.ref === 'A')
		assert.equal(slot.state, KEY_COOLDOWN)
		assert.equal(slot.cooldownReason, COOLDOWN_QUOTA)
		assert.equal(slot.cooldownUntil, clock.now() + 3_600_000)
	})

	it('0 冷却时长表示不自动恢复', () => {
		const clock = fakeClock()
		const ring = new KeyRing({ now: clock.now })
		ring.sync(['A'])
		ring.markFailure('A', { kind: 'quota-exhausted', message: '额度已尽' }, { rateLimitCooldownMs: 0, quotaCooldownMs: 0 })
		clock.advance(10 * 24 * 60 * 60 * 1000)
		assert.deepEqual(ring.order(), [])
	})

	it('Retry-After 提示比配置冷却更长时采用提示值', () => {
		const clock = fakeClock()
		const ring = new KeyRing({ now: clock.now })
		ring.sync(['A'])
		ring.markFailure('A', { kind: 'rate-limited', message: '限流', retryAfterMs: 600_000 }, POLICY)
		assert.equal(ring.snapshot()[0].cooldownUntil, clock.now() + 600_000)
	})

	it('临时故障不改变槽位状态', () => {
		const ring = new KeyRing({ now: () => 0 })
		ring.sync(['A', 'B'])
		ring.markFailure('A', { kind: 'transient', message: '网络抖动' }, POLICY)
		assert.deepEqual(ring.order(), ['A', 'B'])
		assert.equal(ring.snapshot()[0].state, KEY_READY)
	})

	it('请求非法不改变槽位状态', () => {
		const ring = new KeyRing({ now: () => 0 })
		ring.sync(['A'])
		ring.markFailure('A', { kind: 'request-invalid', message: '查询不合法' }, POLICY)
		assert.deepEqual(ring.order(), ['A'])
	})
})

describe('KeyRing 重置与快照', () => {
	it('重置单个槽位只影响该槽位', () => {
		const ring = new KeyRing({ now: () => 0 })
		ring.sync(['A', 'B'])
		ring.markFailure('A', { kind: 'invalid-key', message: 'x' }, POLICY)
		ring.markFailure('B', { kind: 'rate-limited', message: 'y' }, POLICY)
		ring.reset('A')
		const slots = ring.snapshot()
		assert.equal(slots.find((slot) => slot.ref === 'A').state, KEY_READY)
		assert.equal(slots.find((slot) => slot.ref === 'B').state, KEY_COOLDOWN)
	})

	it('整体重置清空所有标记与粘滞选择', () => {
		const ring = new KeyRing({ now: () => 0 })
		ring.sync(['A', 'B'])
		ring.markSuccess('B')
		ring.markFailure('A', { kind: 'invalid-key', message: 'x' }, POLICY)
		ring.reset()
		assert.deepEqual(ring.order(), ['A', 'B'])
		assert.ok(!ring.snapshot().some((slot) => slot.sticky))
	})

	it('快照只含引用名与状态，不含任何密钥内容', () => {
		const ring = new KeyRing({ now: () => 0 })
		ring.sync(['TAVILY_API_KEY'])
		const serialized = JSON.stringify(ring.snapshot())
		assert.match(serialized, /TAVILY_API_KEY/u)
		assert.deepEqual(Object.keys(ring.snapshot()[0]).sort(), ['cooldownUntil', 'ref', 'state', 'sticky'])
	})
})
