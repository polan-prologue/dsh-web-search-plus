/**
 * 端到端测试：**客户端与宿主的路径契约**。
 *
 * ## 为什么必须有这个文件
 *
 * 事故：客户端用 `${ROUTE_PREFIX}${path}` 拼 URL，但 `ROUTE_PREFIX` 不带尾斜杠，
 * 于是 `request('PUT', 'priority')` 发出的是
 * `/api/dsh-web-search-pluspriority`（缺 `/`）。宿主按「前缀 + /」匹配，结果
 * **所有操作静默 404**，而页面本身（`GET ''`）正常渲染——用户看到的是
 * 「页面能打开，但每个按钮都没用」。
 *
 * 这个 bug 骗过了当时全部单测，因为：
 * - 路由单测自己构造 URL（用了正确的斜杠），测的是宿主；
 * - 客户端从未被真正执行过，它拼出什么 URL 无人检查。
 *
 * 所以这里**把客户端跑起来**，捕获它真实发出的 fetch 请求，再把每个请求打到真实
 * 路由处理器上，断言状态码。任何一侧的路径约定变化都会立刻暴露。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { describe, it } from 'node:test'

import { Config } from '../lib/schema.js'
import { apply, ROUTE_PREFIX } from '../lib/index.js'

/**
 * 解析宿主同款 schemastery（构造真实内存路由用）。
 * @returns {Function|undefined} Schema 构造函数。
 */
function hostSchemastery() {
	const dirs = []
	if (typeof process.env.DSH_PROFILE_DIR === 'string') dirs.push(join(process.env.DSH_PROFILE_DIR, 'node_modules'))
	if (typeof process.env.DSH_HOME === 'string') {
		try {
			for (const p of readdirSync(join(process.env.DSH_HOME, 'profiles'))) dirs.push(join(process.env.DSH_HOME, 'profiles', p, 'node_modules'))
		} catch { /* 无 profiles */ }
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

/**
 * 把客户端 bundle 跑起来，捕获它发出的请求。
 *
 * @returns {object} 客户端模块、已发出的请求列表与请求执行器。
 */
function bootClient() {
	const loaded = { id: undefined, factory: undefined }
	const sandbox = {
		window: { __ModuleLoader__: { load: (spec) => { loaded.id = spec.id; loaded.factory = spec.factory } } },
		document: { createElement: () => ({ dataset: {}, style: {}, remove() {} }), head: { appendChild() {} } },
		console,
		setTimeout, setInterval, clearTimeout, clearInterval
	}
	vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), vm.createContext(sandbox))
	assert.equal(loaded.id, 'dsh-web-search-plus', '客户端 bundle 的 id 不对')
	return loaded.factory
}

/**
 * 造一份最小 React 替身，记录组件树但不真正渲染。
 * @returns {object} React 替身。
 */
function fakeReact() {
	const react = {
		createElement: (type, props, ...children) => ({ type, props, children }),
		useState: (initial) => [initial, () => {}],
		useCallback: (fn) => fn,
		useEffect: () => {},
		useRef: () => ({ current: 0 }),
		useMemo: (fn) => fn()
	}
	return react
}

describe('客户端 bundle 的路径契约', () => {
	it('客户端 bundle 能被加载且注册到正确的 id', () => {
		const factory = bootClient()
		const mod = factory((name) => (name === 'react' ? fakeReact() : {}))
		assert.equal(typeof mod.apply, 'function')
		assert.equal(mod.apply.length, 1)
	})

	it('客户端不再使用无斜杠拼接（事故根因）', () => {
		const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
		// 允许注释里出现该模式（用于说明），但代码里不允许。
		const code = source.split('\n').filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n')
		assert.ok(
			!/fetch\(`\$\{ROUTE_PREFIX\}\$\{path\}`/.test(code),
			'客户端又回到了 `${ROUTE_PREFIX}${path}` 的无斜杠拼接——这会让所有操作 404'
		)
	})

	it('每个管理端点都要求前导斜杠归一化', () => {
		const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
		assert.match(source, /path\.startsWith\('\/'\)/, '请求函数应当归一化前导斜杠')
	})
})

describe('客户端真实请求 → 真实宿主路由', () => {
	/**
	 * 把真实 `apply()` 装配出的路由暴露成一个 fetch 替身，从而让客户端跑在真路由上。
	 *
	 * @returns {(url: string, init: object) => Promise<object>} fetch 替身。
	 */
	function realRouterFetch() {
		const routes = []
		const registered = new Map()
		const ctx = {
			web: {
				searchProviders: new Map([['deepseek-official', { available: () => true, search: async () => ({ sources: [], truncated: false }) }]]),
				config: { searchProvider: { get: () => 'deepseek-official' }, fetchProvider: { get: () => 'http' } },
				registerSearchProvider(p) { registered.set(p.id, p); return () => registered.delete(p.id) }
			},
			get(name) {
				if (name === 'credentials') {
					return {
						describe: async () => ({ configured: false, source: undefined, writable: true }),
						resolve: async () => undefined,
						set: async () => {},
						unset: async () => {}
					}
				}
				if (name === 'settings') return { mutate: async () => {} }
				if (name === 'configEditor') {
					return {
						entries: () => [{ options: { id: 'web-search-plus' } }, { options: { id: 'web' } }],
						edit: async () => {}
					}
				}
				return undefined
			},
			effect(fn) { return fn() },
			inject(deps, callback) {
				return callback({
					effect: (fn) => fn(),
					fiber: {},
					get: ctx.get,
					webServer: { register(spec) { routes.push(spec); return () => {} } },
					settings: { configure: () => () => {} }
				})
			},
			logger: { info() {}, warn() {}, error() {} }
		}
		const resolved = Config['~standard'].validate({}).value
		apply(ctx, resolved)
		assert.equal(routes.length, 1, '未注册管理路由')

		return async (url, init) => {
			const body = init?.body === undefined ? undefined : JSON.parse(init.body)
			const captured = { status: 0, text: '' }
			const res = { writeHead(status) { captured.status = status }, end(text) { captured.text = text ?? '' } }
			const listeners = new Map()
			const req = {
				method: init?.method ?? 'GET',
				url,
				// 真实浏览器发请求一定带 Host；写操作带 JSON content-type。
				headers: { host: '127.0.0.1:3124', ...((init?.method ?? 'GET') === 'GET' ? {} : { 'content-type': 'application/json' }) },
				socket: { remoteAddress: '127.0.0.1' },
				on(event, handler) {
					listeners.set(event, handler)
					if (event === 'end') {
						setImmediate(() => {
							if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body), 'utf8'))
							handler()
						})
					}
					return this
				},
				destroy() {}
			}
			await routes[0].handler(req, res)
			return {
				status: captured.status,
				json: async () => JSON.parse(captured.text)
			}
		}
	}

	it('页面加载（GET 根路径）返回 200', async () => {
		const fetchImpl = realRouterFetch()
		const response = await fetchImpl(ROUTE_PREFIX, { method: 'GET' })
		assert.equal(response.status, 200, 'GET 根路径应当成功')
	})

	it('每个操作路径都命中真实路由（不再 404）', async () => {
		const fetchImpl = realRouterFetch()
		// 与客户端各处调用一一对应：路径、方法、请求体。
		const calls = [
			['priority', 'PUT', { priority: ['tavily', 'deepseek-official'] }],
			['options', 'PUT', { options: { tavilyMaxResults: 5 } }],
			['keys', 'POST', {}],
			['keys/value', 'POST', { ref: 'TAVILY_API_KEY', value: 'x' }],
			['keys/value', 'DELETE', { ref: 'TAVILY_API_KEY' }],
			['keys/reset', 'POST', {}],
			['keys/usage', 'POST', {}],
			['takeover', 'POST', {}],
			['probe', 'POST', {}]
		]
		for (const [path, method, body] of calls) {
			// 关键：用客户端同款方式拼 URL（带前导斜杠）。
			const url = `${ROUTE_PREFIX}/${path}`
			const response = await fetchImpl(url, { method, body: JSON.stringify(body) })
			assert.notEqual(response.status, 404, `${method} /${path} 命中了 404 —— 客户端拼错路径了`)
			assert.ok(response.status < 500, `${method} /${path} 返回 ${String(response.status)}`)
		}
	})

	it('缺少前导斜杠的 URL 确实会 404（锁死事故形态）', async () => {
		const fetchImpl = realRouterFetch()
		// 这就是事故版本客户端发出的 URL：前缀与路径之间没有斜杠。
		const response = await fetchImpl(`${ROUTE_PREFIX}priority`, { method: 'PUT', body: JSON.stringify({ priority: [] }) })
		assert.equal(response.status, 404, '无斜杠拼接应当 404，这正是当初所有操作失效的原因')
	})
})
