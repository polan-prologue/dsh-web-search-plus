/**
 * 纯逻辑单测：配置归一化。
 *
 * 这些测试不依赖 DSH 运行时——`config.js` 只处理普通值，因此可以直接运行
 * `node --test tests/`。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
	DEFAULT_KEY_REF,
	DEFAULT_PRIORITY,
	DEFAULT_TAVILY_BASE_URL,
	keyRefForSlot,
	normalizeConfig,
	normalizeKeyRefs,
	normalizePriority,
	PROVIDER_DEEPSEEK,
	PROVIDER_TAVILY
} from '../lib/config.js'

describe('normalizePriority', () => {
	it('保留用户给定的顺序', () => {
		const { priority, warnings } = normalizePriority([PROVIDER_DEEPSEEK, PROVIDER_TAVILY])
		assert.deepEqual(priority, [PROVIDER_DEEPSEEK, PROVIDER_TAVILY])
		assert.deepEqual(warnings, [])
	})

	it('剔除未知提供方并告警', () => {
		const { priority, warnings } = normalizePriority([PROVIDER_TAVILY, 'bing', PROVIDER_DEEPSEEK])
		assert.deepEqual(priority, [PROVIDER_TAVILY, PROVIDER_DEEPSEEK])
		assert.equal(warnings.length, 1)
		assert.match(warnings[0], /bing/u)
	})

	it('去重并保留首次出现的位置', () => {
		const { priority, warnings } = normalizePriority([PROVIDER_TAVILY, PROVIDER_DEEPSEEK, PROVIDER_TAVILY])
		assert.deepEqual(priority, [PROVIDER_TAVILY, PROVIDER_DEEPSEEK])
		assert.equal(warnings.length, 1)
	})

	it('为空时回落到默认顺序', () => {
		assert.deepEqual(normalizePriority([]).priority, DEFAULT_PRIORITY)
		assert.deepEqual(normalizePriority(undefined).priority, DEFAULT_PRIORITY)
		assert.deepEqual(normalizePriority('tavily').priority, DEFAULT_PRIORITY)
	})

	it('只保留单个节点时也接受', () => {
		assert.deepEqual(normalizePriority([PROVIDER_DEEPSEEK]).priority, [PROVIDER_DEEPSEEK])
	})
})

describe('normalizeKeyRefs', () => {
	it('接受合法的环境变量名', () => {
		const { refs } = normalizeKeyRefs(['TAVILY_API_KEY', 'TAVILY_API_KEY_2', '_X9'])
		assert.deepEqual(refs, ['TAVILY_API_KEY', 'TAVILY_API_KEY_2', '_X9'])
	})

	it('丢弃非法引用名并告警', () => {
		const { refs, warnings } = normalizeKeyRefs(['TAVILY_API_KEY', '9bad', 'has-dash', 'has space', ''])
		assert.deepEqual(refs, ['TAVILY_API_KEY'])
		assert.equal(warnings.length, 4)
	})

	it('合并重复引用名', () => {
		const { refs, warnings } = normalizeKeyRefs(['A_KEY', 'A_KEY'])
		assert.deepEqual(refs, ['A_KEY'])
		assert.equal(warnings.length, 1)
	})

	it('为空时回落到默认槽位', () => {
		assert.deepEqual(normalizeKeyRefs([]).refs, [DEFAULT_KEY_REF])
		assert.deepEqual(normalizeKeyRefs(undefined).refs, [DEFAULT_KEY_REF])
		assert.deepEqual(normalizeKeyRefs([9, null]).refs, [DEFAULT_KEY_REF])
	})

	it('限制槽位数量上限', () => {
		const many = Array.from({ length: 30 }, (unused, index) => `K_${String(index)}`)
		const { refs, warnings } = normalizeKeyRefs(many)
		assert.equal(refs.length, 20)
		assert.equal(warnings.length, 1)
		assert.match(warnings[0], /最多 20/u)
	})
})

describe('keyRefForSlot', () => {
	it('首槽沿用约定名，其后追加序号', () => {
		assert.equal(keyRefForSlot(0), 'TAVILY_API_KEY')
		assert.equal(keyRefForSlot(1), 'TAVILY_API_KEY_2')
		assert.equal(keyRefForSlot(9), 'TAVILY_API_KEY_10')
	})
})

describe('normalizeConfig', () => {
	it('无配置时给出完整可用的默认值', () => {
		const { config, warnings } = normalizeConfig({})
		assert.deepEqual(config.priority, DEFAULT_PRIORITY)
		assert.deepEqual(config.tavilyKeyRefs, [DEFAULT_KEY_REF])
		assert.equal(config.tavilyBaseURL, DEFAULT_TAVILY_BASE_URL)
		assert.equal(config.tavilyMaxResults, 8)
		assert.equal(config.tavilySearchDepth, 'basic')
		assert.equal(config.tavilyIncludeAnswer, true)
		assert.equal(config.tavilyTimeoutMs, 30000)
		assert.equal(config.fallbackOnEmpty, false)
		assert.deepEqual(warnings, [])
	})

	it('去掉接口地址的尾部斜杠', () => {
		assert.equal(normalizeConfig({ tavilyBaseURL: 'https://api.tavily.com/' }).config.tavilyBaseURL, 'https://api.tavily.com')
	})

	it('非法接口地址回落到默认并告警', () => {
		const { config, warnings } = normalizeConfig({ tavilyBaseURL: 'not a url' })
		assert.equal(config.tavilyBaseURL, DEFAULT_TAVILY_BASE_URL)
		assert.equal(warnings.length, 1)
	})

	it('拒绝非 http(s) 协议', () => {
		const { config, warnings } = normalizeConfig({ tavilyBaseURL: 'ftp://example.com' })
		assert.equal(config.tavilyBaseURL, DEFAULT_TAVILY_BASE_URL)
		assert.match(warnings[0], /http/u)
	})

	it('把结果数夹到 1..20', () => {
		assert.equal(normalizeConfig({ tavilyMaxResults: 0 }).config.tavilyMaxResults, 1)
		assert.equal(normalizeConfig({ tavilyMaxResults: 99 }).config.tavilyMaxResults, 20)
		assert.equal(normalizeConfig({ tavilyMaxResults: 'abc' }).config.tavilyMaxResults, 8)
		assert.equal(normalizeConfig({ tavilyMaxResults: 7.9 }).config.tavilyMaxResults, 7)
	})

	it('非法搜索深度回落到 basic', () => {
		assert.equal(normalizeConfig({ tavilySearchDepth: 'quantum' }).config.tavilySearchDepth, 'basic')
		assert.equal(normalizeConfig({ tavilySearchDepth: 'advanced' }).config.tavilySearchDepth, 'advanced')
	})

	it('额度冷却默认到次日零点，0 表示不自动恢复', () => {
		// 2026-10-04 10:00:00 本地时间 → 距离次日 0 点还有 14 小时。
		const now = new Date(2026, 9, 4, 10, 0, 0, 0).getTime()
		const { config } = normalizeConfig({}, now)
		assert.equal(config.tavilyQuotaCooldownMs, 14 * 60 * 60 * 1000)
		assert.equal(normalizeConfig({ tavilyQuotaCooldownMs: 0 }, now).config.tavilyQuotaCooldownMs, 0)
	})

	it('布尔字段按真值处理', () => {
		assert.equal(normalizeConfig({ tavilyIncludeAnswer: false }).config.tavilyIncludeAnswer, false)
		assert.equal(normalizeConfig({ fallbackOnEmpty: true }).config.fallbackOnEmpty, true)
		assert.equal(normalizeConfig({ fallbackOnEmpty: 'yes' }).config.fallbackOnEmpty, true)
	})

	it('汇总来自各字段的告警', () => {
		const { warnings } = normalizeConfig({
			priority: ['nope'],
			tavilyKeyRefs: ['bad-name'],
			tavilyBaseURL: 'nope'
		})
		assert.ok(warnings.length >= 3)
	})
})
