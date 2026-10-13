# 网页搜索++（dsh-web-search-plus）

为 DSH 的联网搜索提供**提供方优先级**：在 **Tavily 第三方搜索** 与 **DeepSeek 原生搜索** 之间自由排序，前一个失败时自动回退到下一个；Tavily 侧可配置**多个密钥**自动轮换，用来分摊免费版的每日额度上限。

**项目地址**：<https://github.com/polan-prologue/dsh-web-search-plus> · **许可证**：[MIT](LICENSE)

---

## 快速开始

```powershell
# 从 GitHub 安装（推荐：锁定 tag，升级由你决定）
dsh plugin --profile desktop add github:polan-prologue/dsh-web-search-plus#v0.1.0

# 从本地目录安装（二次开发时用这个）
dsh plugin --profile desktop add <插件目录>
```

装完**刷新一次浏览器页面**，客户端半侧才会出现；然后按下面「使用」一节点「立即接管」。

> 本插件需要 **Tavily 密钥**才能走 Tavily 那条搜索线。密钥只写入你自己的 DSH 凭据域，
> **不进本仓库、不进日志**；没有密钥时它会如实报「未配置」，并按优先级回退到 DeepSeek 原生搜索。

---

## 为什么需要这个插件

DSH 的联网搜索统一走 `ctx.web` seam，而 seam 只支持「按 id 固定**一个**提供方」：

| 情况 | seam 的行为 |
|---|---|
| 配置了提供方 id | 只用它，失败即失败 |
| 未配置 id，恰好一个可用 | 用它 |
| 未配置 id，多个可用 | 直接报 `WEB_PROVIDER_AMBIGUOUS` |

也就是说，seam 本身**没有优先级链**。本插件向 seam 注册**一个**提供方 `web-search-plus`，由它在内部按你配置的顺序依次尝试真正的后端：

```
web_search 工具
   └─ ctx.web（固定指向 web-search-plus）
        └─ 网页搜索++ 优先级链
             1. Tavily 搜索（多密钥轮换：K1 → K2 → …）
             2. DeepSeek 原生搜索（deepseek-official）
```

DeepSeek 节点**复用官方提供方实例**，所以它的密钥、账号令牌、接口地址与搜索次数上限继续沿用官方「设置 → 插件 → 网页搜索」页的配置，本插件不重复实现一份会与上游漂移的调用逻辑。

## 安装

它需要作为**组合包**装入 profile。先确定你自己的插件目录（克隆或解压出来的、里面有
`package.json` 的那一层），下文用 `<插件目录>` 代指：

```powershell
# 把 <插件目录> 换成你自己的绝对路径，例如 %USERPROFILE%\plugins\dsh-web-search-plus
dsh plugin --profile desktop add <插件目录>
```

也可以从 GUI 的「插件」页安装，spec 填你自己的插件目录绝对路径。安装后 shell 会加载它；**首次需要刷新一次浏览器页面**，客户端半侧才会出现。

## 使用

打开 **侧栏 → 插件 → 官方分组 → 「网页搜索++」**（就在官方「网页搜索」卡片旁边）。

1. **使用优先级**：用「上移 / 下移」调整顺序。默认是 `Tavily → DeepSeek`。
2. **接管**：点「立即接管」。这一步把 profile 里 `web` 行的 `searchProvider` 指向 `web-search-plus`——**没有这一步，优先级不会生效**，页面会以红色提示如实告诉你当前没接管。
3. **Tavily 密钥**：
   - 「添加密钥槽位」增加一个槽位（凭据名依次为 `TAVILY_API_KEY`、`TAVILY_API_KEY_2`……，也可以自定义成任意合法的环境变量名）；
   - 在每个槽位填入密钥后点「保存密钥」；
   - 密钥只写入凭据域（`$DSH_HOME/.credentials.yaml`），**不写入设置文件，也绝不出现在任何响应里**；
   - 「检测各密钥额度」会逐个查询 Tavily `/usage`，显示每个密钥的已用量与上限。
4. **试一次搜索**：真跑一次搜索，并展示本次实际经过了哪些节点、命中哪一个——用来确认优先级确实按你的设置在工作。
5. **重置冷却**：手动清除所有密钥的冷却与失效标记。

## 优先级与回退的实际行为

| 场景 | 结果 |
|---|---|
| Tavily 成功 | 直接返回，不触碰 DeepSeek |
| Tavily 首选密钥限流 / 额度耗尽 | 自动改用下一个可用密钥 |
| Tavily 某个密钥无效（401） | 该密钥本次运行内标记失效，改用下一个 |
| Tavily 全部密钥失败 | 回退到链上下一个节点（如 DeepSeek 原生） |
| 链上每个节点都失败 | 抛 `WEB_SEARCH_CHAIN_EXHAUSTED`，消息逐条列出每个节点的失败原因 |
| 你在设置页取消了当前搜索 | 立即中止，**不**回退（回退只针对提供方自身的失败） |
| 首选节点返回 0 结果 | 默认视为有效答案；打开 `fallbackOnEmpty` 后改为继续下一个节点 |

### 密钥状态的错误分类

分类依据实测的 Tavily 行为，而不是 HTTP 语义的教科书含义：

| 状态码 | 含义 | 动作 |
|---|---|---|
| 401 / 403 | 该密钥无效 | 标记失效，换下一个 |
| 429 | 该密钥限流 | 按冷却时长（默认 60 秒，或响应里的 `Retry-After`）冷却 |
| 432 / 433 | 该密钥额度/套餐上限用尽 | 冷却（默认到次日零点） |
| 400 | 该密钥不接受此次请求（如查询过短） | 换下一个密钥 |
| 422 | 请求体不符合接口 schema | 不轮换，直接上抛——换密钥不会让非法请求变合法 |
| 5xx / 网络错误 | 上游临时故障 | 换下一个密钥 |

> 实测数据：无效密钥 + 正常查询 → `401`；有效密钥 + 单字符查询 → `400`。因此 400 归入「可轮换」。

## 配置项

全部字段都是 volatile 字段，可以直接在插件页改，也可以写进 profile 的 `cordis.patch.yml`：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `priority` | `[tavily, deepseek-official]` | 提供方尝试顺序 |
| `tavilyKeyRefs` | `[TAVILY_API_KEY]` | 密钥槽位的凭据引用名（最多 20 个） |
| `tavilyBaseURL` | `https://api.tavily.com` | Tavily 接口地址 |
| `tavilyMaxResults` | `8` | 单次结果上限（1–20） |
| `tavilySearchDepth` | `basic` | `basic` / `fast` / `ultra-fast` / `advanced`（advanced 消耗 2 倍额度） |
| `tavilyIncludeAnswer` | `true` | 是否请求摘要答案（映射为结果的 `content`） |
| `tavilyTimeoutMs` | `30000` | 单次请求超时 |
| `tavilyRateLimitCooldownMs` | `60000` | 429 后的冷却时长；`0` 表示不自动恢复 |
| `tavilyQuotaCooldownMs` | `0` | 432/433 后的冷却时长；`0`（默认）表示额度耗尽后保持冷却，仅手动重置可恢复 |
| `fallbackOnEmpty` | `false` | 0 结果时是否继续下一个节点 |

## 交还与恢复

- 插件页的「**交还官方搜索**」会把 `web` 行的 `searchProvider` 改写为**显式** `deepseek-official`，即回到官方搜索。
  > 为什么不是"删掉覆盖"：seam 只有在「显式指定了提供方」或「注册表里恰好只有一个可用提供方」时才不歧义。本插件始终把自己注册进注册表，一旦删掉字段就会变成「两个可用提供方 + 无显式选择」，宿主抛 `WEB_PROVIDER_AMBIGUOUS`，**联网搜索彻底不可用**——而且接口仍返回 `ok=true`，只有真正搜索时才暴露。写回显式 id 才能同时满足"用官方搜索"和"不歧义"。
- 快照里的 `takeover.ambiguous` 会标出这种歧义状态，界面上也会明确提示「搜索当前不可用」，不会假装成"自动选择"。
- 也可以手工编辑 profile 的 `cordis.patch.yml`，把 `id: web` 那个覆盖块的 `searchProvider` 改成 `deepseek-official`。
  该文件在 `%DSH_HOME%\profiles\<profile 名>\cordis.patch.yml`；`%DSH_HOME%` 默认是 `%USERPROFILE%\.dsh`
  （PowerShell 里等价写法：`Join-Path $env:USERPROFILE '.dsh\profiles\desktop\cordis.patch.yml'`，
  设过 `$env:DSH_HOME` 时以它为准）。不想找文件就直接在上面的插件页点「交还官方搜索」。
- 卸载插件：`dsh plugin --profile desktop remove dsh-web-search-plus`。

> 注意：profile patch 是**按 id 整体替换**、不做深度合并。所以接管时必须重述 `fetchProvider: http`，插件已经这么做了；手工编辑时也请保留它。

## 开发

> 完整的故障档案见 **[docs/开发踩坑记录.md](docs/开发踩坑记录.md)** —— 按「环境搭建 / 骨架接线 / schema / 宿主契约 / 开发调试 / 测试关卡 / 打包发布 / 端到端验收」组织，每条给出**现象 / 原因 / 解决 / 证据**。接手前建议先读第十节「一页速查」。

```powershell
# 单元测试（纯逻辑，不需要网络与密钥）
node --test "tests/*.test.mjs"

# 真实联网验收（需要真实密钥）
$env:DSH_WSP_TEST_KEY='tvly-xxx'; node tests/live-check.mjs
```

| 模块 | 职责 |
|---|---|
| `lib/errors.js` | 稳定错误码；`WebError` 的动态导入与本地回退 |
| `lib/config.js` | 配置词汇与归一化（纯函数） |
| `lib/schema.js` | schemastery Config 与 volatile 字段读取 |
| `lib/tavily.js` | `KeyRing`（多密钥的粘滞选择、失效与冷却状态机）、Tavily 调用、响应映射、错误分类 |
| `lib/chain.js` | 优先级链式提供方（注册进 `ctx.web` 的那一个） |
| `lib/routes.js` | `/api/dsh-web-search-plus` 管理路由族 |
| `lib/index.js` | 宿主入口：装配 provider、路由与设置页策略 |
| `lib/client.js` | 浏览器半侧：插件页卡片与设置页面 |

## 已知限制

- **`web_fetch` 不走本插件**：链式提供方只接管搜索；抓取仍是 `http` 提供方。
- **依赖官方提供方实例**：DeepSeek 节点从 `ctx.web` 的注册表按 id `deepseek-official` 取实例。若官方行被禁用，该节点会被标记为「未注册」并跳过（页面会如实显示），而不是静默出错。
- **管理接口只接受本机请求**：非回环地址一律 403。
- **Tavily 免费版可能不上报 `plan_limit`**：此时「检测额度」显示「未报告上限」，轮换策略不依赖该值，只依赖实际错误码。
