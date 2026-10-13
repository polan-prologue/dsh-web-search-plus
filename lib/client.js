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
			expand: '展开设置',
			collapse: '收起设置',
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
			keyRevealHint: '先输入密钥内容才能查看明文。',
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
			expand: 'Show settings',
			collapse: 'Hide settings',
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
			keyRevealHint: 'Type a key first to reveal its plain text.',
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

		/* ── 设置卡片摘要（展开后原位渲染完整页面） ─────────────────────── */
		/*
		 * 摘要要跟「体验优化」分区里平台自己的行式条目**看起来同族**：
		 * 左标题 + 灰色一行简介 / 右侧动作，行高与分区其它条目一致
		 * （14/20 标题、12/18 简介、上下各 16px）。
		 *
		 * 只能抄字面量而不是复用变量：两个插件的 CSS 不共享作用域，
		 * 而分区那边的类名属于平台私有、不得引用（见平台契约第五节）。
		 *
		 * ⚠️ **类名前缀必须先在本文档里查重**。这段最早叫 .wsp-card / .wsp-card-head，
		 * 而那两个名字**本插件页面里早就有了**（见上面的 section 卡片）——
		 * 结果是新规则只覆盖了它写到的属性，没写到的（flex-direction、padding、
		 * border、border-radius、background）全部从旧规则串过来：标题被排成竖列、
		 * 卡片凭空多出一圈边框和大内边距。样式串味不报错，只能靠人眼在界面上发现。
		 * 所以这里改用本文件里未被占用的 .wsp-summary 前缀。
		 */
		.wsp-summary { display: flex; flex-direction: column; }
		.wsp-summary-head {
			display: flex; flex-direction: row; align-items: center; justify-content: space-between;
			gap: 24px; padding: 16px 0;
		}
		.wsp-summary-text { display: flex; flex-direction: column; min-width: 0; }
		.wsp-summary-title { font-size: 14px; line-height: 20px; color: var(--dsw-alias-label-primary); }
		.wsp-summary-desc {
			margin-top: 4px; font-size: 12px; line-height: 18px;
			color: var(--dsw-alias-label-secondary);
			overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.wsp-summary-action {
			flex: none; height: 30px; padding: 0 14px;
			border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px);
			background: transparent; font: inherit; font-size: 12px; line-height: 1; cursor: pointer;
			color: var(--dsw-alias-label-secondary);
		}
		.wsp-summary-action:hover { color: var(--dsw-alias-label-primary); }
		.wsp-summary-action:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
		.wsp-summary-body { padding: 0 0 12px; }

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
			const { t, snapshot, busy, onMove } = props
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
					h('button', {
						className: 'wsp-btn',
						disabled: busy || index === 0,
						onClick: () => onMove(index, index - 1)
					}, t('moveUp')),
					h('button', {
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
			const { t, snapshot, busy, drafts, revealed, onDraft, onToggleReveal, onSaveKey, onClearKey, onAddKey, onRemoveKey, onResetCooldowns } = props
			return h('section', { className: 'wsp-card' },
				h('div', { className: 'wsp-card-head' },
					h('h3', { className: 'wsp-head' }, t('keysTitle')),
					h('p', { className: 'wsp-desc' }, t('keysHint'))),
				snapshot.keys.map((slot) => {
					const state = slotState(slot, t)
					return h('div', { className: 'wsp-box wsp-key', key: slot.ref },
						h('div', { className: 'wsp-key-head' },
							h('span', { className: 'wsp-mono' }, slot.ref),
							h('span', { className: state.tone }, state.text),
							slot.sticky === true ? h('span', { className: 'wsp-badge wsp-ok' }, t('sticky')) : null,
							slot.writable === false ? h('span', { className: 'wsp-badge' }, t('keyUnwritable')) : null,
							h('span', { className: 'wsp-grow' }),
							h('button', {
								className: 'wsp-btn',
								disabled: busy || slot.writable === false,
								onClick: () => onClearKey(slot.ref)
							}, t('keyClear')),
							h('button', {
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
								onToggle: () => onToggleReveal(slot.ref)
							}),
							h('button', {
								className: 'wsp-btn wsp-btn-primary',
								disabled: busy || slot.writable === false || (drafts[slot.ref] ?? '').trim().length === 0,
								onClick: () => onSaveKey(slot.ref)
							}, t('keySave'))),
						slot.reason !== undefined ? h('p', { className: 'wsp-note wsp-note-warn' }, slot.reason) : null)
				}),
				// wsp-actions 让本行内容与上方密钥槽位的内容左右对齐（各让出一个盒内边距）。
				h('div', { className: 'wsp-row wsp-actions' },
					h('button', { className: 'wsp-btn', disabled: busy, onClick: onAddKey }, t('addKey')),
					h('button', { className: 'wsp-btn', disabled: busy, onClick: onResetCooldowns }, t('resetCooldowns')),
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
			const { t, snapshot, busy, options, onOption, onSaveOptions } = props
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
							h('button', { className: 'wsp-btn wsp-btn-primary', disabled: busy, onClick: onSaveOptions }, busy ? t('saving') : t('save')))))))
		}

		/**
		 * 运行状态区：接管状态、链路实况、探测与额度检测。
		 * @param {object} props - 快照、动作与探测结果。
		 * @returns {object} React 元素。
		 */
		function StatusCard(props) {
			const { t, snapshot, busy, onTakeover, onUndoTakeover, onProbe, onUsage, probe, usage, message } = props
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
					h('button', {
						className: 'wsp-btn wsp-btn-primary',
						disabled: busy || !takeover.canRepair || takeover.active,
						onClick: onTakeover
					}, t('takeoverDo')),
					h('button', {
						className: 'wsp-btn',
						disabled: busy || !takeover.canRepair || !takeover.active,
						onClick: onUndoTakeover
					}, t('takeoverUndo')),
					h('button', { className: 'wsp-btn', disabled: busy, onClick: onProbe }, busy ? t('probing') : t('probeRun')),
					h('button', { className: 'wsp-btn', disabled: busy, onClick: onUsage }, busy ? t('usageChecking') : t('usageCheck'))),
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
						h('p', { className: 'wsp-note wsp-mono' }, `${String(probe.sourceCount)} 条来源`))
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
				message !== undefined ? h('p', { className: `wsp-note ${message.tone}` }, message.text) : null)
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
		 * 显示规则是「有内容就看得见，与是否已落库无关」：
		 *
		 * - 输入框里**有草稿**（刚输入或刚保存）→ 按眼睛开关显示掩码或明文；
		 * - 草稿为空但该槽位**已保存密钥** → 用点阵占位表示「这里已有一把密钥」。
		 *
		 * 之所以用占位而不是真值：宿主（以及官方的 `SettingsSecretField`）**从不回传**
		 * 已保存密钥的字面值，这是凭据域的硬约定。因此点阵是「已配置」的视觉提示，
		 * 不是密钥长度，也不参与提交——保存按钮在草稿为空时是禁用的，不会把点存进去。
		 *
		 * @param {object} props - 输入框属性。
		 * @returns {object} React 元素。
		 */
		function KeyInput(props) {
			const { t, value, revealed, disabled, configured, placeholder, onChange, onToggle } = props
			const empty = value.length === 0
			const stored = empty && configured === true
			// 只有草稿里有真实内容时才谈得上「查看明文」。
			const canReveal = !empty
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
					disabled: disabled || !canReveal,
					'aria-label': revealed ? t('keyHide') : t('keyShow'),
					'aria-pressed': revealed,
					title: canReveal ? (revealed ? t('keyHide') : t('keyShow')) : t('keyRevealHint'),
					onClick: onToggle
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
			const [busy, setBusy] = react.useState(false)
			const [drafts, setDrafts] = react.useState({})
			/**
			 * 哪些槽位当前**明文可见**（按引用名索引）。
			 *
			 * 默认全部掩码：密钥是敏感输入，不能因为「上次点过眼睛」就在下次打开时
			 * 直接摊在屏幕上。切换只影响显示，不影响提交的值。
			 */
			const [revealed, setRevealed] = react.useState({})
			const [options, setOptions] = react.useState({})
			const [probe, setProbe] = react.useState(undefined)
			const [usage, setUsage] = react.useState(undefined)
			const [message, setMessage] = react.useState(undefined)

			/** 重新读取宿主快照，并把选项草稿同步成新值。 */
			const reload = react.useCallback(async () => {
				try {
					const next = await request('GET', '')
					setSnapshot(next)
					setError('')
					setOptions((current) => {
						const keys = ['tavilyBaseURL', 'tavilySearchDepth', 'tavilyMaxResults', 'tavilyTimeoutMs', 'tavilyRateLimitCooldownMs', 'tavilyIncludeAnswer']
						const merged = { ...current }
						for (const key of keys) merged[key] = next.config[key]
						return merged
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
			 * 包一层「置忙 → 执行 → 刷新 → 清忙」，让所有动作共享同一套错误呈现。
			 * @param {() => Promise<unknown>} operation - 动作。
			 * @param {string} [okText] - 成功提示。
			 */
			const run = react.useCallback(async (operation, okText) => {
				setBusy(true)
				setMessage(undefined)
				try {
					await operation()
					await reload()
					if (okText !== undefined) setMessage({ text: okText, tone: 'wsp-note-ok' })
				} catch (failure) {
					setMessage({ text: String(failure?.message ?? failure), tone: 'wsp-note-err' })
				} finally {
					setBusy(false)
				}
			}, [reload])

			/** 调整优先级顺序。 */
			const onMove = (from, to) => {
				const nodes = [...snapshot.config.priority]
				const [moved] = nodes.splice(from, 1)
				nodes.splice(to, 0, moved)
				void run(() => request('PUT', 'priority', { priority: nodes }), t('saved'))
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
				void run(() => request('POST', 'keys/value', { ref, value }), `${ref} 已保存`)
			}

			/** 清除某个槽位已存的密钥（保留槽位）。 */
			const onClearKey = (ref) => {
				void run(() => request('DELETE', 'keys/value', { ref }), `${ref} 已清除`)
			}

			/** 追加一个密钥槽位。 */
			const onAddKey = () => {
				void run(async () => {
					const result = await request('POST', 'keys', {})
					setSnapshot(result)
				}, t('saved'))
			}

			/** 移除一个密钥槽位（同时尽力清除其已存密钥）。 */
			const onRemoveKey = (ref) => {
				void run(() => request('DELETE', 'keys', { ref }), `${ref} 已移除`)
			}

			/** 重置所有冷却与失效标记。 */
			const onResetCooldowns = () => {
				void run(() => request('POST', 'keys/reset', {}), t('saved'))
			}

			/** 切换某个槽位的明文显示。只影响显示，不改动输入值。 */
			const onToggleReveal = (ref) => {
				setRevealed((current) => ({ ...current, [ref]: current[ref] !== true }))
			}

			/** 保存 Tavily 选项。 */
			const onSaveOptions = () => {
				void run(() => request('PUT', 'options', { options }), t('saved'))
			}

			/** 接管 seam 的搜索提供方。 */
			const onTakeover = () => {
				void run(() => request('POST', 'takeover', {}), '已接管：联网搜索现在按你的优先级顺序执行。')
			}

			/** 撤销接管，恢复组合默认的提供方。 */
			const onUndoTakeover = () => {
				void run(() => request('POST', 'takeover', { target: 'default' }), '已撤销接管，恢复组合默认提供方。')
			}

			/** 真跑一次搜索，展示实际经过的节点。 */
			const onProbe = () => {
				setBusy(true)
				setMessage(undefined)
				setProbe(undefined)
				request('POST', 'probe', {})
					.then((result) => {
						setProbe(result)
						return reload()
					})
					.catch((failure) => setMessage({ text: String(failure?.message ?? failure), tone: 'wsp-note-err' }))
					.finally(() => setBusy(false))
			}

			/** 查询每个密钥的额度。 */
			const onUsage = () => {
				setBusy(true)
				setMessage(undefined)
				request('POST', 'keys/usage', {})
					.then((result) => setUsage(result.usage))
					.catch((failure) => setMessage({ text: String(failure?.message ?? failure), tone: 'wsp-note-err' }))
					.finally(() => setBusy(false))
			}

			if (error !== '' && snapshot === undefined) {
				return h('div', { className: 'wsp-page' },
					h('section', { className: 'wsp-card' },
						h('p', { className: 'wsp-note wsp-note-err' }, `${t('loadFailed')}：${error}`),
						h('div', { className: 'wsp-row' },
							h('button', { className: 'wsp-btn', onClick: () => void reload() }, t('retry')))))
			}
			if (snapshot === undefined) {
				return h('div', { className: 'wsp-page' },
					h('section', { className: 'wsp-card' },
						h('p', { className: 'wsp-desc' }, t('loading'))))
			}

			return h('div', { className: 'wsp-page' },
				h(PriorityCard, { t, snapshot, busy, onMove }),
				h(KeysCard, {
					t,
					snapshot,
					busy,
					drafts,
					revealed,
					onDraft: (ref, value) => setDrafts((current) => ({ ...current, [ref]: value })),
					onToggleReveal,
					onSaveKey,
					onClearKey,
					onAddKey,
					onRemoveKey,
					onResetCooldowns
				}),
				h(OptionsCard, {
					t,
					snapshot,
					busy,
					options,
					onOption: (key, value) => setOptions((current) => ({ ...current, [key]: value })),
					onSaveOptions
				}),
				h(StatusCard, { t, snapshot, busy, onTakeover, onUndoTakeover, onProbe, onUsage, probe, usage, message }),
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
		 * 插件页需要的两种视图：卡片上的简介，以及展开后的完整页面。
		 *
		 * ## 为什么 summary 不再是「一行纯文本」
		 *
		 * 早先这里写的是 `return t('summary')` —— 在「体验优化」分区里，
		 * 插槽会把**每个条目各渲染一次**，于是两张卡片的简介文本直接首尾相接，
		 * 变成一整段没有标题、没有控件的粗体长文（用户截图报障的正是这个）。
		 *
		 * 现在 summary 渲染成**一张自带标题的卡片**：标题 + 一行简介 + 右侧展开开关；
		 * 展开后在原位渲染完整设置页，所以「看得到完整设置内容」这件事不再依赖跳转。
		 * 收起状态下只占一行的高度，多张卡片也不会互相挤。
		 *
		 * ⚠️ `useState` 必须在**所有分支之前**调用（Rules of Hooks）——
		 * 把 `view !== 'summary'` 的判断挪到它上面，切换视图时就会抛
		 * "Rendered fewer hooks than expected"，整张卡片消失。
		 *
		 * @param {object} props - 含 `view` 与插槽注入的 `t`。
		 * @returns {object|null} 元素或空。
		 */
		function WebSearchPlusCard(props) {
			const t = props.t ?? ((key) => zh[key] ?? key)
			const [expanded, setExpanded] = react.useState(false)
			if (props.view !== 'summary') return h(WebSearchPlusPage, { t })
			/*
			 * `data-exp-tab="extensions"`：这张卡在「体验优化」平台的**扩展能力**
			 * 选项卡下显示（平台按容器上的 `data-exp-active-tab` 做 CSS 显隐）。
			 *
			 * 平台对**不带这个标记**的条目是宽容的（所有选项卡都显示），
			 * 标上它才算「归到这个 Tab」—— 不标也不会消失，只是不分类。
			 */
			return h('div', {
				className: 'wsp-summary',
				'data-exp-ext-id': 'web-search-plus',
				'data-exp-tab': 'extensions',
				'data-expanded': expanded ? '1' : undefined
			},
				h('div', { className: 'wsp-summary-head' },
					h('div', { className: 'wsp-summary-text' },
						h('div', { className: 'wsp-summary-title' }, t('title')),
						h('div', { className: 'wsp-summary-desc' }, t('summary'))),
					h('button', {
						type: 'button',
						className: 'wsp-summary-action',
						'aria-expanded': expanded,
						onClick: () => setExpanded((value) => value !== true)
					}, expanded ? t('collapse') : t('expand'))),
				expanded ? h('div', { className: 'wsp-summary-body' }, h(WebSearchPlusPage, { t })) : null)
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

		return { apply, inject, NS, WebSearchPlusCard, WebSearchPlusPage, registerSettingsCard, slotDeclared }
	}
})
