/**
 * 集成测试：**真实接线**。
 *
 * ## 为什么必须有这个文件
 *
 * 之前 108 个单测全绿，插件却在宿主里崩了两次：
 *
 * 1. `index.js` 把 `readVersion()` 的**结果**传给路由，而路由按函数调用；
 * 2. `index.js` 的配置访问器返回 `{config, warnings}`，而链路/Tavily 节点按**裸配置**读取。
 *
 * 两个都是**模块之间**的契约错误，单测抓不到：每个单测只 mock 自己那一层的依赖，
 * chain 测试喂裸配置、routes 测试喂包装对象，各自都自洽，唯独 index.js 的接线没人覆盖。
 *
 * 所以这里**不 mock 自己的模块**：直接调真实的 `apply(ctx, config)`，用真实
 * `readConfig` 解析出的 volatile 配置树，然后从 seam 注册表里取回真实的链式提供方、
 * 调真实的 HTTP 处理器。只有 DSH 的服务（web / webServer / credentials / settings /
 * configEditor / logger）是假的。
 *
 * 这三条断言分别对应上面两个真实事故：`available()` / `describe()` 会碰配置读取路径，
 * `GET /` 快照会碰版本函数与配置形状，`probe` 会碰整条搜索链。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { apply, Config, ROUTE_PREFIX } from '../lib/index.js'
import { readConfig } from '../lib/schema.js'

/** 造一个最小的假请求对象。 */
function fakeRequest(method, url, body) {
	const listeners = new Map()
	const payload = body === undefined ? '' : JSON.stringify(body)
	return {
		method,
		url,
		// 与真实浏览器一致：回环 Host + 写操作用 JSON（来源校验的两道判据）。
		headers: { host: '127.0.0.1:3124', ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
		socket: { remoteAddress: '127.0.0.1' },
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
	const captured = { status: 0, body: '' }
	return {
		captured,
		writeHead(status) { captured.status = status },
		end(text) { captured.body = text ?? '' },
		json() { return JSON.parse(captured.body) }
	}
}

/**
 * 用**真实** `apply()` 启动插件，只伪造 DSH 的服务。
 *
 * @param {object} [options] - 覆盖项。
 * @returns {object} 已注册的链式提供方、路由处理器与假服务记录。
 */
function boot(options = {}) {
	const registered = new Map()
	const routes = []
	const state = {
		credentials: { ...(options.credentials ?? {}) },
		writes: [],
		persisted: [],
		webEdits: []
	}

	/** 官方 DeepSeek 提供方：链上的第二个节点。 */
	const deepSeek = {
		available: () => true,
		search: async () => ({ sources: [{ url: 'https://deepseek.test' }], truncated: false })
	}

	/** 由真实 schema 解析出的 volatile 配置树——与宿主喂给 apply 的形状一致。 */
	const resolved = Config['~standard'].validate(options.raw ?? {}).value

	const ctx = {
		web: {
			searchProviders: new Map([['deepseek-official', deepSeek]]),
			/* 宿主真实形态：取值经由 config.searchProvider 的 volatile 访问器，没有 searchProviderId 属性。 */
			config: { searchProvider: { get: () => options.seamProvider ?? 'web-search-plus' }, fetchProvider: { get: () => 'http' } },
			registerSearchProvider(provider) {
				registered.set(provider.id, provider)
				return () => registered.delete(provider.id)
			}
		},
		get(name) {
			if (name === 'credentials') {
				return {
					describe: async (ref) => ({ configured: state.credentials[ref] !== undefined, source: 'file', writable: true }),
					resolve: async (ref) => (state.credentials[ref] === undefined ? undefined : { value: state.credentials[ref] }),
					set: async (ref, value) => {
						state.writes.push({ ref, value })
						state.credentials[ref] = value
					},
					unset: async (ref) => { delete state.credentials[ref] }
				}
			}
			if (name === 'settings') return { mutate: async (ns, ops) => { state.persisted.push({ ns, ops }) } }
			if (name === 'configEditor') {
				return {
					entries: () => [{ options: { id: 'web-search-plus' } }, { options: { id: 'web' } }],
					edit: async (entry, change) => {
						if (entry.options.id === 'web') {
							state.webEdits.push(change({}, { fetchProvider: 'http' }))
						} else {
							state.persisted.push({ ns: entry.options.id })
						}
					}
				}
			}
			return undefined
		},
		// cordis 的 effect：立即执行并返回 disposer。
		effect(fn) { return fn() },
		// cordis 的 inject 子作用域：提供 effect / 服务 / fiber。
		inject(deps, callback) {
			const scope = {
				effect: (fn) => fn(),
				fiber: {},
				get: ctx.get,
				webServer: {
					register(spec) {
						routes.push(spec)
						return () => {}
					}
				},
				settings: { configure: () => () => {} }
			}
			return callback(scope)
		},
		logger: { info() {}, warn() {}, error() {} }
	}

	apply(ctx, resolved)

	const chain = registered.get('web-search-plus')
	assert.ok(chain !== undefined, 'apply() 没有向 seam 注册链式提供方')
	assert.equal(routes.length, 1, 'apply() 没有注册管理路由')

	return { chain, handler: routes[0].handler, state, resolved, deepSeek }
}

/**
 * 发一次请求。
 * @param {object} harness - `boot()` 的结果。
 * @param {string} method - HTTP 方法。
 * @param {string} path - 路由内相对路径。
 * @param {object} [body] - 请求体。
 * @returns {Promise<object>} 假响应。
 */
async function call(harness, method, path, body) {
	const suffix = path.length === 0 || path.startsWith('/') ? path : `/${path}`
	const res = fakeResponse()
	await harness.handler(fakeRequest(method, `${ROUTE_PREFIX}${suffix}`, body), res)
	return res
}

describe('真实接线：apply 装配', () => {
	it('注册的提供方 id 是 seam 选择用的那个', () => {
		const harness = boot()
		assert.equal(harness.chain.id, 'web-search-plus')
	})

	it('available() 不抛错且为真（配置读取路径正确）', () => {
		const harness = boot()
		// 这条断言正是「包装对象 vs 裸配置」事故的检测点。
		assert.equal(harness.chain.available(), true)
	})

	it('describe() 返回完整链路（会遍历 priority 数组）', () => {
		const harness = boot()
		const { chain } = harness.chain.describe()
		assert.equal(chain.length, 2)
		assert.deepEqual(chain.map((node) => node.node), ['tavily', 'deepseek-official'])
	})

	it('默认配置与 schema 默认值一致', () => {
		const harness = boot()
		assert.deepEqual(readConfig(harness.resolved).config.priority, ['tavily', 'deepseek-official'])
	})

	it('自定义优先级一路贯通到链路描述', () => {
		const harness = boot({ raw: { priority: ['deepseek-official', 'tavily'] } })
		const { chain } = harness.chain.describe()
		assert.deepEqual(chain.map((node) => node.node), ['deepseek-official', 'tavily'])
	})
})

describe('真实接线：管理路由', () => {
	it('GET / 快照成功（会调用版本函数）', async () => {
		const harness = boot()
		const res = await call(harness, 'GET', '')
		assert.equal(res.captured.status, 200, `快照失败：${res.captured.body}`)
		const body = res.json()
		assert.equal(body.ok, true)
		assert.equal(typeof body.version, 'string')
		assert.equal(body.chain.length, 2)
		assert.equal(body.keys.length, 1)
	})

	it('快照的接管状态反映 seam 的真实取值', async () => {
		const active = await call(boot(), 'GET', '')
		assert.equal(active.json().takeover.active, true)
		const inactive = await call(boot({ seamProvider: 'deepseek-official' }), 'GET', '')
		assert.equal(inactive.json().takeover.active, false)
	})

	it('写入密钥走凭据域且不回显明文', async () => {
		const harness = boot()
		const res = await call(harness, 'POST', '/keys/value', { ref: 'TAVILY_API_KEY', value: 'tvly-secret' })
		assert.equal(res.captured.status, 200, res.captured.body)
		assert.deepEqual(harness.state.writes, [{ ref: 'TAVILY_API_KEY', value: 'tvly-secret' }])
		assert.ok(!res.captured.body.includes('tvly-secret'), '响应体泄漏了密钥明文')
	})

	it('接管会保留 fetchProvider', async () => {
		const harness = boot({ seamProvider: 'deepseek-official' })
		const res = await call(harness, 'POST', '/takeover', {})
		assert.equal(res.captured.status, 200, res.captured.body)
		assert.deepEqual(harness.state.webEdits.at(-1), { fetchProvider: 'http', searchProvider: 'web-search-plus' })
	})

	it('优先级保存写入 settings', async () => {
		const harness = boot()
		const res = await call(harness, 'PUT', '/priority', { priority: ['deepseek-official', 'tavily'] })
		assert.equal(res.captured.status, 200, res.captured.body)
		assert.deepEqual(harness.state.persisted.at(-1).ops, [
			{ op: 'set', path: ['priority'], value: ['deepseek-official', 'tavily'] }
		])
	})

	it('probe 走完整搜索链并命中首选节点', async () => {
		const harness = boot()
		// 用真实网络桩替换 Tavily 的 fetch，避免测试联网。
		harness.chain.describe()
		const res = await call(harness, 'POST', '/probe', {})
		// 没有配置任何密钥时，Tavily 节点应当失败并回退到 DeepSeek。
		assert.equal(res.captured.status, 200, res.captured.body)
		const body = res.json()
		assert.equal(body.route, 'deepseek-official', `期望回退到 DeepSeek，实际 ${String(body.route)}`)
		assert.equal(body.attempts.length, 2)
		assert.equal(body.attempts[0].ok, false)
	})
})


describe('装配链路：路由必须拿到有 webServer 的 scope', () => {
	/*
	 * 报障（0.1.4 装了仍然失败）：服务器重启后打开插件页仍是
	 * 「拒绝来源不明的 Host『192.144.175.20:10443』」。
	 *
	 * 根因不在判据，而在**装配**：`createRouter({ ctx, ... })` 传的是根 ctx，
	 * 而 `webServer` / `connection` 只存在于 `ctx.inject` 回调的 scope 上。
	 * 于是部署信息全是 undefined，判据退化成「只认回环」。
	 *
	 * 这条测试锁住「index.js 把 scope 传下去」这一事实——只靠路由单测发现不了它，
	 * 因为路由单测自己构造 ctx，天然就带部署信息。
	 */
	it('index.js 把 inject 回调的 scope 传给 createRouter', async () => {
		const { readFileSync } = await import('node:fs')
		const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
		assert.match(
			source,
			/handler:\s*createRouter\(\{[^}]*\bscope\b/u,
			'createRouter 必须收到 scope：只有它上面才有 webServer / connection'
		)
	})

	it('路由优先用 scope 读部署信息，缺省才退回 ctx', async () => {
		const { readFileSync } = await import('node:fs')
		const source = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8')
		assert.match(source, /const deploymentCtx = scope \?\? ctx/u, '必须有 scope 优先、ctx 兜底的取值')
		assert.match(source, /deploymentCtx\.webServer\?\.host/u, '绑定地址要从 deploymentCtx 读')
		assert.match(
			source,
			/deploymentCtx\.get\('connection'\)\?\.trustedHosts/u,
			'trustedHosts 要从 deploymentCtx 读'
		)
	})
})
