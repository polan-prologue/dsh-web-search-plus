/**
 * dsh-web-search-plus —— 宿主半侧入口（「网页搜索++」）。
 *
 * ## 这个插件解决什么
 *
 * DSH 的联网搜索走 `ctx.web` seam，而 seam 只支持「按 id 固定选择一个提供方」：
 * 配置了 id 就只用它，没配置时若存在多个可用提供方则直接以 `WEB_PROVIDER_AMBIGUOUS`
 * 失败。官方组合固定使用 `deepseek-official`，因此用户无法表达「Tavily 优先，
 * DeepSeek 兜底」这类顺序。
 *
 * 本插件把顺序做成了第一等概念：它向 seam 注册**一个**提供方 `web-search-plus`，
 * 由这个提供方在内部按用户配置的顺序依次尝试真正的后端。于是：
 *
 *   - 「优先级」不再是 seam 的限制，而是本插件内部的一条链；
 *   - Tavily 侧可以配置**多个密钥**，在限流与额度耗尽时自动轮换；
 *   - 每个后端的配置仍归各自主人所有——DeepSeek 的密钥、账号令牌与端点继续沿用
 *     官方「网页搜索」设置页，本插件只是按顺序调用它。
 *
 * ## 装配
 *
 * 1. `ctx.web.registerSearchProvider(chain)` —— 注册链式提供方；
 * 2. `ctx.webServer` 存在时注册 `/api/dsh-web-search-plus` 路由族，供插件页读写配置；
 * 3. `ctx.settings` 存在时声明 `auto: false`，因为本插件自带设置界面。
 *
 * ## 不写会话事件
 *
 * 本插件不向 Session 追加任何自定义事件类型。宿主只接受已知类型或显式标记
 * `ignorable` 的事件，而 `Session.append()` 无法设置该标记，因此自定义事件会让
 * 会话日志无法重开。路由观测改走日志与插件页。
 *
 * @module dsh-web-search-plus
 */

import { readFileSync } from 'node:fs'

import { CHAIN_PROVIDER_ID, ChainSearchProvider } from './chain.js'
import { KeyRing, TavilySearchProvider } from './tavily.js'
import { Config, name, readConfig } from './schema.js'
import { createRouter, ROUTE_PREFIX } from './routes.js'

export { Config, name }
export { CHAIN_PROVIDER_ID, ROUTE_PREFIX }

/** 本插件硬依赖的服务：搜索 seam。其余服务按可用性可选接入。 */
export const inject = ['web']

/** 官方 DeepSeek 搜索提供方的注册 id —— 链上的 `deepseek-official` 节点就是它。 */
const DEEPSEEK_PROVIDER_ID = 'deepseek-official'

/**
 * 读取本包版本，用于在插件页显示。读不到时回退到占位值——版本号只用于展示，
 * 绝不能因为读不到而让插件加载失败。
 * @returns {string} 版本号。
 */
function readVersion() {
	try {
		const url = new URL('../package.json', import.meta.url)
		const parsed = JSON.parse(readFileSync(url, 'utf8'))
		return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
	} catch {
		return '0.0.0'
	}
}

/**
 * 插件入口。
 * @param {object} ctx - 插件上下文。
 * @param {object} config - 本插件的 Config（volatile 引用树，每次读取都取当前值）。
 */
export function apply(ctx, config) {
	// 路由层按「函数」使用版本（每次读取都取当前值），这里必须传函数本身。
	const version = readVersion

	/**
	 * 每次调用都重新读出当前配置的完整状态（归一化配置 + 告警）。
	 *
	 * 这是 volatile 字段的关键用法：设置页保存后 Loader 会就地更新这份引用树，
	 * 下一次搜索（乃至下一次可用性探测）立刻看到新值，无需重启插件，也不需要
	 * 重新注册提供方——重新注册会让 seam 的选择过程对用户可见地抖动。
	 *
	 * @returns {{ config: Record<string, unknown>, warnings: string[] }} 配置与告警。
	 */
	const readState = () => readConfig(config)

	/**
	 * 只要归一化后的配置本身。
	 *
	 * 刻意与 `readState` 分开：链路与 Tavily 节点只关心配置值，而路由层还要告警。
	 * 早先版本把两者混成一个返回 `{config, warnings}` 的函数，链路读到的是包装对象，
	 * `config.priority` 成了 `undefined`，`describe()` 里 `.map` 直接抛错——而单测因为
	 * 各自 mock 掉了对方的形状，谁都没发现。契约分开写，别再合回去。
	 *
	 * @returns {Record<string, unknown>} 归一化配置。
	 */
	const getConfig = () => readState().config

	/** 密钥轮换状态机；每次搜索前按当前配置同步槽位。 */
	const keyRing = new KeyRing()

	/**
	 * 解析一个密钥引用名的当前值。
	 *
	 * 每次都重新解析、绝不跨操作缓存——这是凭据域的约定，也是「在设置页写完密钥
	 * 下一次搜索立刻生效」的原因。解析失败按「未配置」处理，让其他槽位继续有机会。
	 *
	 * @param {string} ref - 凭据引用名。
	 * @returns {Promise<string | undefined>} 密钥明文，或未配置。
	 */
	async function resolveKey(ref) {
		const credentials = ctx.get('credentials')
		if (credentials !== undefined) {
			const resolved = await credentials.resolve(ref)
			const value = resolved?.value
			return typeof value === 'string' && value.length > 0 ? value : undefined
		}
		const fromEnv = process.env[ref]
		return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined
	}

	/**
	 * 取官方 DeepSeek 提供方实例。
	 *
	 * seam 的注册表就是提供方选择的真源，直接按 id 取实例可以完整复用官方的密钥解析、
	 * 账号令牌、端点配置与错误消息，避免本插件重复实现一份会与上游漂移的调用逻辑。
	 * 取不到时（官方行被禁用等）返回 `undefined`，由链把它记为「未注册」并继续下一个节点。
	 *
	 * @returns {object | undefined} 官方提供方实例。
	 */
	function getDeepSeek() {
		const registry = ctx.web?.searchProviders
		if (!(registry instanceof Map)) return undefined
		return registry.get(DEEPSEEK_PROVIDER_ID)
	}

	/** Tavily 节点（内含多密钥轮换）。 */
	const tavily = new TavilySearchProvider({ getConfig, resolveKey, keyRing })

	/**
	 * 记录一次路由观测——**只记提供方与耗时，不记任何密钥内容**。
	 *
	 * 这里刻意**不写会话日志**。宿主读取 Session 时要求每个事件要么属于它已知的事件类型，
	 * 要么显式带 `ignorable: true`；而 `Session.append()` 没有任何设置该标记的参数，
	 * 插件写出的自定义类型会让整个 Session 拒绝重开（「历史加载失败」）。
	 *
	 * 观测数据属于插件自有状态，不是模型要看到的对话事实，因此走日志与插件页，
	 * 绝不能混进会话事件流。
	 *
	 * @param {string} event - 事件名。
	 * @param {object} payload - 事件负载。
	 */
	function record(event, payload) {
		try {
			ctx.logger?.debug?.('网页搜索++：%s %s', event, JSON.stringify(payload))
		} catch {
			// 观测失败不影响搜索。
		}
	}

	/** 链式提供方——seam 实际选中的那一个。 */
	const chain = new ChainSearchProvider({ getConfig, tavily, getDeepSeek, record })

	// 1) 注册到搜索 seam。提供方随本插件 fiber 释放而注销。
	ctx.effect(() => ctx.web.registerSearchProvider(chain), 'web-search-plus: search provider')

	// 2) 管理路由：随 webServer 的可用性注册；没有 webServer 的组合（如 headless）
	//    仍然能用链路搜索，只是没有设置界面。路由层需要告警，因此传 readState。
	ctx.inject(['webServer'], (scope) => {
		scope.effect(() => scope.webServer.register({
			kind: 'prefix',
			path: ROUTE_PREFIX,
			/*
			 * ⚠️ 必须把 `scope` 一起传进去，不能只传根 `ctx`。
			 *
			 * `webServer` 与 `connection` 都是**在 scope 上才有**的服务：根 ctx 上没有
			 * `ctx.webServer`，`ctx.get('connection')` 也取不到。只传根 ctx 时，路由层的
			 * 来源校验永远读不到部署信息（绑定地址、origin、trustedHosts 全 undefined），
			 * 退化成「只认回环地址」——表现就是「服务器上安装成功，打开插件页报
			 * 拒绝来源不明的 Host」。
			 *
			 * 这正是 0.1.4 加了部署判据却依然失败的原因：**判据写对了，但读不到数据**。
			 */
			handler: createRouter({ ctx, scope, readState, tavily, keyRing, chain, version })
		}), 'web-search-plus: management routes')
	})

	// 3) 自带设置界面：关掉 schema 自动生成的页面，避免同一个插件出现两张表单。
	//
	// 这一步是**纯展示策略**，包在 try/catch 里：不同 DSH 版本的 settings 面可能不同
	// （或该实例已配置过），让一个「关掉自动页面」的失败把整个插件拖成 inactive，
	// 代价远大于收益——搜索链路本来与它无关。
	ctx.inject(['settings'], (scope) => {
		scope.effect(() => {
			try {
				if (typeof scope.settings?.configure !== 'function') return () => {}
				return scope.settings.configure({ auto: false }, scope.fiber)
			} catch (error) {
				ctx.logger?.warn?.('网页搜索++：未能关闭自动生成的设置页（%s）', String(error?.message ?? error))
				return () => {}
			}
		}, 'web-search-plus: page policy')
	})

	ctx.logger?.info?.(
		'网页搜索++ 已加载：当前优先级为 %s；接管状态见插件页。',
		getConfig().priority.join(' → ')
	)
}
