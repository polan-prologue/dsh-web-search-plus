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
function fakeRequest(method, url, body, remoteAddress = '127.0.0.1', headers) {
	const listeners = new Map()
	const payload = body === undefined ? '' : JSON.stringify(body)
	/*
	 * 默认头必须与「浏览器里插件页自己发请求」一致：
	 * - `host` 是回环地址（来源校验第一关）；
	 * - 写操作带 `content-type: application/json`（第三关）。
	 *
	 * 早先这里完全没有 headers，来源校验一上线就所有用例集体 403——
	 * 说明夹具比真实请求宽松（真实浏览器永远会带 Host）。
	 * 需要构造恶意请求的用例通过第 5 个参数显式覆盖。
	 */
	const merged = {
		host: '127.0.0.1:3124',
		...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
		...headers
	}
	return {
		method,
		url,
		headers: merged,
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
				seam.value = next.searchProvider
				return
			}
			state.persisted.push({ ns: entry.options.id, change })
		}
	}

	const seam = { value: options.seamProvider ?? 'web-search-plus' }
	const ctx = {
		web: {
			searchProviders: registry,
			/*
			 * seam 的真实形态：取值只经由 ctx.web.config.searchProvider 的 volatile
			 * 访问器（见 @deepseek-ai/dsh-web 的 WebRuntime.search()）。必须照抄这个
			 * 形状——旧夹具伪造了宿主根本不存在的 searchProviderId 属性，于是
			 * 「读到 undefined → 误报未接管」这个真实 bug 在测试里永远是绿的。
			 */
			config: { searchProvider: { get: () => seam.value }, fetchProvider: { get: () => 'http' } }
		},
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
	return { handler, state, keyRing, ctx, seam }
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

describe('路由：来源校验（挡浏览器里的恶意页面）', () => {
	/*
	 * 实测背景（加这层之前三条全部成立）：
	 * 插件路由不经过宿主会话鉴权（宿主接口 401，插件接口 200），于是 isLoopback()
	 * 只能证明「请求来自本机进程」，挡不住用户浏览器里**任意页面**的 fetch。
	 *
	 * 每条用例都是当时真实打通的攻击路径，现在必须 403。
	 */
	/**
	 * 发一个请求并带上伪造的头。
	 * @param {object} harness - 路由夹具。
	 * @param {string} method - 方法。
	 * @param {string} path - 子路径。
	 * @param {object} body - 请求体。
	 * @param {object} headers - 覆盖的头。
	 * @returns {Promise<object>} 响应。
	 */
	async function callWith(harness, method, path, body, headers, deployment) {
		const suffix = path.length === 0 || path.startsWith('/') ? path : '/' + path
		const res = fakeResponse()
		await harness.handler(fakeRequest(method, ROUTE_PREFIX + suffix, body, '127.0.0.1', headers), res, deployment)
		return res
	}

	it('伪造 Host（DNS rebinding）被拒绝，且不回显密钥', async () => {
		const harness = makeRouter({ credentials: { TAVILY_API_KEY: 'tvly-secret-xyz' } })
		const res = await callWith(harness, 'POST', 'keys/value/reveal', { ref: 'TAVILY_API_KEY' }, { host: 'evil.example.com' })
		assert.equal(res.captured.status, 403)
		assert.ok(!String(res.captured.body).includes('tvly-secret-xyz'), '拒绝响应里泄漏了明文')
	})

	it('跨源 Origin 被拒绝', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'POST', 'keys/value/reveal', { ref: 'TAVILY_API_KEY' }, { origin: 'https://evil.example.com' })
		assert.equal(res.captured.status, 403)
	})

	it('同源 Origin 放行（页面自己调自己）', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'GET', '', undefined, { origin: 'http://127.0.0.1:3124' })
		assert.equal(res.captured.status, 200)
	})

	it('跨站 text/plain POST 被拒绝（CORS 简单请求免预检的那条路）', async () => {
		const harness = makeRouter({ credentials: { TAVILY_API_KEY: 'tvly-secret-xyz' } })
		const res = await callWith(harness, 'POST', 'keys/value/reveal', { ref: 'TAVILY_API_KEY' }, { 'content-type': 'text/plain' })
		assert.equal(res.captured.status, 403)
		assert.ok(!String(res.captured.body).includes('tvly-secret-xyz'), '简单请求路径泄漏了明文')
	})

	it('form-urlencoded 同样被拒绝', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'POST', 'keys/value', { ref: 'TAVILY_API_KEY', value: 'x' }, { 'content-type': 'application/x-www-form-urlencoded' })
		assert.equal(res.captured.status, 403)
	})

	it('本机脚本（无 Origin、带 JSON）照常可用', async () => {
		// 这一条保证我们没把正常的本地工具链一起挡掉。
		const harness = makeRouter({})
		const res = await callWith(harness, 'POST', 'keys/reset', {}, {})
		assert.equal(res.captured.status, 200)
	})

/*
	 * 报障：DSH 部署在服务器上、经公网 IP 访问时，插件页报
	 * 「读取失败：只接受 Host 为本机回环地址的请求（收到『192.144.175.20:10443』）」。
	 *
	 * 第一版把 Host 写死成回环地址，等于把「远程部署」这种正常用法全挡了。
	 * 现在按宿主 isTrustedApiRequest 的判据：回环、绑定地址字面量、或部署 origin 的
	 * authority 都算「自己人」；跨站判据仍然照旧生效。
	 */
	it('服务器部署：Host 等于绑定地址时放行', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'GET', '', undefined, { host: '192.144.175.20:10443' }, {
			binding: '192.144.175.20',
			origin: 'http://192.144.175.20:10443'
		})
		assert.equal(res.captured.status, 200, '远程部署的正常请求不能被挡')
	})

	it('服务器部署：Host 等于部署 origin 的 authority 时放行（反代/域名）', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'GET', '', undefined, { host: 'dsh.example.com' }, {
			origin: 'https://dsh.example.com'
		})
		assert.equal(res.captured.status, 200)
	})

	it('服务器部署：伪造 Host 仍然被拒（不能因为放宽就失守）', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'GET', '', undefined, { host: 'evil.example.com' }, {
			binding: '192.144.175.20',
			origin: 'http://192.144.175.20:10443'
		})
		assert.equal(res.captured.status, 403, '放宽到绑定地址后，陌生 Host 仍必须被拒')
	})

	it('服务器部署：跨站 Origin 仍然被拒', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'GET', '', undefined, {
			host: '192.144.175.20:10443',
			origin: 'https://evil.example.com'
		}, { binding: '192.144.175.20' })
		assert.equal(res.captured.status, 403)
	})

	it('https 部署下，同源 Origin 带 scheme 也能通过', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'GET', '', undefined, {
			host: 'dsh.example.com',
			origin: 'https://dsh.example.com'
		}, { origin: 'https://dsh.example.com' })
		assert.equal(res.captured.status, 200, 'Host 不带 scheme，Origin 带 https，应视为同源')
	})

	/*
	 * 报障（0.1.4 仍然失败）：服务器上「webserver 绑 127.0.0.1 + 反向代理对外」，
	 * 浏览器发来的 Host 是公网地址，既不等于绑定地址也不等于 origin，于是照样 403。
	 *
	 * 正解是读宿主 connection.trustedHosts（--trusted-host 声明的 authority），
	 * 与宿主 isTrustedApiRequest() 完全同源。
	 */
	it('trustedHosts 声明了公网 authority 时放行（反代部署的正解）', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'GET', '', undefined, { host: '192.144.175.20:10443' }, {
			binding: '127.0.0.1',
			trustedHosts: ['192.144.175.20:10443']
		})
		assert.equal(res.captured.status, 200, '宿主已声明该 authority，插件必须认')
	})

	it('trustedHosts 带端口时不做通配（端口不符仍拒绝）', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'GET', '', undefined, { host: '192.144.175.20:9999' }, {
			binding: '127.0.0.1',
			trustedHosts: ['192.144.175.20:10443']
		})
		assert.equal(res.captured.status, 403, '带端口的条目必须精确匹配')
	})

	it('trustedHosts 不带端口时匹配任意端口', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'GET', '', undefined, { host: 'dsh.example.com:8443' }, {
			binding: '127.0.0.1',
			trustedHosts: ['dsh.example.com']
		})
		assert.equal(res.captured.status, 200, '无端口条目按任意端口匹配（与宿主一致）')
	})

	it('trustedHosts 只放行声明过的，其余仍拒绝', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'GET', '', undefined, { host: 'other.example.com' }, {
			binding: '127.0.0.1',
			trustedHosts: ['dsh.example.com']
		})
		assert.equal(res.captured.status, 403)
	})

	it('trustedHosts 放行后，跨源 Origin 仍然被拒', async () => {
		const harness = makeRouter({})
		const res = await callWith(harness, 'GET', '', undefined, {
			host: '192.144.175.20:10443',
			origin: 'https://evil.example.com'
		}, { binding: '127.0.0.1', trustedHosts: ['192.144.175.20:10443'] })
		assert.equal(res.captured.status, 403, 'Host 放行不能连带放宽 Origin')
	})
	it('读不到 webServer 部署信息时退化为只认回环，不放宽', async () => {
		const harness = makeRouter({})
		const localhost = await callWith(harness, 'GET', '', undefined, { host: '127.0.0.1:3124' }, {})
		assert.equal(localhost.captured.status, 200)
		const remote = await callWith(harness, 'GET', '', undefined, { host: '192.144.175.20:10443' }, {})
		assert.equal(remote.captured.status, 403, '没有部署信息时不得凭空信任任何公网 Host')
	})
	it('sec-fetch-site: cross-site 被拒绝（不依赖 Host 白名单的纵深判据）', async () => {
		/*
		 * 这条与 Host 白名单**故意重复**：白名单若哪天被放宽（远程访问、改监听地址），
		 * 这条仍然拦得住跨站请求。宿主 isTrustedApiRequest 也有同一判据。
		 */
		const harness = makeRouter({ credentials: { TAVILY_API_KEY: 'tvly-secret-xyz' } })
		const res = await callWith(harness, 'POST', 'keys/value/reveal', { ref: 'TAVILY_API_KEY' }, {
			'sec-fetch-site': 'cross-site'
		})
		assert.equal(res.captured.status, 403)
		assert.ok(!String(res.captured.body).includes('tvly-secret-xyz'), '跨站标记路径泄漏了明文')
	})

	it('同源页面（same-origin）与非浏览器客户端（无该头）都放行', async () => {
		const harness = makeRouter({})
		const sameOrigin = await callWith(harness, 'GET', '', undefined, { 'sec-fetch-site': 'same-origin' })
		assert.equal(sameOrigin.captured.status, 200, '同源页面不能被误伤')
		// curl / 脚本根本不发 sec-fetch-site，必须照常可用。
		const script = await callWith(harness, 'GET', '', undefined, {})
		assert.equal(script.captured.status, 200, '无 sec-fetch-site 的客户端（curl）不能被误伤')
	})

	it('来源校验先于路由解析：未知路径的伪造请求也是 403 而不是 404', async () => {
		// 顺序很重要——先挡来源，避免用 404/405 的差异去探测有哪些端点。
		const harness = makeRouter({})
		const res = await callWith(harness, 'POST', 'nonexistent', {}, { host: 'evil.example.com' })
		assert.equal(res.captured.status, 403)
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
		harness.seam.value = 'deepseek-official'
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
		harness.seam.value = undefined
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
	/*
	 * 报障：「点击【交还官方搜索】再点击【试一次搜索】，搜索结果是按当前使用优先级来判定的；
	 * 正确的是交还后不再考虑优先级，默认切回官方搜索」。
	 *
	 * 真实缺陷：probe 路由无条件调用 chain.searchWithReport()，完全不看 seam 现在选了谁。
	 * 于是交还之后 seam 已是 deepseek-official，探测却仍按 tavily → deepseek 的顺序跑，
	 * 并把「Tavily 命中」显示给用户 —— 与「尚未接管」的状态自相矛盾。
	 * 现在 probe 与 snapshot 共用同一个 currentSeamProvider() 判据。
	 */
	it('已交还官方搜索时，探测不再走优先级链，而是走 seam 当前选中的提供方', async () => {
		const harness = makeRouter({ seamProvider: 'deepseek-official' })
		const res = await call(harness, 'POST', 'probe', {})
		const body = res.json()
		assert.equal(body.ok, true)
		assert.equal(body.takenOver, false, '未接管时必须如实报告 takenOver=false')
		assert.equal(body.seamProvider, 'deepseek-official')
		assert.equal(body.route, undefined, '未接管时不该报告「经优先级链命中了某个节点」')
		assert.equal(body.attempts.length, 1, '未接管时只有 seam 那一个提供方的尝试')
		assert.equal(body.attempts[0].node, 'deepseek-official', '未接管时应走官方提供方')
		assert.match(String(body.attempts[0].reason), /未走本插件的优先级链/, '要说明为什么没走链路')
		assert.ok(!body.attempts.some((attempt) => attempt.node === 'tavily'), '交还后不得再按优先级链调用 tavily')
	})

	it('已接管时，探测仍然报告优先级链命中的节点', async () => {
		const harness = makeRouter({ seamProvider: 'web-search-plus' })
		const body = (await call(harness, 'POST', 'probe', {})).json()
		assert.equal(body.takenOver, true)
		assert.equal(body.route, 'tavily')

	/*
	 * seam 被指到别的第三方提供方时，本插件**不能拿官方结果冒充**。
	 * 宁可报错并说清怎么回到优先级链，也不能显示一条「探测成功」的假结论。
	 */
	it('seam 指向其它提供方时，探测如实报错而不是拿官方结果顶替', async () => {
		const harness = makeRouter({ seamProvider: 'deepseek-search-api' })
		const res = await call(harness, 'POST', 'probe', {})
		const body = res.json()
		assert.equal(body.ok, false, '不能伪装成功')
		assert.match(String(body.error), /只能代跑官方 DeepSeek/, '要说明为什么不能代跑')
		assert.match(String(body.error), /立即接管/, '要给出回到优先级链的出路')
	})	})
})
describe('路由：读取已保存密钥的明文（reveal）', () => {
	/*
	 * 报障：「保存过的密钥没法点小眼睛显示」。
	 *
	 * 快照（GET /）依然**绝不**包含明文；要看得明文只能走这个专用端点。它必须
	 * 同时满足：只回配置里真实存在的槽位、非法引用名直接拒、每次只回一个。
	 */
	it('返回已保存密钥的明文，且带 no-store', async () => {
		const harness = makeRouter({ credentials: { TAVILY_API_KEY: 'tvly-saved-123' } })
		const res = await call(harness, 'POST', 'keys/value/reveal', { ref: 'TAVILY_API_KEY' })
		assert.equal(res.captured.status, 200, res.captured.body)
		assert.equal(res.json().value, 'tvly-saved-123', '应回明文供用户核对')
		assert.match(String(res.captured.headers['cache-control']), /no-store/, '明文不能进任何缓存')
	})

	it('快照本身仍然不含明文', async () => {
		const harness = makeRouter({ credentials: { TAVILY_API_KEY: 'tvly-saved-123' } })
		const body = (await call(harness, 'GET', '')).json()
		assert.ok(!JSON.stringify(body).includes('tvly-saved-123'), '快照泄漏了明文')
	})

	it('只回配置里存在的槽位，未知引用名 404', async () => {
		const harness = makeRouter({ credentials: { TAVILY_API_KEY: 'tvly-a' } })
		const res = await call(harness, 'POST', 'keys/value/reveal', { ref: 'SOME_OTHER_KEY' })
		assert.equal(res.captured.status, 404, res.captured.body)
	})

	it('非法引用名直接 400，不做任何解析', async () => {
		const harness = makeRouter({})
		const res = await call(harness, 'POST', 'keys/value/reveal', { ref: '../etc/passwd' })
		assert.equal(res.captured.status, 400, res.captured.body)
	})

	it('未配置的槽位 404，而不是回空串', async () => {
		// 夹具默认预置一把密钥，这里显式清空以验证「未配置」分支。
		const harness = makeRouter({ credentials: {} })
		const res = await call(harness, 'POST', 'keys/value/reveal', { ref: 'TAVILY_API_KEY' })
		assert.equal(res.captured.status, 404, res.captured.body)
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
