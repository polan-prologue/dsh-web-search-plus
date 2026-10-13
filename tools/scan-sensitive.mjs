/**
 * 上传前的凭据/个人信息扫描（可复现）。
 *
 * ## 为什么要有这个脚本而不是「我看了一眼」
 *
 * 「检查一遍没有敏感信息」这句话必须**可复现、可复核**：换个人、换一天
 * 跑同一条命令应当得到同一份结论。人工通读 400KB 源码给不出这种保证，
 * 而且下一次改动之后没人会再读一遍。
 *
 * ## 它查什么
 *
 * 1. **已知形态的真实凭据**：各家的 API key 前缀（sk- / ghp_ / glpat- …）、
 *    PEM 私钥块、JWT、带账号密码的连接串、内联到 URL 里的 basic auth；
 * 2. **疑似赋值的凭据**：`token/password/secret/apiKey = "..."` 这类，且右侧
 *    不是占位符（`<your-token>` / `${ENV}` / 空串 / 明显假值）；
 * 3. **个人信息**：本机用户名、用户主目录、会话 UUID、邮箱、手机号；
 * 4. **不该入库的文件**：诊断日志、备份、`.env`、凭据库。
 *
 * ## 它刻意不做什么
 *
 * 不做「自动改写」。扫描器只报告 —— 自动把命中内容替换成占位符，
 * 正是最容易把真实凭据**留在 git 历史里**的做法（工作区干净了，历史还是脏的）。
 *
 * 用法：
 *   node tools/scan-sensitive.mjs            # 扫描工作区（排除 .git/node_modules）
 *   node tools/scan-sensitive.mjs --staged   # 只扫暂存区内容（git show :file）
 *   node tools/scan-sensitive.mjs --history  # 扫整个 git 历史（每个版本的内容）
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 扫描根目录：默认是**本脚本所在插件的根**，可用 `--root <路径>` 覆盖。
 *
 * ## 为什么要这个开关（踩过的假结论）
 *
 * 本脚本每个插件各带一份。早先 `ROOT` 由 `import.meta.url` 推出且**不可覆盖**，
 * 于是「拿 A 插件的脚本去扫 B 插件」时，它照旧扫 A —— 报出来的命中全是 A 的文件。
 * 那种失败极具欺骗性：命令跑通了、报告也出来了，**只是扫的不是你要扫的东西**。
 *
 * 所以：跨插件复用脚本时**必须显式传 `--root`**；拿不准时看报告开头的
 * 「扫描根」一行（它写的就是实际扫的那个目录）。
 */
const ROOT = resolveRoot()

/**
 * 解析 `--root <路径>`（缺省为本脚本所在插件的根）。
 *
 * @returns 绝对路径。
 */
function resolveRoot() {
	const at = process.argv.indexOf('--root')
	if (at >= 0 && typeof process.argv[at + 1] === 'string' && process.argv[at + 1] !== '') {
		return resolve(process.argv[at + 1])
	}
	return join(fileURLToPath(import.meta.url), '..', '..')
}

/** 永不扫描的目录（体积大且与自己无关）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.runtime'])

/** 只扫文本文件；二进制按扩展名跳过（它们不承载凭据，误报代价却很高）。 */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.gz', '.asar', '.exe', '.node'])

/**
 * 规则表。
 *
 * `severity`：
 * - `blocker`：命中即**不得上传**（真实凭据、私钥、个人信息）；
 * - `warn`：需要人看一眼再决定（可能是示例、可能是漏网）。
 *
 * `allow` 是「命中但这不算问题」的模式：占位符、环境变量引用、明显的示例值。
 * 没有它，扫描器会天天报「password: 'xxx'」，然后被人关掉。
 */
const RULES = [
	{
		id: 'api-key-prefix',
		severity: 'blocker',
		describe: '已知形态的 API key / 访问令牌',
		/*
		 * ⚠️ 前缀表必须**跟着依赖长**（踩过）：本插件最早只认 `sk-` / `ghp_` 这些
		 * 通用前缀，而「网页搜索++」用的是 Tavily —— 它的密钥前缀是 `tvly-`，
		 * 当时完全不在表里。也就是说：**一个真的 Tavily 密钥提交上去，扫描器
		 * 一声不响**。加新依赖（尤其是带密钥的服务）时，请把它加进这张表。
		 *
		 * 长度门槛取 20：比这短的多半是测试里的假值（`tvly-new` / `tvly-xxx`）。
		 */
		pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{20,}|tvly-[A-Za-z0-9_-]{20,})\b/gu,
		allow: [
			/*
			 * 测试假值。白名单刻意**只放过「一眼看得出是假的」**：
			 * `-invalid-` / `-secret` / `-fake` / `-test` / `-dummy` / `-example`
			 * 这些词出现在密钥中间时，它不可能是真钥。
			 *
			 * 反过来**不能**放宽成「出现在 tests/ 或 docs/ 里就不算」——
			 * 那等于对最容易夹带真实密钥的两类文件停止检查。
			 */
			/tvly-[\w-]*-(?:invalid|secret|fake|dummy|test|example)[\w-]*/iu
		]
	},
	{
		id: 'private-key',
		severity: 'blocker',
		describe: 'PEM 私钥块',
		pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gu,
		allow: []
	},
	{
		id: 'jwt',
		severity: 'blocker',
		describe: 'JWT（三段式，常见于硬编码的登录态）',
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
		allow: []
	},
	{
		id: 'connection-string',
		severity: 'blocker',
		describe: '带账号密码的连接串',
		pattern: /\b[a-z][a-z0-9+.-]{2,}:\/\/[^\s/:@'"]+:[^\s/@'"]+@[^\s/]+/giu,
		// 文档里举反例时常用 `user:pass@host` 这种明显的假值。
		allow: [/:\/\/[^/]*\b(?:user|username|pass|password|passwd|pwd|secret|token|<[^>]+>|\$\{[^}]+\})[:@]/iu]
	},
	{
		id: 'assigned-secret',
		severity: 'warn',
		describe: '疑似把凭据写在赋值里',
		pattern: /\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|secret)\b\s*[:=]\s*['"`]([^'"`\n]{6,})['"`]/giu,
		allow: [
			// 占位符与模板引用。
			/[:=]\s*['"`][^'"`]*<[^>]+>[^'"`]*['"`]/iu,
			/[:=]\s*['"`][^'"`]*\$\{[^}]+\}[^'"`]*['"`]/iu,
			// 明显不是凭据的词。
			/[:=]\s*['"`](?:undefined|null|none|''|""|placeholder|例|示例|test|dummy|fake|xxx+|your[-_ ]?\w*|redacted|hidden|\*+)[^'"`]*['"`]/iu
		]
	},
	{
		id: 'personal-path',
		severity: 'blocker',
		describe: '本机用户目录 / 用户名（个人信息）',
		pattern: null,
		build() {
			const user = process.env.USERNAME ?? process.env.USER ?? ''
			const home = homedir()
			const patterns = [new RegExp(escapeRegExp(home.replace(/\\/gu, '\\\\')), 'gu')]
			if (user !== '') {
				patterns.push(new RegExp(`[Cc]:[\\\\/]{1,2}Users[\\\\/]{1,2}${escapeRegExp(user)}\\b`, 'gu'))
			}
			return patterns
		},
		allow: []
	},
	{
		id: 'session-uuid',
		severity: 'blocker',
		describe: '会话 UUID（本机会话标识，不该公开）',
		pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
		// 文档里的示例 UUID 常写成全 0/全 1 或带 x 的骨架。
		allow: [/^(?:0{8}-0{4}-0{4}-0{4}-0{12}|1{8}-1{4}-1{4}-1{4}-1{12})$/iu]
	},
	{
		id: 'email',
		severity: 'warn',
		describe: '邮箱地址',
		pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu,
		// 依赖名、示例域名、以及 GitHub 的 noreply 地址都不算个人信息。
		allow: [
			/@(?:example\.(?:com|org|net)|localhost|test\.\w+|invalid)\b/iu,
			/@users\.noreply\.github\.com$/iu,
			/*
			 * `git@github.com` / `git@github.com:owner/repo.git` 是 **SSH 形式的
			 * 仓库地址**，不是邮箱。代码里用它解析 `repository` 字段
			 * （`readManifestRepository`），会被邮箱规则误报。
			 *
			 * ⚠️ 放宽到「允许缺冒号」是必须的：源码里写作
			 * `startsWith('git@github.com:')` 时，邮箱规则匹配到的是**引号内的那一段**
			 * （`"git@github.com"`），剥掉引号后也没有冒号 —— 只认带冒号的形式，
			 * 这个假阳性就永远消不掉。真有 `someone@github.com` 这种邮箱照样会命中。
			 */
			/^git@github\.com(:|$)/iu,
			/^[\w.+-]+@(?:deepseek|anthropic|openai)\.\w+$/iu
		]
	},
	{
		id: 'cn-mobile',
		severity: 'warn',
		describe: '中国大陆手机号',
		pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/gu,
		// 版本号/时间戳长这样时容易误报：前后必须是词边界已经由环视保证。
		allow: []
	},
	{
		id: 'forbidden-file',
		severity: 'blocker',
		describe: '不该入库的文件（诊断日志 / 备份 / .env / 凭据库）',
		pattern: null,
		matchPath: /(?:^|[\\/])(?:\.env(?:\..*)?|\.credentials\.yaml|client-diagnostics\.jsonl|.*\.bak(?:-.*)?|.*\.jsonl)$/iu,
		allow: []
	}
]

/** 转义正则元字符。 */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * 需要跳过的**路径**白名单：扫描器自己的规则表里必然写着这些关键字。
 *
 * 这不是「放水」：规则表里的 `password` 是**模式名**，不是凭据。
 * 把扫描器自己算进去，只会得到一堆永远无法消除的命中。
 */
const SKIP_PATHS = [join('tools', 'scan-sensitive.mjs')]

/** 递归列出待扫文件。 */
function listFiles(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name)
		const info = statSync(full)
		if (info.isDirectory()) {
			if (SKIP_DIRS.has(name)) continue
			listFiles(full, out)
			continue
		}
		const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
		if (BINARY_EXT.has(ext)) continue
		if (info.size > 4 * 1024 * 1024) continue
		out.push(full)
	}
	return out
}

/** 每条规则编译一次（`build()` 型的规则在这里展开，只有 `matchPath` 的规则没有模式）。 */
function compileRules() {
	return RULES.map((rule) => {
		let patterns = []
		if (typeof rule.build === 'function') patterns = rule.build()
		else if (rule.pattern !== null && rule.pattern !== undefined) patterns = [rule.pattern]
		return { ...rule, patterns }
	})
}

/**
 * 取匹配值里**真正的负载**：剥掉首尾引号、括号、点号等包裹字符。
 *
 * ## 为什么必须剥（实测的假阳性）
 *
 * 源码里写 `startsWith('git@github.com:')` 时，邮箱规则会把
 * **带引号的那一段**匹配出来（`"git@github.com"`）。白名单写的是
 * `^git@github\.com:`，于是既不匹配带引号的、也不匹配缺冒号的 —— 两条规则
 * 各自都「对」，合起来却让一个 SSH 地址被报成邮箱。
 *
 * 剥壳之后，白名单只需针对负载本身写；而**裸文本**（`git@github.com` 出现在
 * 文档里）也一并被正确判掉。
 *
 * @param text - 正则匹配到的原文。
 * @returns 去掉首尾非字母数字字符的结果。
 */
function unwrapMatch(text) {
	return text.replace(/^[^A-Za-z0-9]+/u, '').replace(/[^A-Za-z0-9]+$/u, '')
}

/**
 * 扫一段文本，返回命中列表。
 *
 * @param label - 展示用的位置（相对路径或 `file@commit`）。
 * @param text - 内容。
 * @param rules - {@link compileRules} 的结果。
 * @returns 命中数组。
 */
function scanText(label, text, rules) {
	const hits = []
	const lines = text.split(/\r?\n/u)
	for (const rule of rules) {
		for (const pattern of rule.patterns) {
			// 正则带 g：逐行重置 lastIndex，避免跨行状态残留。
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index]
				pattern.lastIndex = 0
				let match
				while ((match = pattern.exec(line)) !== null) {
					const whole = match[0]
					const bare = unwrapMatch(whole)
					if (rule.allow.some((allowed) => allowed.test(whole) || allowed.test(bare))) continue
					hits.push({
						rule: rule.id,
						severity: rule.severity,
						describe: rule.describe,
						label,
						line: index + 1,
						// 只回显**命中片段**，不整行回显：整行里可能真有凭据，
						// 而这份报告本身要被贴进对话/issue。
						snippet: whole.length > 60 ? `${whole.slice(0, 57)}…` : whole
					})
				}
			}
		}
	}
	return hits
}

/** 工作区扫描。 */
function scanWorkspace(rules) {
	const hits = []
	for (const file of listFiles(ROOT)) {
		const rel = relative(ROOT, file)
		if (SKIP_PATHS.some((skip) => rel === skip)) continue
		for (const rule of rules) {
			if (rule.matchPath === undefined) continue
			if (rule.matchPath.test(rel)) {
				hits.push({
					rule: rule.id,
					severity: rule.severity,
					describe: rule.describe,
					label: rel,
					line: 1,
					snippet: rel
				})
			}
		}
		const text = readFileSync(file, 'utf8')
		hits.push(...scanText(rel, text, rules))
	}
	return hits
}

/**
 * 跑一条 git 命令并取回文本输出。
 *
 * ## ⚠️ 必须关掉 `core.quotepath`（实测的静默漏扫）
 *
 * git 默认会把非 ASCII 文件名**转义成八进制**输出：
 * `tools/应用桌面补丁.cmd` 变成 `"tools/\345\272\224..."`。拿它去
 * `git show :<path>` 会直接报 `ambiguous argument` —— 而本脚本原先的
 * `try/catch` 会把这条报错**静默吞掉**，于是**中文名的文件一个都没被扫**。
 * 两个 `.cmd` 脚本（桌面补丁的应用 / 还原入口）就是这样漏掉的。
 *
 * 扫描器最危险的失败模式正是「漏扫且不报错」：报告显示「0 条阻断项」，
 * 看起来一切干净。关掉 quotepath 之后路径按原样返回，不会再漏。
 *
 * @param args - git 子命令与参数。
 * @returns 标准输出文本。
 */
function gitText(args) {
	return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
		cwd: ROOT,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	})
}

/** 暂存区扫描：只查即将提交的内容。 */
function scanStaged(rules) {
	const names = gitText(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
	const hits = []
	for (const rel of names) {
		if (SKIP_PATHS.some((skip) => rel === skip.replace(/\\/gu, '/'))) continue
		let text
		try {
			text = gitText(['show', `:${rel}`])
		} catch (error) {
			// 不再静默：读不到内容必须留下痕迹，否则就是「漏扫且看起来干净」。
			hits.push({
				rule: 'unreadable',
				severity: 'warn',
				describe: '暂存内容读不出来（这一条没被真正扫到）',
				label: rel,
				line: 1,
				snippet: String(error?.message ?? error).slice(0, 80)
			})
			continue
		}
		hits.push(...scanText(rel, text, rules))
	}
	return hits
}

/**
 * 提交历史扫描：逐提交逐文件查**当时的内容**。
 *
 * 这是最容易被跳过、也最要命的一步：工作区干净不代表历史干净 ——
 * 一次「先提交、后删掉」就能把凭据永久留在仓库里。
 *
 * @param rules - 编译后的规则。
 * @returns 命中数组。
 */
function scanHistory(rules) {
	let log
	try {
		log = gitText(['log', '--all', '--pretty=format:%H%x09%ad%x09%s', '--date=short'])
	} catch {
		console.log('（还不是 git 仓库，跳过历史扫描）')
		return []
	}
	const commits = log.split('\n').filter((line) => line.trim() !== '')
	if (commits.length === 0) {
		console.log('（还没有任何提交，跳过历史扫描）')
		return []
	}
	const hits = []
	for (const row of commits) {
		const [sha, date, subject] = row.split('\t')
		let files
		try {
			files = gitText(['show', '--pretty=format:', '--name-only', sha])
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line !== '')
		} catch {
			continue
		}
		for (const rel of files) {
			if (SKIP_PATHS.some((skip) => rel === skip.replace(/\\/gu, '/'))) continue
			let text
			try {
				text = gitText(['show', `${sha}:${rel}`])
			} catch {
				// 二进制 / 子模块等读不出来的条目：跳过即可，它们的体积也不适合扫。
				continue
			}
			const label = `${rel}@${sha.slice(0, 8)} (${date} ${subject})`
			hits.push(...scanText(label, text, rules))
		}
	}
	return hits
}

const mode = process.argv.includes('--history') ? 'history' : (process.argv.includes('--staged') ? 'staged' : 'workspace')
const rules = compileRules()
console.log(`扫描模式：${mode}`)
// 把**实际扫描根**打出来：跨插件复用脚本时，这是唯一能立刻看出「扫错目录」的地方。
console.log(`扫描根：${ROOT}`)
console.log(`规则 ${rules.length} 条：${rules.map((rule) => rule.id).join(', ')}\n`)

const hits = mode === 'history' ? scanHistory(rules) : (mode === 'staged' ? scanStaged(rules) : scanWorkspace(rules))
const blockers = hits.filter((hit) => hit.severity === 'blocker')
const warns = hits.filter((hit) => hit.severity === 'warn')

for (const [title, list] of [['阻断项（不得上传）', blockers], ['待确认项', warns]]) {
	console.log(`=== ${title}：${list.length} 条 ===`)
	for (const hit of list) {
		console.log(`  [${hit.rule}] ${hit.label}:${hit.line} — ${hit.describe}`)
		console.log(`        命中片段：${hit.snippet}`)
	}
	if (list.length === 0) console.log('  （无）')
	console.log('')
}

console.log(blockers.length === 0
	? `结论：未发现阻断项（待确认项 ${warns.length} 条）`
	: `结论：发现 ${blockers.length} 条阻断项，**不得上传**`)
process.exit(blockers.length === 0 ? 0 : 1)
