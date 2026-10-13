/**
 * 契约测试：**本插件不得向会话日志写入任何事件**。
 *
 * ## 为什么必须有这个文件
 *
 * 2026-10-03/04 出现过两次「历史加载失败」：
 *
 *   failed to observe session ...: contains event type "web/search-plus-route"
 *   (seq 3227) unknown to this harness and not marked ignorable
 *
 * 插件当时用 `session.append('web/search-plus-route', payload)` 记录路由观测。
 * 这行代码能跑通、所有单测全绿，但它**写出的东西让宿主再也打不开那个会话**：
 *
 *   - 宿主准入条件是 `KNOWN_SESSION_EVENT_TYPES.has(type) || event.ignorable === true`；
 *   - `Session.append(type, data, opts)` 的 opts 只接受 `sourceEventSeqs` / `surfaceOp`，
 *     **没有任何设置 `ignorable` 的途径**；
 *   - 所以插件自定义的类型必然落在两个条件之外 —— 不可修复、不可兼容。
 *
 * 也就是说：这类错误**只在用户翻到那条历史会话时才会暴露**，暴露在用户面前，
 * 不在任何测试里。190 个测试全绿并不能保护我们免于它。
 *
 * ## 为什么测行为而不是测源码文本
 *
 * 关键在于走真实的 `apply()`，把 `session.append` 换成会记录调用的探针，
 * 然后真的跑一次搜索，看有没有人碰它。这样：
 *
 *   - 注释里提到 `Session.append()` 不会被误判成调用；
 *   - 事件名常量留在 `chain.js` 里也无妨——**是否落进日志由 record 的实现决定**，
 *     事件名本身无害，决定权在唯一接线处 `index.js`。
 *
 * 只断言「文本里没有某个字符串」会把安全的位置约束和危险的写法混为一谈，
 * 那样的测试会逼着开发者去做无意义的改名，而不是修真正的问题。
 *
 * 白名单取自宿主 `KNOWN_SESSION_EVENT_TYPES`（@deepseek-ai/dsh-session）。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply, Config, ROUTE_PREFIX } from '../lib/index.js'

/** 宿主 KNOWN_SESSION_EVENT_TYPES 的当前取值。 */
const KNOWN_SESSION_EVENT_TYPES = new Set([
	'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided',
	'approval/policy', 'assistant/attempt', 'assistant/message', 'command/done', 'command/run',
	'compaction/end', 'compaction/prune', 'compaction/start', 'compaction/summary',
	'deliverables/presented', 'developer/message', 'feedback/message-delete',
	'feedback/message-put', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result',
	'image/offload', 'llm/retry', 'llm/retry-started', 'model/selection', 'permission/preset',
	'plan/mode', 'request/context', 'request/header', 'sandbox/mode', 'schedule/change',
	'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title',
	'session/title-llm-request', 'step/end', 'step/start', 'subagent/catalog',
	'subagent/descriptor', 'subagent/model-selection-policy', 'system/message', 'team/member',
	'team/message/delivered', 'team/message/queued', 'team/task', 'todo/write',
	'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end',
	'tool-workflow/run-start', 'tool/call', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start',
	'tool/result', 'turn/end', 'turn/start', 'user/message',
	'web/deepseek-search-llm-request', 'workspace/changes'
])

/**
 * 启动真实插件，装上会记录调用的 Session 探针。
 *
 * `session.append` 是探针被触发的**唯一入口**——插件想写日志就只能走它。
 *
 * @returns {{ chain: object, appended: Array<{type: string, data: unknown}>, logs: string[] }} 探针结果。
 */
function bootWithSessionProbe() {
	const appended = []
	const logs = []
	const registered = new Map()

	/** 假 Session：任何 append 都会被记录下来。 */
	const session = {
		append(type, data) {
			appended.push({ type, data })
			return { type, seq: appended.length - 1 }
		}
	}

	/** 官方 DeepSeek 提供方：链上的第二个节点，保证搜索总能成功。 */
	const deepSeek = {
		available: () => true,
		search: async () => ({ sources: [{ url: 'https://deepseek.test' }], truncated: false })
	}

	const ctx = {
		web: {
			searchProviders: new Map([['deepseek-official', deepSeek]]),
			searchProviderId: 'web-search-plus',
			registerSearchProvider(provider) {
				registered.set(provider.id, provider)
				return () => registered.delete(provider.id)
			}
		},
		get(name) {
			// agents.currentInitiator().session 是插件当初唯一能拿到 Session 的途径。
			if (name === 'agents') {
				return { currentInitiator: () => ({ session }) }
			}
			if (name === 'credentials') {
				// 不返回任何密钥：Tavily 节点必然失败，从而走到 DeepSeek，
				// 保证 chain 的 record 在「回退」与「命中」两条路径上都被触发。
				return { resolve: async () => undefined }
			}
			return undefined
		},
		effect(fn) { return fn() },
		inject(deps, callback) {
			return callback({
				effect: (fn) => fn(),
				fiber: {},
				get: ctx.get,
				webServer: { register: () => () => {} },
				settings: { configure: () => () => {} }
			})
		},
		logger: {
			debug: (...args) => { logs.push(args.map(String).join(' ')) },
			info() {}, warn() {}, error() {}
		}
	}

	const resolved = Config['~standard'].validate({}).value
	apply(ctx, resolved)

	const chain = registered.get('web-search-plus')
	assert.ok(chain !== undefined, 'apply() 没有向 seam 注册链式提供方')
	return { chain, appended, logs }
}

describe('契约：不得写入会话事件', () => {
	it('跑完整条搜索链后，Session 一次都没被 append', async () => {
		const { chain, appended } = bootWithSessionProbe()
		await chain.search({ query: '契约测试' })

		assert.deepEqual(
			appended,
			[],
			'插件向会话日志写了事件。宿主只接受已知类型或带 ignorable:true 的事件，'
			+ '而 Session.append() 无法设置该标记——用户将永远打不开这个会话。'
		)
	})

	it('假想的自定义事件会被宿主拒绝（证明上一条断言有约束力）', () => {
		// 宿主准入规则：已知类型，或带 ignorable:true。
		const hostAccepts = (event) => (
			KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true
		)
		assert.equal(hostAccepts({ type: 'web/search-plus-route' }), false)
		assert.equal(hostAccepts({ type: 'web/search-plus-route', ignorable: true }), true)
		assert.equal(hostAccepts({ type: 'web/deepseek-search-llm-request' }), true)
	})

	it('路由观测改由日志承担（说明替代通道确实在工作）', async () => {
		const { chain, logs } = bootWithSessionProbe()
		await chain.search({ query: '契约测试' })
		// 没有密钥 → Tavily 失败 → 回退 DeepSeek，两条 record 都应留下日志痕迹。
		assert.ok(
			logs.some((line) => line.includes('search-plus-fallback')),
			'没有观测日志：记录路由的意图被静默丢掉了'
		)
	})
})

describe('契约：路由前缀保持稳定', () => {
	it('ROUTE_PREFIX 是归一化的绝对前缀（避免 ${PREFIX}${path} 拼出畸形 URL）', () => {
		assert.ok(ROUTE_PREFIX.startsWith('/'), `前缀应以 / 开头，实际 ${String(ROUTE_PREFIX)}`)
		assert.ok(!ROUTE_PREFIX.endsWith('/'), `前缀不应以 / 结尾，实际 ${String(ROUTE_PREFIX)}`)
	})
})
