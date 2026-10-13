/**
 * 路由层单测：`/api/dsh-web-search-plus`。
 *
 * 用一个最小的假 ctx 与假 HTTP 对象驱动 `createRouter`，重点验证三条安全约束：
 * 非回环地址被拒、响应里绝不含密钥明文、配置写入走官方持久化路径。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createRouter, ROUTE_PREFIX } from '../lib/routes.js'
import { KeyRing, TavilySearchProvider } from '../lib/tavily.js'
import { ChainSearchProvider } from '../lib/chain.js'

/** 造一个最小的假请求对象。 */
function fakeRequest(method, url, body, remoteAddress = '127.0.0.1') {
	const listeners = new Map()
	const payload = body === undefined ? '' : JSON.stringify(body)
	return {
		method,
		url,
		socket: { remoteAddress },
		on(event, handler) {
			listeners.set(event, handler)
			if (event === 'end') {
				setImmediate(() => {
					if (payload.length > 0) listeners.get('data')?.(Buffer.from(payload, 'utf8'))
					handler()
				})
			}
			return this
		},
		destroy() {}
	}
}

/** 造一个记录响应的假响应对象。 */
function fakeResponse() {
	const captured = { status: 0, headers: undefined, body: '' }
	return {
		captured,
		writeHead(status, headers) {
			captured.status = status
			captured.headers = headers
		},
		end(text) {
			captured.body = text ?? ''
		},
		json() {
			return JSON.parse(captured.body)
		}
	}
}

/**
 * 造一套路由依赖。
 * @param {object} [options] - 覆盖项。
 * @returns {object} 处理器与配套的假依赖记录。
 */
function makeRouter(options = {}) {
	const state = {
		config: {
			priority: ['tavily', 'deepseek-official'],
			tavilyKeyRefs: ['TAVILY_API_KEY'],
			tavilyBaseURL: 'https://api.tavily.test',
			tavilyMaxResults: 8,
			tavilySearchDepth: 'basic',
			tavilyIncludeAnswer: true,
			tavilyTimeoutMs: 5000,
			tavilyRateLimitCooldownMs: 60000,
			tavilyQuotaCooldownMs: 0,
			fallbackOnEmpty: false,
			...(options.config ?? {})
		},
		persisted: [],
		credentials: { ...(options.credentials ?? { TAVILY_API_KEY: 'secret' }) },
		writes: [],
		editedWeb: []
	}
	const registry = new Map()
	if (options.deepSeek !== false) {
		registry.set('deepseek-official', {
			available: () => true,
			search: async () => ({ sources: [{ url: 'https://deepseek.test' }], truncated: false })
		})
	}

	const settings = options.noSettings === true ? undefined : {
		mutate: async (ns, ops) => {
			state.persisted.push({ ns, ops })
		}
	}

	const configEditor = options.noConfigEditor === true ? undefined : {
		entries: () => options.noWebEntry === true
			? [{ options: { id: 'web-search-plus', name: 'dsh-web-search-plus' } }]
			: [
				{ options: { id: 'web-search-plus', name: 'dsh-web-search-plus' } },
				{ options: { id: 'web', name: '@deepseek-ai/dsh-web' } }
			],
		edit: async (entry, change) => {
			if (entry.options.id === 'web') {
				const next = change({ fetchProvider: 'http' }, { searchProvider: 'deepseek-official', fetchProvider: 'http' })
				state.editedWeb.push(next)
				ctx.web.searchProviderId = next.searchProvider
				return
			}
			state.persisted.push({ ns: entry.options.id, change })
		}
	}

	const ctx = {
		web: { searchProviders: registry, searchProviderId: options.seamProvider ?? 'web-search-plus' },
		get: (name) => {
			if (name === 'credentials') return options.noCredentials === true ? undefined : {
				describe: async (ref) => ({ configured: state.credentials[ref] !== undefined, source: 'file', writable: true }),
				resolve: async (ref) => (state.credentials[ref] === undefined ? undefined : { value: state.credentials[ref], source: 'file' }),
				set: async (ref, value) => {
					state.writes.push({ ref, value })
					state.credentials[ref] = value
				},
				unset: async (ref) => {
					delete state.credentials[ref]
				}
			}
			if (name === 'settings') return settings
			if (name === 'configEditor') return configEditor
			return undefined
		}
	}

	const keyRing = new KeyRing({ now: () => 0 })
	const tavily = new TavilySearchProvider({
		getConfig: () => state.config,
		resolveKey: async (ref) => state.credentials[ref],
		keyRing,
		fetchImpl: options.fetchImpl ?? (async () => ({
			ok: true,
			status: 200,
			headers: new Headers(),
			json: async () => ({ results: [{ url: 'https://tavily.test' }] })
		}))
	})
	const chain = new ChainSearchProvider({
		getConfig: () => state.config,
		tavily,
		getDeepSeek: () => registry.get('deepseek-official')
	})

	const handler = createRouter({
		ctx,
		readState: () => ({ config: state.config, warnings: [] }),
		tavily,
		keyRing,
		chain,
		version: () => '9.9.9'
	})
	return { handler, state, keyRing, ctx }
}

/**
 * 发一次请求并返回响应。
 * @param {object} harness - `makeRouter` 的结果。
 * @param {string} method - HTTP 方法。
 * @param {string} path - 相对路径（`''` 表示路由根）。
 * @param {object} [body] - 请求体。
 * @param {string} [remote] - 来源地址。
 * @returns {Promise<object>} 假响应对象。
 */
async function call(harness, method, path, body, remote) {
	const suffix = path.length === 0 || path.startsWith('/') ? path : `/${path}`
	const res = fakeResponse()
	await harness.handler(fakeRequest(method, `${ROUTE_PREFIX}${suffix}`, body, remote), res)
	return res
}

describe('路由：访问控制', () => {
	it('拒绝非回环地址', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'GET', '', undefined, '192.168.1.9')
		assert.equal(res.captured.status, 403)
		assert.match(res.json().error, /本机/u)
	})

	it('接受 IPv6 回环地址', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'GET', '', undefined, '::1')
		assert.equal(res.captured.status, 200)
	})

	it('未知路径返回 404', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'GET', '/nope')
		assert.equal(res.captured.status, 404)
	})

	it('已知路径上的错误方法返回 405', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'GET', '/priority')
		assert.equal(res.captured.status, 405)
		assert.match(res.json().error, /只接受 PUT/u)
	})
})

describe('路由：快照', () => {
	it('返回配置、链路、密钥状态与接管状态', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'GET', '')
		const body = res.json()
		assert.equal(body.ok, true)
		assert.equal(body.version, '9.9.9')
		assert.deepEqual(body.config.priority, ['tavily', 'deepseek-official'])
		assert.equal(body.chain.length, 2)
		assert.equal(body.keys.length, 1)
		assert.equal(body.keys[0].ref, 'TAVILY_API_KEY')
		assert.equal(body.keys[0].configured, true)
		assert.equal(body.takeover.active, true)
	})

	it('未接管时如实报告并给出提示', async () => {
		const harness = makeRouter({ seamProvider: 'deepseek-official' })
		const res = await call(harness, 'GET', '')
		const body = res.json()
		assert.equal(body.takeover.active, false)
		assert.equal(body.takeover.seamProvider, 'deepseek-official')
		assert.match(body.takeover.message, /尚未接管/u)
	})

	it('快照里绝不出现密钥明文', async () => {
		const harness = makeRouter({ credentials: { TAVILY_API_KEY: 'tvly-super-secret-value' } })
		const res = await call(harness, 'GET', '')
		assert.ok(!res.captured.body.includes('tvly-super-secret-value'), '响应体泄漏了密钥明文')
		assert.match(res.captured.body, /TAVILY_API_KEY/u)
	})
})

describe('路由：优先级', () => {
	it('按顺序写入新的优先级', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'PUT', 'priority', { priority: ['deepseek-official', 'tavily'] })
		assert.equal(res.json().ok, true)
		assert.deepEqual(harness.state.persisted[0].ops, [
			{ op: 'set', path: ['priority'], value: ['deepseek-official', 'tavily'] }
		])
	})

	it('缺少列表时返回 400', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'PUT', 'priority', {})
		assert.equal(res.captured.status, 400)
		assert.match(res.json().error, /priority/u)
	})
})

describe('路由：密钥写入', () => {
	it('写入走凭据域，响应只回状态', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'POST', 'keys/value', { ref: 'TAVILY_API_KEY', value: 'tvly-new' })
		const body = res.json()
		assert.equal(body.ok, true)
		assert.equal(body.configured, true)
		assert.deepEqual(harness.state.writes, [{ ref: 'TAVILY_API_KEY', value: 'tvly-new' }])
		assert.ok(!res.captured.body.includes('tvly-new'), '响应体回显了写入的密钥')
	})

	it('拒绝非法引用名', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'POST', 'keys/value', { ref: '9bad-name', value: 'x' })
		assert.equal(res.captured.status, 400)
		assert.match(res.json().error, /引用名/u)
	})

	it('拒绝空密钥', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'POST', 'keys/value', { ref: 'TAVILY_API_KEY', value: '   ' })
		assert.equal(res.captured.status, 400)
		assert.match(res.json().error, /不能为空/u)
	})

	it('清除密钥后状态变为未配置', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'DELETE', 'keys/value', { ref: 'TAVILY_API_KEY' })
		assert.equal(res.json().ok, true)
		assert.equal(harness.state.credentials.TAVILY_API_KEY, undefined)
		assert.equal(res.json().keys[0].configured, false)
	})

	it('新增槽位时自动追加到配置', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'POST', 'keys', { ref: 'TAVILY_API_KEY_2' })
		assert.equal(res.json().ok, true)
		const setOp = harness.state.persisted.at(-1).ops[0]
		assert.deepEqual(setOp.value, ['TAVILY_API_KEY', 'TAVILY_API_KEY_2'])
	})

	it('移除槽位时保留至少一个槽位', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'DELETE', 'keys', { ref: 'TAVILY_API_KEY' })
		assert.equal(res.json().ok, true)
		assert.deepEqual(harness.state.persisted.at(-1).ops[0].value, ['TAVILY_API_KEY'])
	})
})

describe('路由：选项与用量', () => {
	it('保存选项时按类型校正', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'PUT', 'options', {
			options: { tavilyMaxResults: '99', tavilyBaseURL: 'https://x.test/', tavilyIncludeAnswer: false }
		})
		assert.equal(res.json().ok, true)
		const ops = harness.state.persisted[0].ops
		assert.deepEqual(ops.find((op) => op.path[0] === 'tavilyMaxResults').value, 20)
		assert.deepEqual(ops.find((op) => op.path[0] === 'tavilyBaseURL').value, 'https://x.test')
		assert.deepEqual(ops.find((op) => op.path[0] === 'tavilyIncludeAnswer').value, false)
	})

	it('空字符串表示恢复默认', async () => {
		const harness = makeRouter()
		await call(harness, 'PUT', 'options', { options: { tavilyBaseURL: '' } })
		assert.deepEqual(harness.state.persisted[0].ops, [{ op: 'unset', path: ['tavilyBaseURL'] }])
	})

	it('非法数字返回 400', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'PUT', 'options', { options: { tavilyTimeoutMs: 'abc' } })
		assert.equal(res.captured.status, 400)
	})

	it('用量查询逐密钥返回', async () => {
		const harness = makeRouter({
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				headers: new Headers(),
				json: async () => ({ account: { plan_usage: 3, plan_limit: 1000 } })
			})
		})
		const res = await call(harness, 'POST', 'keys/usage', {})
		const body = res.json()
		assert.equal(body.ok, true)
		assert.equal(body.usage.length, 1)
		assert.equal(body.usage[0].ok, true)
	})
})

describe('路由：接管', () => {
	it('把 web 行的 searchProvider 指向本插件，并保留 fetchProvider', async () => {
		const harness = makeRouter({ seamProvider: 'deepseek-official' })
		const res = await call(harness, 'POST', 'takeover', {})
		assert.equal(res.json().ok, true)
		assert.deepEqual(harness.state.editedWeb.at(-1), { fetchProvider: 'http', searchProvider: 'web-search-plus' })
	})

	it('交还官方搜索时写回显式提供方 id，而不是删掉字段', async () => {
		/*
		 * 这条以前断言「删除 searchProvider」，但那正是真实的联网搜索事故：
		 * 本插件始终把自己注册进 seam，删掉字段后注册表里就有两个可用提供方
		 * 而没有显式选择，宿主抛 WEB_PROVIDER_AMBIGUOUS，搜索整体不可用。
		 * 所以正确行为是写回官方默认提供方 id。
		 */
		const harness = makeRouter()
		await call(harness, 'POST', 'takeover', { target: 'default' })
		const applied = harness.state.editedWeb.at(-1)
		assert.equal(applied.searchProvider, 'deepseek-official', '必须显式写回官方提供方，不能留空')
		assert.equal(applied.fetchProvider, 'http', 'fetchProvider 必须保留')
	})

	it('交还官方搜索后不再是本插件接管', async () => {
		const harness = makeRouter({ seamProvider: 'web-search-plus' })
		await call(harness, 'POST', 'takeover', { target: 'default' })
		// 模拟宿主按新配置重载 seam：指向官方提供方。
		harness.ctx.web.searchProviderId = 'deepseek-official'
		const res = await call(harness, 'GET', '')
		assert.equal(res.json().takeover.active, false)
		assert.equal(res.json().takeover.seamProvider, 'deepseek-official')
	})

	it('配置有歧义时必须报警，而不是装作「自动选择」', async () => {
		/*
		 * 真实事故现场：删掉 searchProvider 后注册表里两个提供方并存且无显式选择，
		 * 宿主抛 WEB_PROVIDER_AMBIGUOUS，联网搜索整体不可用。
		 * 这种状态必须在快照里显式标出，否则界面会误导用户以为一切正常。
		 */
		const harness = makeRouter()
		// 本插件也在注册表里，形成两个可用提供方。
		harness.ctx.web.searchProviders.set('web-search-plus', {
			available: () => true,
			search: async () => ({ sources: [], truncated: false })
		})
		harness.ctx.web.searchProviderId = undefined
		const res = await call(harness, 'GET', '')
		const body = res.json()
		assert.equal(body.takeover.ambiguous, true, '应当标记为歧义状态')
		assert.deepEqual(body.takeover.registered, ['deepseek-official', 'web-search-plus'], '应当列出所有已注册提供方')
		assert.match(body.takeover.message, /不可用/u, '消息应说明搜索当前不可用')
		assert.ok(body.warnings.some((w) => /歧义|没有指定|多个/u.test(w)), '告警里必须提到这个问题')
	})

	it('没有 configEditor 时给出可操作的错误', async () => {
		const harness = makeRouter({ noConfigEditor: true })
		const res = await call(harness, 'POST', 'takeover', {})
		assert.equal(res.captured.status, 400)
		assert.match(res.json().error, /configEditor/u)
	})

	it('没有 web 条目时给出明确错误', async () => {
		const harness = makeRouter({ noWebEntry: true })
		const res = await call(harness, 'POST', 'takeover', {})
		assert.equal(res.captured.status, 400)
		assert.match(res.json().error, /web/u)
	})
})

describe('路由：探测', () => {
	it('报告命中的节点', async () => {
		const harness = makeRouter()
		const res = await call(harness, 'POST', 'probe', {})
		const body = res.json()
		assert.equal(body.ok, true)
		assert.equal(body.route, 'tavily')
		assert.equal(body.sourceCount, 1)
	})

	it('首选失败时报告回退路径', async () => {
		const harness = makeRouter({
			fetchImpl: async () => ({
				ok: false,
				status: 432,
				headers: new Headers(),
				json: async () => ({ detail: { error: 'plan limit' } })
			})
		})
		const res = await call(harness, 'POST', 'probe', {})
		const body = res.json()
		assert.equal(body.route, 'deepseek-official')
		assert.equal(body.attempts.length, 2)
		assert.equal(body.attempts[0].ok, false)
	})
})

describe('路由：降级路径', () => {
	it('没有 settings 时回退到 configEditor', async () => {
		const harness = makeRouter({ noSettings: true })
		const res = await call(harness, 'PUT', 'priority', { priority: ['deepseek-official'] })
		assert.equal(res.json().ok, true)
		assert.equal(harness.state.persisted.at(-1).ns, 'web-search-plus')
	})

	it('没有凭据服务时密钥写入给出可操作错误', async () => {
		const harness = makeRouter({ noCredentials: true })
		const res = await call(harness, 'POST', 'keys/value', { ref: 'TAVILY_API_KEY', value: 'x' })
		assert.equal(res.captured.status, 400)
		assert.match(res.json().error, /凭据服务/u)
	})

	it('DeepSeek 未注册时链路描述如实反映', async () => {
		const harness = makeRouter({ deepSeek: false })
		const res = await call(harness, 'GET', '')
		const node = res.json().chain.find((entry) => entry.node === 'deepseek-official')
		assert.equal(node.available, false)
	})
})
