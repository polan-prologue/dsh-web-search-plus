/**
 * dsh-web-search-plus —— 浏览器半侧（插件页 → 官方分组 → 「网页搜索++」）。
 *
 * 这是一个由 `window.__ModuleLoader__.load` 注册的 CJS 形态 bundle：外壳按
 * `package.json` 的 `dsh.client` 声明把它送进浏览器，页面再把它注册进「体验优化」
 * 设置平台的子插槽 `experience-plus.item`——与平台自己的功能卡片并列，统一归入
 * 「体验优化」分区。平台不可用时退回内核「内置插件」页的 `plugins.item` 插槽，
 * 保证设置卡片在任何 DSH 版本上都够得着（见 `registerSettingsCard`）。
 *
 * 设计取舍：页面**不**使用宿主的共享设置表单（`configForms`），而是直接跟本插件的
 * `web-search-plus` 路由族对话。原因是这一页要表达的是「有序的优先级链 + 多个带运行时
 * 状态的密钥槽位」，这两者都不是「一张 Config 表单」能投影出来的形状；密钥明文也
 * 从不经过设置文档，而是走凭据域。
 *
 * @module dsh-web-search-plus/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-web-search-plus',
	factory: (require) => {
		const react = require('react')
		const h = react.createElement

		/** 本插件的管理路由前缀。 */
		const ROUTE_PREFIX = '/api/dsh-web-search-plus'
		/** 字典命名空间。 */
		const NS = 'settings.webSearchPlus'
		/** Tavily 控制台：注册后可复制 API Key。 */
		const TAVILY_HOME_URL = 'https://app.tavily.com/home'
		/**
		 * 「已保存密钥」的占位点阵。
		 *
		 * 固定长度、不含任何真实信息：宿主从不回传已保存密钥的字面值，所以这里既不是
		 * 密钥内容也不是它的长度，只是「此槽位已配置」的视觉提示。
		 */
		const SAVED_KEY_MASK = '••••••••••••••••'

		/** 提供方的展示文案（与宿主 `PROVIDER_LABELS` 保持一致）。 */
		const PROVIDER_LABELS = {
			tavily: 'Tavily 搜索（第三方）',
			'deepseek-official': 'DeepSeek 原生搜索'
		}
		/** 提供方的一句话说明。 */
		const PROVIDER_HINTS = {
			tavily: '第三方搜索服务，可为它配置多个密钥以分摊免费额度上限。',
			'deepseek-official': '官方提供方，沿用「网页搜索」页里的密钥、账号与接口地址。'
		}

		/** 字典：中英双语。 */
		const zh = {
			title: '网页搜索++',
			summary: '配置联网搜索的提供方与使用顺序（可用多个 Tavily 密钥轮换）',
			priorityTitle: '使用优先级',
			priorityHint: '从上到下依次尝试；前一个失败时自动改用下一个。',
			moveUp: '上移',
			moveDown: '下移',
			keysTitle: 'Tavily 密钥',
			keysHint: '密钥只写入凭据域，不写入设置文件，也不会出现在任何响应里。命中限流或额度耗尽时会自动改用下一个可用密钥。',
			addKey: '添加密钥槽位',
			removeKey: '移除',
			keyApplyHint: '注册账号即可复制 API Key，免费额度包含 1000 Credits。',
			keyApplyLink: '获取 API Key',
			keyRef: '凭据名',
			keyValue: '密钥值',
			keyValueHint: '留空表示保持当前值不变。',
			keyShow: '显示密钥',
			keyHide: '隐藏密钥',
			keyRevealHint: '该槽位还没有密钥。',
			keyShowStored: '查看已保存的密钥',
			revealing: '读取中…',
			keySave: '保存密钥',
			keyClear: '清除密钥',
			keyConfigured: '已配置',
			keyMissing: '未配置',
			keyUnwritable: '由环境变量提供，无法从此处覆盖',
			stateReady: '可用',
			stateInvalid: '已失效',
			stateCooldown: '冷却中',
			stateMissing: '未配置',
			sticky: '正在使用',
			optionsTitle: 'Tavily 选项',
			optionsHint: '留空表示恢复该项默认值；改动后点「保存选项」生效。',
			baseURL: '接口地址',
			maxResults: '单次结果上限',
			searchDepth: '搜索深度',
			includeAnswer: '请求摘要答案',
			switchOn: '已开启',
			switchOff: '已关闭',
			timeout: '请求超时（毫秒）',
			rateLimitCooldown: '限流冷却（毫秒）',
			statusTitle: '运行状态',
			takeover: '接管状态',
			takeoverDo: '立即接管',
			takeoverUndo: '交还官方搜索',
			probeRun: '试一次搜索',
			probing: '搜索中…',
			usageCheck: '检测各密钥额度',
			usageChecking: '查询中…',
			resetCooldowns: '重置冷却',
			save: '保存选项',
			saving: '保存中…',
			saved: '已保存',
			loading: '读取中…',
			loadFailed: '读取失败',
			retry: '重试',
			probeQuery: '搜索内容',
			depthBasic: 'basic（均衡）',
			depthFast: 'fast（更快）',
			depthUltraFast: 'ultra-fast（最快）',
			depthAdvanced: 'advanced（更相关，消耗 2 倍额度）',
			stepsTitle: '本次经过',
			warningsTitle: '配置提醒',
			warningsHint: '下面几项配置被自动修正或忽略了，功能仍可用。',
			hit: '命中',
			skipped: '未命中'
		}

		/** 英文文案；仅用于英文界面。 */
		const en = {
			title: 'Web Search++',
			summary: 'Choose the web-search providers and their order (with multi-key Tavily rotation)',
			priorityTitle: 'Priority',
			priorityHint: 'Tried top to bottom; the next one runs when the previous fails.',
			moveUp: 'Move up',
			moveDown: 'Move down',
			keysTitle: 'Tavily keys',
			keysHint: 'Keys are stored in the credentials domain, never in settings files or responses. A rate-limited or quota-exhausted key automatically rotates to the next one.',
			addKey: 'Add key slot',
			removeKey: 'Remove',
			keyApplyHint: 'Sign up to copy your API key — the free tier includes 1000 credits.',
			keyApplyLink: 'Get API Key',
			keyRef: 'Credential name',
			keyValue: 'Key value',
			keyValueHint: 'Leave blank to keep the current value.',
			keyShow: 'Show key',
			keyHide: 'Hide key',
			keyRevealHint: 'This slot has no key yet.',
			keyShowStored: 'Reveal the saved key',
			revealing: 'Reading…',
			keySave: 'Save key',
			keyClear: 'Clear key',
			keyConfigured: 'Configured',
			keyMissing: 'Not configured',
			keyUnwritable: 'Supplied by the environment; cannot be overridden here',
			stateReady: 'Ready',
			stateInvalid: 'Invalid',
			stateCooldown: 'Cooling down',
			stateMissing: 'Not configured',
			sticky: 'In use',
			optionsTitle: 'Tavily options',
			optionsHint: 'Leave a field blank to restore its default; changes apply after you save.',
			baseURL: 'Endpoint',
			maxResults: 'Max results per search',
			searchDepth: 'Search depth',
			includeAnswer: 'Request an answer summary',
			switchOn: 'On',
			switchOff: 'Off',
			timeout: 'Request timeout (ms)',
			rateLimitCooldown: 'Rate-limit cooldown (ms)',
			statusTitle: 'Status',
			takeover: 'Takeover',
			takeoverDo: 'Take over now',
			takeoverUndo: 'Hand back to official search',
			probeRun: 'Run one search',
			probing: 'Searching…',
			usageCheck: 'Check key usage',
			usageChecking: 'Checking…',
			resetCooldowns: 'Reset cooldowns',
			save: 'Save options',
			saving: 'Saving…',
			saved: 'Saved',
			loading: 'Loading…',
			loadFailed: 'Failed to load',
			retry: 'Retry',
			probeQuery: 'Query',
			depthBasic: 'basic (balanced)',
			depthFast: 'fast (faster)',
			depthUltraFast: 'ultra-fast (fastest)',
			depthAdvanced: 'advanced (best relevance, 2× credits)',
			stepsTitle: 'This run went through',
			warningsTitle: 'Configuration notes',
			warningsHint: 'These settings were corrected or ignored automatically; the plugin still works.',
			hit: 'hit',
			skipped: 'skipped'
		}

		/**
		 * 页面样式：只用主题令牌，跟随浅色/深色。
		 *
		 * 悬停态有两个必须遵守的约定，否则会出现「悬停后反而看不清」：
		 *
		 * 1. **用交互专用令牌** `--dsw-alias-interactive-bg-hover`（浅色 `#2631480f`、
		 *    深色 `#ffffff14`，都是半透明叠加），而不是表面令牌 `--dsw-alias-bg-layer-2`
		 *    （浅色是纯白 `#fff`、深色是 `#2c2c2e`）。半透明叠加在任何底色上都成立，
		 *    不会把按钮刷成一块与周围撞色的实心块。
		 * 2. **主按钮的悬停必须同时给背景和前景**。`--dsw-alias-bg-layer-2` 在浅色下
		 *    是纯白，而主按钮文字用的是 `--dsw-alias-label-primary-foreground`（浅色下
		 *    也是纯白）——只换背景不改文字，就会变成白底白字。
		 */
		const CSS = `
		/* ── 设计刻度：字号、缩进与控件高度只在这里定义一次 ──────────────────
		 * 全部规则都引用这些变量，而不是各写各的 px —— 「统一」才是可验证的，
		 * 否则迟早又漂移成 11/12/13/14 混排。
		 */
		.wsp-page {
			--wsp-fs-title: 14px; --wsp-lh-title: 22px;
			--wsp-fs-body: 13px;  --wsp-lh-body: 20px;
			--wsp-fs-meta: 12px;  --wsp-lh-meta: 18px;
			--wsp-control-h: 32px;
			/* 嵌套盒（密钥槽位）的内边距与描边；底部操作行复用它才能与槽位内容左右对齐。 */
			--wsp-box-pad: 12px; --wsp-box-border: 1px;
			--wsp-inset: calc(var(--wsp-box-pad) + var(--wsp-box-border));
			display: flex; flex-direction: column; gap: 12px; width: min(100%, 880px);
			color: var(--dsw-alias-label-primary);
			font-size: var(--wsp-fs-body); line-height: var(--wsp-lh-body);
		}

		/* ── 卡片：全部分区共用同一套表面、描边、圆角与阴影 ─────────────── */
		.wsp-card { display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-shadow-lv1); }
		.wsp-card-head { display: flex; flex-direction: column; gap: 3px; }
		.wsp-head { margin: 0; font-size: var(--wsp-fs-title); font-weight: 600; line-height: var(--wsp-lh-title); }
		.wsp-desc { margin: 0; font-size: var(--wsp-fs-meta); line-height: var(--wsp-lh-meta); color: var(--dsw-alias-label-secondary); }
		.wsp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
		/* 字段内的行：复选框在左、动作按钮贴右，两者同处一格。 */
		.wsp-field-row { justify-content: space-between; }
		.wsp-grow { flex: 1 1 200px; min-width: 120px; }
		/* 卡片级操作行：与嵌套盒的内容对齐（左右各让出一个盒内边距）。 */
		.wsp-actions { padding: 0 var(--wsp-inset); }
		/* 卡片内的次级分组：靠一条分隔线划开，而不是再套一层卡片。 */
		.wsp-group { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l1); }

		/* ── 嵌套盒：卡片内容统一由这一层盒子承装 ─────────────────────────
		 * 密钥槽位、优先级行、状态行、选项表单共用同一个类。
		 * 以前盒子的描边/圆角/底色在各选择器里各写一份，于是「选项」那一块
		 * 能悄悄漂移成没有盒子的裸表单——统一到一处就不可能再发生。
		 */
		.wsp-box { padding: var(--wsp-box-pad); border: var(--wsp-box-border) solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); }

		/* ── 优先级链与状态列表：盒子横向排布 ───────────────────────────── */
		.wsp-chain { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
		.wsp-node { display: flex; align-items: center; gap: 10px; padding-top: 10px; padding-bottom: 10px; transition: border-color .15s ease, background-color .15s ease; }
		.wsp-node:hover { border-color: var(--dsw-alias-border-l3); }
		.wsp-node-idx { width: 22px; height: 22px; flex: none; border-radius: 50%; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); font-size: var(--wsp-fs-meta); font-weight: 600; line-height: 22px; text-align: center; }
		.wsp-node-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
		.wsp-node-name { font-size: var(--wsp-fs-body); font-weight: 500; line-height: var(--wsp-lh-body); }
		.wsp-node-hint { font-size: var(--wsp-fs-meta); line-height: var(--wsp-lh-meta); color: var(--dsw-alias-label-tertiary); word-break: break-word; }
		.wsp-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
		.wsp-dot-ok { background: var(--dsw-alias-state-success-primary); }
		.wsp-dot-warn { background: var(--dsw-alias-state-warn-primary); }
		.wsp-dot-err { background: var(--dsw-alias-state-error-primary); }

		/* ── 按钮：统一高度与圆角；主按钮自带配对前景色 ─────────────────── */
		.wsp-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: var(--wsp-control-h); padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font-size: var(--wsp-fs-body); font-family: inherit; white-space: nowrap; transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
		.wsp-btn:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); }
		.wsp-btn:not(:disabled):active { background: var(--dsw-alias-interactive-bg-active); }
		.wsp-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
		.wsp-btn:disabled { opacity: .45; cursor: default; }
		.wsp-btn.wsp-btn-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
		.wsp-btn.wsp-btn-primary:not(:disabled):hover { background: var(--dsw-alias-button-primary-hover); color: var(--dsw-alias-label-primary-foreground); }
		.wsp-btn.wsp-btn-primary:not(:disabled):active { background: var(--dsw-alias-button-primary-hover); color: var(--dsw-alias-label-primary-foreground); }

		/* ── 输入框：与按钮同高，聚焦时描边换色 ─────────────────────────── */
		.wsp-input { height: var(--wsp-control-h); padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: var(--wsp-fs-body); font-family: inherit; box-sizing: border-box; flex: 1 1 auto; min-width: 0; transition: border-color .15s ease; }
		.wsp-input:focus { border-color: var(--dsw-alias-state-business-primary); outline: none; }
		.wsp-input::placeholder { color: var(--dsw-alias-label-tertiary); }
		/* 已保存密钥的占位点阵：比普通提示更实，读起来像「这里有一把密钥」。 */
		.wsp-input-stored::placeholder { color: var(--dsw-alias-label-secondary); letter-spacing: 1px; }
		/* 输入框容器：给眼睛按钮留出绝对定位的空间，并让输入框占满剩余宽度。 */
		.wsp-input-wrap { position: relative; display: inline-flex; align-items: center; }
		.wsp-input-wrap .wsp-input { padding-right: 34px; }
		.wsp-eye { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); width: 24px; height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: var(--dsw-radius-xs); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; transition: background-color .15s ease, color .15s ease; }
		.wsp-eye:not(:disabled):hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
		.wsp-eye:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
		.wsp-eye:disabled { opacity: .45; cursor: default; }

		/* ── 密钥槽位：盒子的纵向变体 ───────────────────────────────────── */
		.wsp-key { display: flex; flex-direction: column; gap: 8px; }
		.wsp-key-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

		/* ── 标签与提示：字号取 meta 一级 ───────────────────────────────── */
		.wsp-badge { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-size: var(--wsp-fs-meta); line-height: var(--wsp-lh-meta); white-space: nowrap; }
		.wsp-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
		.wsp-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
		.wsp-err { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
		.wsp-note { font-size: var(--wsp-fs-meta); line-height: var(--wsp-lh-meta); margin: 0; }
		/*
		 * 提示行的固定槽位：没有提示时也占住一行高度（min-height），有提示时只换内容。
		 * 没有它，提示的「出现/消失」会改变整张卡片高度，下方内容随之上下跳一次——
		 * 用户看到的就是「点一下按钮，整个界面闪一下」。
		 */
		.wsp-note-slot { min-height: var(--wsp-lh-meta); }
		.wsp-note-err { color: var(--dsw-alias-state-error-primary); }
		.wsp-note-ok { color: var(--dsw-alias-state-success-primary); }
		.wsp-note-warn { color: var(--dsw-alias-state-warn-primary); }
		.wsp-hint { font-size: var(--wsp-fs-meta); line-height: var(--wsp-lh-meta); color: var(--dsw-alias-label-secondary); }
		.wsp-link { color: var(--dsw-alias-link); text-decoration: underline dotted; text-underline-offset: 2px; font-size: var(--wsp-fs-meta); line-height: var(--wsp-lh-meta); white-space: nowrap; }
		.wsp-link:hover { text-decoration: underline solid; }

		/* ── 表单栅格与列表 ─────────────────────────────────────────────── */
		.wsp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
		.wsp-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
		.wsp-label { font-size: var(--wsp-fs-meta); line-height: var(--wsp-lh-meta); color: var(--dsw-alias-label-secondary); }
		/* 复选框控件：与同行的输入框等高，标签结构也一致。 */
		.wsp-check { display: flex; align-items: center; gap: 6px; height: var(--wsp-control-h); font-size: var(--wsp-fs-meta); line-height: var(--wsp-lh-meta); }
		.wsp-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: var(--wsp-fs-meta); }

		/* ── 设置卡片摘要：只做一行说明 ───────────────────────────────────
		 * 摘要**不再**自带标题、展开开关，也**不再**在卡片内部渲染完整设置页。
		 *
		 * 原因（两条都是真实报障）：
		 *
		 * 1. 标题重复。宿主摘要位（CardHead 的 cardDesc、详情页的 detailDesc）
		 *    本来就把条目标题渲染在紧邻位置，摘要里再写一遍标题，界面上就是
		 *    「网页搜索++ / 网页搜索++」两行。
		 * 2. 展开按钮是**套在宿主可点击卡片里面**的第二个控件。宿主的卡片标题
		 *    按钮带着整卡热区（伪元素 inset:0），摘要里再塞一个按钮，命中的
		 *    永远是卡片的「打开详情」热区——用户点了「展开设置」却被导航走；
		 *    而且摘要位在列表卡片、详情页副标题处**会各渲染一次**，一展开就同时
		 *    挂起两份同一页面的实例（两份独立 state，互相看不见对方的状态）。
		 *
		 * 摘要位只负责「一句话说明」，配置入口交给宿主卡片本身（点标题进详情页）。
		 * 详情页里的完整页面由 view:page 渲染，与摘要互不重叠。
		 */
		.wsp-summary { display: block; min-width: 0; }
		.wsp-summary-desc { font-size: var(--wsp-fs-meta); line-height: var(--wsp-lh-meta); color: var(--dsw-alias-label-secondary); }

		@media (prefers-reduced-motion: reduce) {
			.wsp-page *, .wsp-page *::before, .wsp-page *::after { transition: none !important; }
		}
		`

		/**
		 * 调一个管理端点。
		 *
		 * 路径必须补上斜杠：`ROUTE_PREFIX` 本身不带尾斜杠，直接用
		 * `${ROUTE_PREFIX}${path}` 会拼出 `/api/dsh-web-search-pluspriority` 这种
		 * 畸形 URL——宿主按「前缀 + /」匹配，于是所有操作静默 404，而 GET '' 正常，
		 * 看起来像「页面能打开但按钮全没用」。这里统一归一化，调用方不必操心。
		 *
		 * @param {string} method - HTTP 方法。
		 * @param {string} path - 相对路径（可带或不带前导斜杠；空串表示路由根）。
		 * @param {object} [body] - 请求体。
		 * @returns {Promise<object>} 解析后的响应。
		 */
		async function request(method, path, body) {
			const suffix = path.length === 0 || path.startsWith('/') ? path : `/${path}`
			const response = await fetch(`${ROUTE_PREFIX}${suffix}`, {
				method,
				headers: body === undefined ? undefined : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			})
			let parsed
			try {
				parsed = await response.json()
			} catch {
				throw new Error(`HTTP ${String(response.status)}`)
			}
			if (parsed?.ok !== true) throw new Error(typeof parsed?.error === 'string' ? parsed.error : `HTTP ${String(response.status)}`)
			return parsed
		}

		/**
		 * 把密钥槽位状态翻成界面文案。
		 * @param {object} slot - 快照里的槽位。
		 * @param {(key: string) => string} t - 字典读取器。
		 * @returns {{ text: string, tone: string }} 文案与色调。
		 */
		function slotState(slot, t) {
			if (slot.configured !== true) return { text: t('stateMissing'), tone: 'wsp-badge' }
			if (slot.state === 'invalid') return { text: t('stateInvalid'), tone: 'wsp-badge wsp-err' }
			if (slot.state === 'cooldown') {
				const seconds = Math.max(0, Math.round((slot.cooldownUntil - Date.now()) / 1000))
				return { text: `${t('stateCooldown')} ${String(seconds)}s`, tone: 'wsp-badge wsp-warn' }
			}
			return { text: t('stateReady'), tone: 'wsp-badge wsp-ok' }
		}

		/**
		 * 优先级链编辑区。
		 * @param {object} props - 快照与动作。
		 * @returns {object} React 元素。
		 */
		function PriorityCard(props) {
			const { t, snapshot, isPending, onMove } = props
			/*
			 * 只锁「优先级」这一族控件。以前这里接的是页面级 `busy`：点一次任一按钮，
			 * 整页二十多个按钮同时变灰、再同时恢复——用户看到的正是「点一个，全都动」。
			 * 现在每个动作有自己的在途标记，互不牵连。
			 */
			const busy = isPending('priority')
			const nodes = snapshot.config.priority
			return h('section', { className: 'wsp-card' },
				h('div', { className: 'wsp-card-head' },
					h('h3', { className: 'wsp-head' }, t('priorityTitle')),
					h('p', { className: 'wsp-desc' }, t('priorityHint'))),
				h('ol', { className: 'wsp-chain' }, nodes.map((node, index) => h('li', { className: 'wsp-box wsp-node', key: node },
					h('span', { className: 'wsp-node-idx' }, String(index + 1)),
					h('span', { className: 'wsp-node-main' },
						h('span', { className: 'wsp-node-name' }, PROVIDER_LABELS[node] ?? node),
						h('span', { className: 'wsp-node-hint' }, PROVIDER_HINTS[node] ?? '')),
					h('button', { type: 'button',
						className: 'wsp-btn',
						disabled: busy || index === 0,
						onClick: () => onMove(index, index - 1)
					}, t('moveUp')),
					h('button', { type: 'button',
						className: 'wsp-btn',
						disabled: busy || index === nodes.length - 1,
						onClick: () => onMove(index, index + 1)
					}, t('moveDown'))))))
		}

		/**
		 * 密钥槽位编辑区（多密钥轮换的界面）。
		 * @param {object} props - 快照与动作。
		 * @returns {object} React 元素。
		 */
		function KeysCard(props) {
			const { t, snapshot, isPending, drafts, revealed, onDraft, onToggleReveal, onRevealStored, revealing, fromStored, onSaveKey, onClearKey, onAddKey, onRemoveKey, onResetCooldowns } = props
			/*
			 * 密钥区有两种在途状态，必须分开：
			 * - `saving`：正在写某一把密钥（或清除/移除某个槽位），只该锁住那一个槽位；
			 * - `slots`：正在增删槽位、重置冷却，会改变整张表的形状，锁整张卡。
			 * 接页面级 `busy` 会让「保存第 2 把」把第 1、3 把的按钮一起变灰。
			 */
			const savingAll = isPending('keys')
			const savingSlot = (ref) => isPending(`key:${ref}`)
			const saveBusy = savingAll
			return h('section', { className: 'wsp-card' },
				h('div', { className: 'wsp-card-head' },
					h('h3', { className: 'wsp-head' }, t('keysTitle')),
					h('p', { className: 'wsp-desc' }, t('keysHint'))),
				snapshot.keys.map((slot) => {
					const state = slotState(slot, t)
					// 单个槽位自己的在途标记：只锁自己这一行的三个按钮与输入框。
					const busy = saveBusy || savingSlot(slot.ref)
					return h('div', { className: 'wsp-box wsp-key', key: slot.ref },
						h('div', { className: 'wsp-key-head' },
							h('span', { className: 'wsp-mono' }, slot.ref),
							h('span', { className: state.tone }, state.text),
							slot.sticky === true ? h('span', { className: 'wsp-badge wsp-ok' }, t('sticky')) : null,
							slot.writable === false ? h('span', { className: 'wsp-badge' }, t('keyUnwritable')) : null,
							h('span', { className: 'wsp-grow' }),
							h('button', { type: 'button',
								className: 'wsp-btn',
								disabled: busy || slot.writable === false,
								onClick: () => onClearKey(slot.ref)
							}, t('keyClear')),
							h('button', { type: 'button',
								className: 'wsp-btn',
								disabled: busy,
								onClick: () => onRemoveKey(slot.ref)
							}, t('removeKey'))),
						h('div', { className: 'wsp-row' },
							h(KeyInput, {
								t,
								value: drafts[slot.ref] ?? '',
								revealed: revealed[slot.ref] === true,
								disabled: busy || slot.writable === false,
								configured: slot.configured === true,
								placeholder: `${t('keyValue')} —— ${t('keyValueHint')}`,
								onChange: (event) => onDraft(slot.ref, event.target.value),
								onToggle: () => onToggleReveal(slot.ref),
								onRevealStored: () => onRevealStored(slot.ref),
								revealing: revealing[slot.ref] === true,
								fromStored: fromStored[slot.ref] === true
							}),
							h('button', { type: 'button',
								className: 'wsp-btn wsp-btn-primary',
								disabled: busy || slot.writable === false || (drafts[slot.ref] ?? '').trim().length === 0,
								onClick: () => onSaveKey(slot.ref)
							}, t('keySave'))),
						slot.reason !== undefined ? h('p', { className: 'wsp-note wsp-note-warn' }, slot.reason) : null)
				}),
				// wsp-actions 让本行内容与上方密钥槽位的内容左右对齐（各让出一个盒内边距）。
				h('div', { className: 'wsp-row wsp-actions' },
					h('button', { type: 'button', className: 'wsp-btn', disabled: saveBusy, onClick: onAddKey }, t('addKey')),
					h('button', { type: 'button', className: 'wsp-btn', disabled: saveBusy, onClick: onResetCooldowns }, t('resetCooldowns')),
					// 免费额度提示与申请入口：放在操作区右侧，需要密钥时不必离开本页去查文档。
					h('span', { className: 'wsp-grow' }),
					h('span', { className: 'wsp-hint' }, t('keyApplyHint')),
					h('a', {
						className: 'wsp-link',
						href: TAVILY_HOME_URL,
						target: '_blank',
						rel: 'noreferrer noopener'
					}, t('keyApplyLink'))))
		}

		/**
		 * Tavily 选项区。
		 * @param {object} props - 快照、草稿与动作。
		 * @returns {object} React 元素。
		 */
		function OptionsCard(props) {
			const { t, snapshot, isPending, options, onOption, onSaveOptions } = props
			// 选项表单自己的在途标记：保存选项不该把密钥区与接管按钮一起锁住。
			const busy = isPending('options')
			/** 渲染一个数字输入。 */
			const numberField = (key, label) => h('label', { className: 'wsp-field', key },
				h('span', { className: 'wsp-label' }, label),
				h('input', {
					className: 'wsp-input',
					type: 'number',
					value: options[key] ?? '',
					disabled: busy,
					onChange: (event) => onOption(key, event.target.value)
				}))
			return h('section', { className: 'wsp-card' },
				h('div', { className: 'wsp-card-head' },
					h('h3', { className: 'wsp-head' }, t('optionsTitle')),
					h('p', { className: 'wsp-desc' }, t('optionsHint'))),
				/*
				 * 表单装进与其他卡片同一款嵌套盒（wsp-box）：以前字段直接铺在卡片上，
				 * 是四个模块里唯一没有盒子的，整块看着就「不是一家人」。
				 *
				 * 六个设置项放进同一个三列栅格，正好铺满两行 —— 不再像以前那样
				 * 第二行末尾空一格、复选框与保存按钮另起两行挤在左下角。
				 */
				h('div', { className: 'wsp-box' },
					h('div', { className: 'wsp-grid' },
					h('label', { className: 'wsp-field' },
						h('span', { className: 'wsp-label' }, t('baseURL')),
						h('input', {
							className: 'wsp-input',
							value: options.tavilyBaseURL ?? '',
							disabled: busy,
							onChange: (event) => onOption('tavilyBaseURL', event.target.value)
						})),
					h('label', { className: 'wsp-field' },
						h('span', { className: 'wsp-label' }, t('searchDepth')),
						h('select', {
							className: 'wsp-input',
							value: options.tavilySearchDepth ?? 'basic',
							disabled: busy,
							onChange: (event) => onOption('tavilySearchDepth', event.target.value)
						},
							h('option', { value: 'basic' }, t('depthBasic')),
							h('option', { value: 'fast' }, t('depthFast')),
							h('option', { value: 'ultra-fast' }, t('depthUltraFast')),
							h('option', { value: 'advanced' }, t('depthAdvanced')))),
					numberField('tavilyMaxResults', t('maxResults')),
					numberField('tavilyTimeoutMs', t('timeout')),
					numberField('tavilyRateLimitCooldownMs', t('rateLimitCooldown')),
					/*
					 * 第六格：复选框与保存按钮**同行**。
					 *
					 * 保存按钮原先独占一行、孤零零贴在卡片右下角，中间空出一整条带，
					 * 显得突兀。放进最后一格后：复选框右侧原本闲置的空间被利用起来，
					 * 卡片也不再有多余的一行。
					 *
					 * 这一格刻意用 `div` 而不是 `label`：里面含按钮，若整格是 label，
					 * 点保存会顺带切换复选框。勾选语义交给内层 label（点文字仍可切换）。
					 */
					h('div', { className: 'wsp-field' },
						h('span', { className: 'wsp-label' }, t('includeAnswer')),
						h('div', { className: 'wsp-row wsp-field-row' },
							h('label', { className: 'wsp-check' },
								h('input', {
									type: 'checkbox',
									checked: options.tavilyIncludeAnswer === true,
									disabled: busy,
									onChange: (event) => onOption('tavilyIncludeAnswer', event.target.checked)
								}),
								h('span', null, options.tavilyIncludeAnswer === true ? t('switchOn') : t('switchOff'))),
							h('button', { type: 'button', className: 'wsp-btn wsp-btn-primary', disabled: busy, onClick: onSaveOptions }, busy ? t('saving') : t('save')))))))
		}

		/**
		 * 运行状态区：接管状态、链路实况、探测与额度检测。
		 * @param {object} props - 快照、动作与探测结果。
		 * @returns {object} React 元素。
		 */
		function StatusCard(props) {
			const { t, snapshot, isPending, onTakeover, onUndoTakeover, onProbe, onUsage, probe, usage, message } = props
			/*
			 * 四个按钮四种在途状态：接管/交还/试搜/查额度各管各的。
			 * 共用一个页面级 `busy` 时，点「试一次搜索」会让「立即接管」「交还」「检测额度」
			 * 同时变灰并同时恢复——这正是用户说的「点按其中一个会导致该页面所有按钮生效」。
			 */
			const takeoverBusy = isPending('takeover')
			const probing = isPending('probe')
			const usageBusy = isPending('usage')
			const takeover = snapshot.takeover
			return h('section', { className: 'wsp-card' },
				h('div', { className: 'wsp-card-head' },
					h('h3', { className: 'wsp-head' }, t('statusTitle')),
					h('p', { className: takeover.active ? 'wsp-note wsp-note-ok' : 'wsp-note wsp-note-err' }, takeover.message)),
				h('ul', { className: 'wsp-chain' }, snapshot.chain.map((node) => h('li', { className: 'wsp-box wsp-node', key: node.node },
					h('span', { className: node.available ? 'wsp-dot wsp-dot-ok' : 'wsp-dot wsp-dot-warn' }),
					h('span', { className: 'wsp-node-main' },
						h('span', { className: 'wsp-node-name' }, node.label),
						h('span', { className: 'wsp-node-hint' }, node.detail))))),
				h('div', { className: 'wsp-row' },
					h('button', { type: 'button',
						className: 'wsp-btn wsp-btn-primary',
						disabled: takeoverBusy || !takeover.canRepair || takeover.active,
						onClick: onTakeover
					}, t('takeoverDo')),
					h('button', { type: 'button',
						className: 'wsp-btn',
						disabled: takeoverBusy || !takeover.canRepair || !takeover.active,
						onClick: onUndoTakeover
					}, t('takeoverUndo')),
					h('button', { type: 'button', className: 'wsp-btn', disabled: probing, onClick: onProbe }, probing ? t('probing') : t('probeRun')),
					h('button', { type: 'button', className: 'wsp-btn', disabled: usageBusy, onClick: onUsage }, usageBusy ? t('usageChecking') : t('usageCheck'))),
				probe !== undefined
					? h('div', { className: 'wsp-group' },
						h('p', { className: 'wsp-label' }, t('stepsTitle')),
						h('ul', { className: 'wsp-chain' }, probe.attempts.map((attempt, index) => h('li', { className: 'wsp-box wsp-node', key: `${attempt.node}-${String(index)}` },
							h('span', { className: attempt.ok ? 'wsp-dot wsp-dot-ok' : 'wsp-dot wsp-dot-err' }),
							h('span', { className: 'wsp-node-main' },
								h('span', { className: 'wsp-node-name' }, attempt.label),
								h('span', { className: 'wsp-node-hint' },
									`${attempt.ok ? t('hit') : t('skipped')} · ${String(attempt.elapsedMs)}ms`
									+ (attempt.reason === undefined ? '' : ` · ${attempt.reason}`)))))),
						h('p', { className: 'wsp-note wsp-mono' },
							/*
							 * 必须写明「这条结论属于哪条链路」。
							 *
							 * 交还官方搜索之后，seam 用的是 deepseek-official，探测也不再走本插件的
							 * 优先级链；若这里仍只显示「N 条来源」，用户会以为插件还在按优先级判定。
							 * `takenOver` 由宿主按同一个 `currentSeamProvider()` 给出，界面不自行猜测。
							 */
							probe.takenOver === false
								? `${String(probe.sourceCount)} 条来源 · 走「${probe.seamProvider ?? '自动选择'}」，未经过优先级链`
								: `${String(probe.sourceCount)} 条来源 · 经优先级链命中「${probe.route ?? '未知'}」`))
					: null,
				usage !== undefined
					? h('div', { className: 'wsp-group' },
						h('ul', { className: 'wsp-chain' }, usage.map((entry) => h('li', { className: 'wsp-box wsp-node', key: entry.ref },
							h('span', { className: entry.ok ? 'wsp-dot wsp-dot-ok' : 'wsp-dot wsp-dot-err' }),
							h('span', { className: 'wsp-node-main' },
								h('span', { className: 'wsp-node-name wsp-mono' }, entry.ref),
								h('span', { className: 'wsp-node-hint' },
									entry.ok ? describeUsage(entry.usage) : (entry.error ?? '未知错误')))))))
					: null,
				/*
				 * 提示行**始终占位**，不再「开始操作时删除、成功后重建」。
				 *
				 * 真实报障：「点『保存选项』的一瞬间按钮变成『保存中…』，但整个 UI 会
				 * 随着闪一下」。逐帧实测（requestAnimationFrame 采样）：高度 1206 → 1236
				 * 跳变两次，`disabledCount` 9 → 20 → 9。原因就是这一行在操作开始时被
				 * `setMessage(undefined)` 摘掉、成功后又重新挂上——整张卡随之长高再变矮，
				 * 下方所有内容跟着位移，看上去就是整页闪。
				 *
				 * 现在固定渲染一个容器：没有提示时保留等高的空行（视觉上仍是「空」），
				 * 有提示时只替换里面的文字与色调。高度不再振荡，卡片也不再位移。
				 *
				 * 用 `aria-live="polite"` 让读屏软件在提示出现时播报，而不是每帧都打扰。
				 */
				h('p', {
					className: `wsp-note wsp-note-slot${message === undefined ? '' : ` ${message.tone}`}`,
					'aria-live': 'polite'
				}, message === undefined ? '' : message.text))
		}

		/**
		 * 两个快照的内容是否「深度一致」——用于避免无变化的刷新触发整页重算。
		 *
		 * 只处理本插件自己的快照形状：普通对象、数组、原始值。不追求通用深比较的完备性，
		 * 遇到函数/循环引用直接判为「不一致」（宁可多重绘一次，也不能把新数据吞掉）。
		 *
		 * @param {unknown} a - 旧值。
		 * @param {unknown} b - 新值。
		 * @param {number} [depth] - 递归深度上限，防御异常嵌套。
		 * @returns {boolean} 是否一致。
		 */
		function sameShape(a, b, depth = 0) {
			if (a === b) return true
			if (depth > 8) return false
			if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
			const aArray = Array.isArray(a)
			if (aArray !== Array.isArray(b)) return false
			if (aArray) {
				const left = a
				const right = b
				if (left.length !== right.length) return false
				for (let index = 0; index < left.length; index += 1) {
					if (!sameShape(left[index], right[index], depth + 1)) return false
				}
				return true
			}
			const leftKeys = Object.keys(a)
			if (leftKeys.length !== Object.keys(b).length) return false
			for (const key of leftKeys) {
				if (!Object.hasOwn(b, key)) return false
				if (!sameShape(a[key], b[key], depth + 1)) return false
			}
			return true
		}

		/**
		 * 把 `/usage` 的响应读成一句人话。字段缺失时说「未报告」，而不是编造数字。
		 * @param {unknown} usage - `/usage` 的响应体。
		 * @returns {string} 描述。
		 */
		function describeUsage(usage) {
			const account = usage?.account
			if (typeof account !== 'object' || account === null) return '已连通（未报告用量）'
			const used = account.plan_usage
			const limit = account.plan_limit
			const plan = typeof account.current_plan === 'string' ? account.current_plan : undefined
			const parts = []
			if (typeof used === 'number') parts.push(`本期已用 ${String(used)}`)
			if (typeof limit === 'number') parts.push(`上限 ${String(limit)}`)
			else parts.push('未报告上限')
			if (plan !== undefined) parts.push(`套餐 ${plan}`)
			return parts.join('，')
		}

		/**
		 * 眼睛图标：`open` 为 true 时是「睁眼」（点击会掩码），否则是「闭眼」（点击会显示）。
		 *
		 * 用内联 SVG 而不是图标库：本插件不该为一个小图标引入额外依赖。
		 * 描边用 `currentColor`，因此自动跟随按钮的文字色与浅色/深色主题。
		 *
		 * @param {object} props - `{ open }`。
		 * @returns {object} React 元素。
		 */
		function EyeIcon(props) {
			const common = {
				width: 14,
				height: 14,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 2,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': 'true',
				focusable: 'false'
			}
			if (props.open === true) {
				return h('svg', common,
					h('path', { d: 'M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z' }),
					h('circle', { cx: 12, cy: 12, r: 3 }))
			}
			return h('svg', common,
				h('path', { d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94' }),
				h('path', { d: 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19' }),
				h('path', { d: 'M14.12 14.12a3 3 0 1 1-4.24-4.24' }),
				h('line', { x1: 1, y1: 1, x2: 23, y2: 23 }))
		}

		/**
		 * 密钥输入框：默认掩码，带一个可切换明文的眼睛按钮。
		 *
		 * ## 已保存的密钥也能看（本次修复）
		 *
		 * 早先这里是 `const canReveal = !empty`，即**只有草稿里有内容才允许显示明文**。
		 * 而「已保存」的语义恰恰是草稿为空、输入框只显示点阵占位——于是保存过的密钥
		 * 小眼睛永远是灰的，用户存完就再也核对不了自己存的是哪一把（报障原文：
		 * 「保存过的密钥没法点小眼睛显示」）。
		 *
		 * 现在：
		 * - 草稿里有内容 → 照旧本地切换掩码/明文，不发请求；
		 * - 草稿为空但已保存 → 点小眼睛时**按需**向宿主要一次明文，拿到后填进输入框
		 *   并以 `text` 显示；再点一次收回掩码并清掉取回的值，不在输入框里留下明文。
		 *
		 * 「按需」是刻意的：页面加载与每次快照刷新都不会拉明文，只有用户点这一下才发请求。
		 *
		 * @param {object} props - 输入框属性。
		 * @returns {object} React 元素。
		 */
		function KeyInput(props) {
			const { t, value, revealed, disabled, configured, placeholder, onChange, onToggle, onRevealStored, revealing, fromStored } = props
			const empty = value.length === 0
			const stored = empty && configured === true
			// 有草稿，或该槽位确实存着密钥 → 都能看。两者都没有才禁用。
			const canReveal = !empty || stored === true
			/*
			 * 眼睛按钮要做什么，有三种情况，**必须区分开**：
			 *
			 * 1. 输入框里的内容是「刚从宿主取回的已保存密钥」（`fromStored`）→ 再点一次是
			 *    **收回**：清掉草稿、恢复点阵占位。这一支不能用普通的本地切换，否则
			 *    只是把 type 改回 password，明文仍留在输入框里（实测 len 仍为 57）。
			 * 2. 草稿是用户自己敲的 → 本地切换掩码/明文，不发请求、也不清内容。
			 * 3. 草稿为空但槽位已保存 → 向宿主按需取一次。
			 *
			 * `fromStored` 单独存在的原因就在这里：仅凭「草稿非空」无法区分 1 和 2。
			 */
			const handleToggle = () => {
				if (fromStored === true) {
					void onRevealStored()
					return
				}
				if (!empty) {
					onToggle()
					return
				}
				if (stored === true) void onRevealStored()
			}
			const title = !canReveal
				? t('keyRevealHint')
				: revealing === true
					? t('revealing')
					: revealed ? t('keyHide') : (stored === true ? t('keyShowStored') : t('keyShow'))
			return h('span', { className: 'wsp-input-wrap wsp-grow' },
				h('input', {
					className: stored ? 'wsp-input wsp-input-stored' : 'wsp-input',
					type: revealed ? 'text' : 'password',
					autoComplete: 'new-password',
					spellCheck: false,
					placeholder: stored ? SAVED_KEY_MASK : placeholder,
					value,
					disabled,
					onChange
				}),
				h('button', {
					type: 'button',
					className: 'wsp-eye',
					disabled: disabled || !canReveal || revealing === true,
					'aria-label': title,
					'aria-pressed': revealed,
					title,
					onClick: handleToggle
				}, h(EyeIcon, { open: revealed })))
		}

		/**
		 * 插件页里的完整设置页。
		 * @returns {object} React 元素。
		 */
		function WebSearchPlusPage(props) {
			const t = props.t ?? ((key) => zh[key] ?? key)
			const [snapshot, setSnapshot] = react.useState(undefined)
			const [error, setError] = react.useState('')
			/**
			 * 在途动作的**集合**，而不是一个页面级布尔。
			 *
			 * 早先这里是 `const [busy, setBusy] = useState(false)`：任何一个动作开始，
			 * 全页所有按钮同时 `disabled`，动作结束后又同时恢复。用户看到的就是
			 * 「点按其中一个会导致该页面所有按钮生效」——按钮并没有真的被一起点击，
			 * 但它们**一起变灰、一起恢复、一起给出同一个提示**，视觉上与「全部被触发」
			 * 无法区分。
			 *
			 * 现在每个动作只登记自己的键（`priority` / `keys` / `key:<ref>` / `options`
			 * / `takeover` / `probe` / `usage`），由 `isPending` 按所属区域查询。
			 */
			const [pending, setPending] = react.useState({})
			const [drafts, setDrafts] = react.useState({})
			/**
			 * 哪些槽位当前**明文可见**（按引用名索引）。
			 *
			 * 默认全部掩码：密钥是敏感输入，不能因为「上次点过眼睛」就在下次打开时
			 * 直接摊在屏幕上。切换只影响显示，不影响提交的值。
			 */
			const [revealed, setRevealed] = react.useState({})
			/**
			 * 哪些槽位正在「读取已保存的明文」（按引用名索引）。
			 *
			 * 与 `revealed` 分开：这是网络往返中的短暂状态，只用来把该槽位的小眼睛
			 * 临时禁用并显示「读取中…」，避免连点触发多次取值。
			 */
			const [revealing, setRevealing] = react.useState({})
			/**
			 * 哪些槽位输入框里的内容**来自宿主取回**（而不是用户自己敲的草稿）。
			 *
			 * 只有这种内容，再点小眼睛才是「收回并清空」；用户自己敲的内容只切换掩码，
			 * 绝不能因为点了一下眼睛就把他正在输入的东西清掉。
			 */
			const [fromStored, setFromStored] = react.useState({})
			/**
			 * evealed 的**同步镜像**。
			 *
			 * 事件处理器里要立刻知道「这个槽位现在是不是显示着」，而 setState 的更新函数
			 * 不保证同步执行（见 onRevealStored 的注释）。React 官方对这类需求的做法就是
			 * 用 ref 留一份可同步读的值，state 只负责触发渲染。
			 */
			const shownRef = react.useRef({})
			const [options, setOptions] = react.useState({})
			const [probe, setProbe] = react.useState(undefined)
			const [usage, setUsage] = react.useState(undefined)
			const [message, setMessage] = react.useState(undefined)

			/**
			 * 重新读取宿主快照，并把选项草稿同步成新值。
			 *
			 * ## 为什么这里要「值没变就不换对象」
			 *
			 * 这段原先无条件 `setSnapshot(next)` + 重建 `options` 对象。React 按引用比较，
			 * 于是每次刷新都会让**四张卡在同一次渲染里全部重算**：优先级列表、密钥槽位、
			 * 选项栅格、状态区全被重画。哪怕用户只是点了「保存选项」，也在整页重绘——
			 * 与「按钮自己变灰」叠加起来就是用户报的「整个 UI 闪一下」。
			 *
			 * 现在两条都改成按需：
			 * - 快照内容与上一份**深度一致**时不换引用，卡片不会因为一次无变化的刷新而重算；
			 * - `options` 只在某个字段真的变了时才产生新对象，否则原样返回，栅格不重绘。
			 *
			 * 深比较的输入都是本插件自己的小对象（配置 + 密钥状态 + 链路），没有循环引用，
			 * 也不含密钥明文（宿主从不回传），开销可以忽略。
			 *
			 * @returns {Promise<object|undefined>} 新快照（失败时为 undefined）。
			 */
			const reload = react.useCallback(async () => {
				try {
					const next = await request('GET', '')
					setSnapshot((current) => (sameShape(current, next) ? current : next))
					setError('')
					setOptions((current) => {
						const keys = ['tavilyBaseURL', 'tavilySearchDepth', 'tavilyMaxResults', 'tavilyTimeoutMs', 'tavilyRateLimitCooldownMs', 'tavilyIncludeAnswer']
						let changed = false
						const merged = { ...current }
						for (const key of keys) {
							if (merged[key] !== next.config[key]) {
								merged[key] = next.config[key]
								changed = true
							}
						}
						return changed ? merged : current
					})
					return next
				} catch (failure) {
					setError(String(failure?.message ?? failure))
					return undefined
				}
			}, [])

			react.useEffect(() => {
				void reload()
			}, [reload])

			/** 冷却倒计时要走动，否则界面会停在进入页面那一刻的秒数。 */
			react.useEffect(() => {
				const timer = setInterval(() => {
					setSnapshot((current) => (current === undefined ? current : { ...current }))
				}, 1000)
				return () => clearInterval(timer)
			}, [])

			/**
			 * 某个动作（或某个区域）此刻是否在途。
			 * @param {string} key - 动作键，如 `priority`、`key:TAVILY_API_KEY`。
			 * @returns {boolean} 是否在途。
			 */
			const isPending = react.useCallback((key) => pending[key] === true, [pending])

			/**
			 * 登记/注销一个在途动作。同一个键用计数而不是布尔，避免
			 * 「先结束的后注销」把并发的另一个动作一起清掉。
			 * @param {string} key - 动作键。
			 * @param {1|-1} delta - 登记或注销。
			 */
			const markPending = react.useCallback((key, delta) => {
				setPending((current) => {
					const next = { ...current }
					const count = (current[key] === true ? 1 : 0) + delta
					if (count > 0) next[key] = true
					else delete next[key]
					return next
				})
			}, [])

			/**
			 * 包一层「登记 → 执行 → 刷新 → 注销」，让所有动作共享同一套错误呈现，
			 * 同时**只锁自己这一族控件**。
			 *
			 * ## 为什么刷新快照要放在注销之后
			 *
			 * 早先的顺序是「执行 → reload() → 注销」，即整页快照重取的这段时间里，
			 * 动作键一直处于在途状态。`reload()` 会把整份 `snapshot` 换成新对象、
			 * 把 `options` 重建一遍，于是**四张卡在同一次渲染里全部重算**；4 个动作键
			 * 再各自把「自己那一族」变灰——用户点的是「保存选项」，看到的却是
			 * 整个页面一起闪（实测 `disabledCount` 9 → 20 → 9，卡片高度 1206 → 1236）。
			 *
			 * 现在：动作本身一结束就注销（按钮的「保存中…」随之恢复），随后才在
			 * 后台刷新快照。刷新只更新数据，不再兼任「让按钮变灰」的职责。
			 *
			 * @param {string} key - 动作键（决定哪些控件在此期间变灰）。
			 * @param {() => Promise<unknown>} operation - 动作。
			 * @param {string} [okText] - 成功提示。
			 */
			const run = react.useCallback(async (key, operation, okText) => {
				markPending(key, 1)
				try {
					await operation()
				} catch (failure) {
					markPending(key, -1)
					setMessage({ text: String(failure?.message ?? failure), tone: 'wsp-note-err' })
					return
				}
				markPending(key, -1)
				// 成功提示先落，再刷新：提示是用户这一下的反馈，不该等一次网络往返。
				if (okText !== undefined) setMessage({ text: okText, tone: 'wsp-note-ok' })
				await reload()
			}, [reload, markPending])

			/** 调整优先级顺序。 */
			const onMove = (from, to) => {
				const nodes = [...snapshot.config.priority]
				const [moved] = nodes.splice(from, 1)
				nodes.splice(to, 0, moved)
				void run('priority', () => request('PUT', 'priority', { priority: nodes }), t('saved'))
			}

			/**
			 * 保存某个槽位的密钥。
			 *
			 * 保存成功后**刻意保留输入内容**，不清空草稿：
			 * 清空会让输入框瞬间变空，用户无法确认「刚才填的到底存进去没有」，
			 * 也无从核对填的是哪一把密钥。输入框按显示开关保持掩码或明文，
			 * 与是否落库无关——这正是「有输入就看得见」。
			 */
			const onSaveKey = (ref) => {
				const value = (drafts[ref] ?? '').trim()
				void run(`key:${ref}`, () => request('POST', 'keys/value', { ref, value }), `${ref} 已保存`)
			}

			/** 清除某个槽位已存的密钥（保留槽位）。 */
			const onClearKey = (ref) => {
				void run(`key:${ref}`, () => request('DELETE', 'keys/value', { ref }), `${ref} 已清除`)
			}

			/** 追加一个密钥槽位。 */
			const onAddKey = () => {
				void run('keys', async () => {
					const result = await request('POST', 'keys', {})
					setSnapshot(result)
				}, t('saved'))
			}

			/** 移除一个密钥槽位（同时尽力清除其已存密钥）。 */
			const onRemoveKey = (ref) => {
				void run(`key:${ref}`, () => request('DELETE', 'keys', { ref }), `${ref} 已移除`)
			}

			/** 重置所有冷却与失效标记。 */
			const onResetCooldowns = () => {
				void run('keys', () => request('POST', 'keys/reset', {}), t('saved'))
			}

			/** 切换某个槽位的明文显示。只影响显示，不改动输入值。 */
			const onToggleReveal = (ref) => {
				setRevealed((current) => ({ ...current, [ref]: current[ref] !== true }))
			}

			/**
			 * 查看**已保存**密钥的明文（草稿为空时点小眼睛走这里）。
			 *
			 * 已经显示着就收回：把明文从草稿里抹掉、恢复掩码，输入框回到点阵占位，
			 * 不在页面上留下残留的明文。
			 *
			 * 取回的值只写进该槽位的**本地草稿**（`drafts`），不写回快照、不进任何缓存：
			 * 快照永不含明文这条约定不变。用户如果此时点「保存密钥」，写回的是同一把密钥，
			 * 属无害的幂等写入。
			 *
			 * @param {string} ref - 凭据引用名。
			 */
			const onRevealStored = async (ref) => {
				/*
				 * 「已经显示着就收回」的判定必须**同步读到当前值**。
				 *
				 * 踩过两次坑，都源于用异步通道去读状态：
				 * 1. 用渲染闭包里的 `revealed[ref]` —— 连点时第二次读到旧闭包，重复拉明文；
				 * 2. 在 `setRevealed(current => {...})` 的更新函数里顺手把结果赋给外部变量
				 *    —— React 18+ 不保证更新函数在 `setState` 调用栈内同步执行（并发特性下
				 *    可能延后甚至重放），于是 `wasRevealed` 仍是 false，收回分支永远进不去，
				 *    实测「点第二次既不收回、又多请求一次」。
				 *
				 * 现在用 `useRef` 维护一份与 state 同步的镜像：它在事件处理器里**同步**可读，
				 * 且不受批量更新时机影响。这是「读最新状态再决定」的正确做法。
				 */
				if (shownRef.current[ref] === true) {
					const nextShown = { ...shownRef.current }
					delete nextShown[ref]
					shownRef.current = nextShown
					setRevealed(nextShown)
					// 收回：把明文从草稿里抹掉，输入框回到点阵占位，页面上不留残留值。
					setDrafts((current) => ({ ...current, [ref]: '' }))
					setFromStored((current) => {
						const next = { ...current }
						delete next[ref]
						return next
					})
					return
				}
				setRevealing((current) => ({ ...current, [ref]: true }))
				try {
					const result = await request('POST', 'keys/value/reveal', { ref })
					if (typeof result.value !== 'string' || result.value.length === 0) {
						setMessage({ text: `${ref} 没有可显示的密钥。`, tone: 'wsp-note-warn' })
						return
					}
					setDrafts((current) => ({ ...current, [ref]: result.value }))
					setFromStored((current) => ({ ...current, [ref]: true }))
					// 取到值之后才置为「显示中」：之前若先置位，失败时会留下「显示着但没内容」。
					shownRef.current = { ...shownRef.current, [ref]: true }
					setRevealed(shownRef.current)
					setMessage(undefined)
				} catch (failure) {
					setMessage({ text: String(failure?.message ?? failure), tone: 'wsp-note-err' })
				} finally {
					setRevealing((current) => {
						const next = { ...current }
						delete next[ref]
						return next
					})
				}
			}

			/** 保存 Tavily 选项。 */
			const onSaveOptions = () => {
				void run('options', () => request('PUT', 'options', { options }), t('saved'))
			}

			/**
			 * 接管 seam 的搜索提供方。
			 *
			 * 宿主**不会热切换** `web.searchProvider`，所以「写入成功 ≠ 已生效」。
			 * 宿主的回复带 `pendingRestart` 与 `message`，这里必须原样显示那条消息，
			 * 否则用户点完看到「配置有歧义」还在，会以为接管失败了（真实报障）。
			 *
			 * 用 warn 色调而不是 ok：这条消息的真实含义是「还差重启」。
			 */
			const onTakeover = () => {
				void run('takeover', async () => {
					const result = await request('POST', 'takeover', {})
					setMessage({
						text: String(result.message ?? '已接管。'),
						tone: result.pendingRestart === true ? 'wsp-note-warn' : 'wsp-note-ok'
					})
				})
			}

			/** 撤销接管，恢复组合默认的提供方。 */
			const onUndoTakeover = () => {
				void run('takeover', async () => {
					const result = await request('POST', 'takeover', { target: 'default' })
					setMessage({
						text: String(result.message ?? '已交还官方搜索。'),
						tone: result.pendingRestart === true ? 'wsp-note-warn' : 'wsp-note-ok'
					})
				})
			}

			/**
			 * 真跑一次搜索，展示实际经过的节点。
			 *
			 * 整个动作包在 run() 里（而不是手写 markPending/finally）：提示、在途标记、
			 * 快照刷新的顺序由此与其它按钮完全一致，也不会在开始时把上一轮的提示清掉
			 * ——那一次「清空 → 稍后重建」正是整页闪的另一个来源。
			 */
			const onProbe = () => {
				void run('probe', async () => {
					const result = await request('POST', 'probe', {})
					setProbe(result)
					// 探测结果本身就是这次操作的反馈：把结论写进提示行，「已接管」与否一目了然。
					const summary = result.takenOver === false
						? `未接管：这次走的是「${result.seamProvider ?? '自动选择'}」，没有经过本插件的优先级链。`
						: undefined
					setMessage(summary === undefined ? undefined : { text: summary, tone: 'wsp-note-warn' })
				})
			}

			/** 查询每个密钥的额度。 */
			const onUsage = () => {
				void run('usage', async () => {
					const result = await request('POST', 'keys/usage', {})
					setUsage(result.usage)
				})
			}

			if (error !== '' && snapshot === undefined) {
				return h('div', { className: 'wsp-page' },
					h('section', { className: 'wsp-card' },
						h('p', { className: 'wsp-note wsp-note-err' }, `${t('loadFailed')}：${error}`),
						h('div', { className: 'wsp-row' },
							h('button', { type: 'button', className: 'wsp-btn', onClick: () => void reload() }, t('retry')))))
			}
			if (snapshot === undefined) {
				return h('div', { className: 'wsp-page' },
					h('section', { className: 'wsp-card' },
						h('p', { className: 'wsp-desc' }, t('loading'))))
			}

			return h('div', { className: 'wsp-page' },
				h(PriorityCard, { t, snapshot, isPending, onMove }),
				h(KeysCard, {
					t,
					snapshot,
					isPending,
					drafts,
					revealed,
					revealing,
					fromStored,
					onDraft: (ref, value) => {
						// 用户一旦自己动手改内容，就不再是「从宿主取回的值」，
						// 之后再点小眼睛应退回普通掩码切换（不清他的输入）。
						setFromStored((current) => {
							if (current[ref] !== true) return current
							const next = { ...current }
							delete next[ref]
							return next
						})
						setDrafts((current) => ({ ...current, [ref]: value }))
					},
					onToggleReveal,
					onRevealStored,
					onSaveKey,
					onClearKey,
					onAddKey,
					onRemoveKey,
					onResetCooldowns
				}),
				h(OptionsCard, {
					t,
					snapshot,
					isPending,
					options,
					onOption: (key, value) => setOptions((current) => ({ ...current, [key]: value })),
					onSaveOptions
				}),
				h(StatusCard, { t, snapshot, isPending, onTakeover, onUndoTakeover, onProbe, onUsage, probe, usage, message }),
				snapshot.warnings.length > 0
					? h('section', { className: 'wsp-card' },
						h('div', { className: 'wsp-card-head' },
							h('h3', { className: 'wsp-head' }, t('warningsTitle')),
							h('p', { className: 'wsp-desc' }, t('warningsHint'))),
						// 警告与状态链同样是一组「条目」，因此用同一款盒子行，
						// 而不是另起一套裸列表——这是四个模块里最后一块不一致的地方。
						h('ul', { className: 'wsp-chain' }, snapshot.warnings.map((warning, index) => h('li', { className: 'wsp-box wsp-node', key: String(index) },
							h('span', { className: 'wsp-dot wsp-dot-warn' }),
							h('span', { className: 'wsp-node-main' },
								h('span', { className: 'wsp-node-hint' }, warning))))))
					: null)
		}

		/**
		 * 插件页需要的两种视图：卡片上的一句话说明，以及详情页里的完整页面。
		 *
		 * ## 为什么 summary 只是**一行文本**，不再自带标题和展开开关
		 *
		 * 早先这里返回 `t('summary')` 一行纯文本，用户报障「两张卡的简介连在一起」，
		 * 于是改成了「自带标题 + 展开按钮 + 原位渲染完整页」的卡片。那次改动引入了
		 * 两个新的真实缺陷（本次修复的问题）：
		 *
		 * 1. **标题重复**：`plugins.item` 的摘要位总是紧挨着宿主自己渲染的条目标题
		 *    （列表卡 `CardHead`、详情页 `detailMain`），摘要里再画一遍标题，页面上
		 *    就是同名两行。
		 * 2. **展开开关点不动 / 展开后两份实例**：宿主把摘要放在**标题按钮的整卡热区**
		 *    （`cardOpen::after { inset: 0 }`）之下，摘要里的任何按钮都被热区吃掉
		 *    「点击」——点「展开设置」实际是「打开详情页」；而摘要位在列表与详情页
		 *    各渲染一次，一旦展开就同时存在两份同一个页面、两套互不相通的 state。
		 *
		 * 现在摘要只保留**宿主摘要位缺的那一句说明**：标题由宿主渲染，完整设置在
		 * 详情页 `view: 'page'` 里渲染（那里没有整卡热区，也没有第二份实例）。
		 *
		 * ⚠️ 这里刻意渲染成 `<span>` 而不是 `<div>`：摘要位既会进卡片的
		 * `span.cardDesc`，也会进详情页的 `p.detailDesc`，块级元素塞进 `<p>` 会被
		 * 浏览器的解析器拆开，节点位置就不再可预测。
		 *
		 * @param {object} props - 含 `view` 与插槽注入的 `t`。
		 * @returns {object|null} 元素或空。
		 */
		function WebSearchPlusCard(props) {
			const t = props.t ?? ((key) => zh[key] ?? key)
			if (props.view !== 'summary') return h(WebSearchPlusPage, { t })
			/*
			 * `data-exp-tab="extensions"`：这张卡在「体验优化」平台的**扩展能力**选项卡
			 * 下显示（平台按容器上的 `data-exp-active-tab` 做 CSS 显隐）。
			 *
			 * 平台对**不带这个标记**的条目是宽容的（所有选项卡都显示），
			 * 标上它才算「归到这个 Tab」—— 不标也不会消失，只是不分类。
			 */
			return h('span', {
				className: 'wsp-summary',
				'data-exp-ext-id': 'web-search-plus',
				'data-exp-tab': 'extensions'
			}, h('span', { className: 'wsp-summary-desc' }, t('summary')))
		}

		/** 需要的客户端服务：插槽账本是唯一的硬依赖。 */
		const inject = ['slots', 'locale']

		/**
		 * 设置卡片的主插槽：「体验优化」设置平台声明的稳定子插槽。
		 *
		 * 名字是平台契约的一部分（`docs/settings-platform.md` §一：稳定契约、永不改名），
		 * 卡片因此与平台自己的功能出现在同一个分区里。
		 */
		const CARD_SLOT = 'experience-plus.item'
		/**
		 * 设置卡片的兜底插槽：内核「内置插件」页。
		 *
		 * 只在主插槽不可用时接管——平台没装、或平台自己的客户端没加载起来时，
		 * 设置卡片仍能显示，而不是整页够不着。
		 */
		const CARD_SLOT_FALLBACK = 'plugins.item'

		/**
		 * 探测一个插槽此刻是否已被声明。
		 *
		 * 判据必须是**同步探测**，而不是「`slots.inject` 的回调有没有被叫醒」：
		 * `inject` 只在插槽**出现**时回调，插槽不存在时它永远沉默——拿沉默当判据，
		 * 等于用「没等到」证明「不存在」。
		 *
		 * @param {object} ctx - 浏览器插件上下文。
		 * @param {string} key - 插槽名。
		 * @returns {boolean|undefined} true=已声明；false=未声明；undefined=无法确认（更老的内核没有 `spec`）。
		 */
		function slotDeclared(ctx, key) {
			const slots = ctx?.slots
			if (typeof slots?.spec !== 'function') return undefined
			try {
				return slots.spec(key) !== undefined
			} catch {
				return undefined
			}
		}

		/**
		 * 把设置卡片挂到「体验优化」平台的子插槽；平台不可用时退回内核「内置插件」页。
		 *
		 * 四条硬约束：
		 *
		 * 1. **同一时刻只挂一处**：主插槽可用时绝不注册到兜底插槽，否则内核「内置插件」
		 *    页会多出一张重复卡片，「统一归入体验优化」就不成立。
		 * 2. **注册一律发生在 `inject` 回调内部**：回调触发时该插槽必然已声明，
		 *    因此 `slots.register` 不会因为「插槽还没声明」而抛错；反过来，在回调外
		 *    抢先注册就得自己赌声明顺序，赌错会把异常抛穿到宿主。
		 * 3. **兜底的判据是正向状态，不是「平台回调没触发」**：兜底注册由**兜底插槽自己的**
		 *    声明回调驱动，只看「主插槽此刻是否由本插件占用」这一个正向状态，再用
		 *    `slots.spec()` 同步复查一次。平台回调迟迟不来不会阻塞兜底。
		 * 4. **随平台一起伸缩**：主插槽塌陷（平台卸载、分区收起）→ 卡片回到兜底插槽；
		 *    主插槽再次声明 → 卡片再迁回平台。本插件的 effect 卸载时两处注册都撤掉。
		 *
		 * @param {object} ctx - 浏览器插件上下文。
		 * @param {object} spec - 卡片规格：`id` / `order` / `label` / `locale`（`name` 由这里填）。
		 * @param {Function} Component - 卡片组件。
		 * @returns {() => void} 撤销函数。
		 */
		function registerSettingsCard(ctx, spec, Component) {
			/*
			 * 先探测、后使用（契约 §2.1）。
			 *
			 * `ctx.slots` 存在**不代表**它有 `inject` / `register`：内核改过方法名、
			 * 或某个版本只暴露一部分能力时，直接调用会抛 `TypeError`，而这段代码跑在
			 * `apply()` 里，异常会一路穿出去把整个插件判成 FAILED（§2.2 明令禁止）。
			 *
			 * 探测不通过就**停用这张卡片**并记一条写明缺什么的日志：
			 * 设置项少一个，好过整个插件红掉。
			 */
			const slots = ctx?.slots
			const lacking = []
			if (typeof slots?.inject !== 'function') lacking.push('ctx.slots.inject')
			if (typeof slots?.register !== 'function') lacking.push('ctx.slots.register')
			if (lacking.length > 0) {
				console.warn(`dsh-web-search-plus: 设置卡片停用 -> 缺少 ${lacking.join('、')}（当前 DSH 版本的插槽服务不支持）`)
				return () => {}
			}

			/** 插槽名 → 该插槽上那张卡片的撤销函数；同一时刻最多一个。 */
			const mounted = new Map()
			/** 主插槽此刻是否由本插件占用（正向状态，不由「沉默」推断）。 */
			let platformActive = false
			/** 兜底插槽此刻是否处于声明期（它的回调已触发且尚未塌陷）。 */
			let fallbackActive = false
			/** 本 effect 是否已卸载。 */
			let stopped = false

			/**
			 * 往某个插槽挂卡片；已挂过或已卸载就不动。
			 * @param {string} slot - 插槽名。
			 */
			const mount = (slot) => {
				if (stopped || mounted.has(slot)) return
				try {
					mounted.set(slot, ctx.slots.register({ ...spec, name: slot }, Component))
				} catch (failure) {
					// 注册失败只影响这张卡片：记一条可读日志，异常绝不抛穿到宿主
					// （契约文档 §二.2：一个功能挂掉不能影响其它功能）。
					console.warn(`dsh-web-search-plus: 设置卡片注册失败 -> ${slot}`, failure)
				}
			}
			/**
			 * 撤掉某个插槽上的卡片；没挂过就不动。
			 * @param {string} slot - 插槽名。
			 */
			const unmount = (slot) => {
				/*
				 * 存在性看 `mounted` 表**本身**，而不是「撤销函数是不是函数」。
				 *
				 * 形状漂移时 `register` 可能不返回撤销函数（fire-and-forget 版本），
				 * 用返回值判断会把「挂过」误当成「没挂过」，在表里留下一个永远删不掉的
				 * 陈旧条目 —— 表现是平台塌陷一次之后，再声明也回不到平台插槽
				 * （本仓库实测：卡片会永久卡在兜底插槽）。
				 */
				if (!mounted.has(slot)) return
				const dispose = mounted.get(slot)
				mounted.delete(slot)
				if (typeof dispose === 'function') dispose()
			}

			/*
			 * 两处 inject 控制器。
			 *
			 * 探测通过也可能在**调用那一刻**抛错（内核实现差异、服务被换过），
			 * 所以先给 no-op 兜底：任何一处失败都只撤掉已装上的那一半、记日志，
			 * 绝不抛穿（§2.2）。
			 */
			let stopPlatform = () => {}
			let stopFallback = () => {}
			try {
				// 先装主插槽的等待：主插槽若已声明，`inject` 会**同步**回调，于是
				// platformActive 立刻为真，下面的兜底就不会重复注册。
				stopPlatform = ctx.slots.inject(CARD_SLOT, () => {
					mount(CARD_SLOT)
					platformActive = mounted.has(CARD_SLOT)
					// 只有主插槽真的挂上了才撤兜底，否则会两头都空。
					if (platformActive) unmount(CARD_SLOT_FALLBACK)
					return () => {
						platformActive = false
						unmount(CARD_SLOT)
						// 平台撤了：卡片回到兜底插槽（若它仍在声明期），设置项不会凭空消失。
						if (fallbackActive && slotDeclared(ctx, CARD_SLOT) !== true) mount(CARD_SLOT_FALLBACK)
					}
				})
				// 再装兜底插槽的等待：只有主插槽没接管时才注册。
				stopFallback = ctx.slots.inject(CARD_SLOT_FALLBACK, () => {
					fallbackActive = true
					if (platformActive !== true && slotDeclared(ctx, CARD_SLOT) !== true) mount(CARD_SLOT_FALLBACK)
					return () => {
						fallbackActive = false
						unmount(CARD_SLOT_FALLBACK)
					}
				})
			} catch (failure) {
				console.warn(`dsh-web-search-plus: 设置卡片等待插槽失败 -> ${CARD_SLOT} / ${CARD_SLOT_FALLBACK}`, failure)
				// 先置 stopped 再撤：避免撤销回调里的「平台撤了→回兜底」再挂一次。
				stopped = true
				try { stopPlatform() } catch { /* 撤销本身失败不影响降级结论 */ }
				try { stopFallback() } catch { /* 同上 */ }
				unmount(CARD_SLOT)
				unmount(CARD_SLOT_FALLBACK)
				return () => {}
			}

			return () => {
				stopped = true
				stopPlatform()
				stopFallback()
				unmount(CARD_SLOT)
				unmount(CARD_SLOT_FALLBACK)
			}
		}

		/**
		 * 注册插件页卡片与页面。
		 * @param {object} ctx - 浏览器插件上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement('style')
				style.dataset.plugin = 'dsh-web-search-plus'
				style.textContent = CSS
				document.head.appendChild(style)
				return () => style.remove()
			}, 'dsh-web-search-plus: styles')

			// 先登记字典再取读取器：`bind` 拿到的读取器在字典覆盖之前会回退到键名，
			// 因此顺序反了会让首个渲染帧短暂显示键名。
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-search-plus: dictionaries')
			const t = ctx.locale.bind(NS)

			// 卡片注册进「体验优化」平台的子插槽；平台不可用时由 registerSettingsCard
			// 兜底到内核「内置插件」页，两条路径的取舍全在它内部。
			//
			// order 60：平台自己的功能占 10–50，55 是「扩展能力」分组标题，
			// 所以第三方扩展卡从 60 起排 —— 这样它们整组落在自己的标题之下，
			// 而不是插在平台功能中间（原先的 41 就插在「自动化」和「桌面端」之间）。
			ctx.effect(() => registerSettingsCard(ctx, {
				id: 'web-search-plus',
				order: 60,
				label: () => t('title'),
				locale: NS
			}, WebSearchPlusCard), 'dsh-web-search-plus: settings card (experience-plus.item, fallback plugins.item)')
		}

		return { apply, inject, NS, WebSearchPlusCard, WebSearchPlusPage, registerSettingsCard, slotDeclared, KeyInput }
	}
})
