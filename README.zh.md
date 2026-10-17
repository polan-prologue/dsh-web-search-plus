# dsh-web-search-plus

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-web-search-plus)](https://www.npmjs.com/package/dsh-web-search-plus)
[![stars](https://img.shields.io/github/stars/polan-prologue/dsh-web-search-plus?style=flat)](https://github.com/polan-prologue/dsh-web-search-plus)

给 DeepSeek Harness 的联网搜索加**提供方优先级**：Tavily 与 DeepSeek 原生搜索随便排序，
前一个失败自动回退到下一个；Tavily 侧还能配置多个密钥轮换，分摊免费版的每日额度。

## 安装

```sh
dsh plugin --profile desktop add dsh-web-search-plus
```

刷新一次浏览器，打开 **插件 → 网页搜索++**，点**立即接管**。

想锁版本而不用 npm 发布版：

```sh
dsh plugin --profile desktop add github:polan-prologue/dsh-web-search-plus#v0.1.2
```

**需要 dsh 0.1.0 或更新版本。** 本插件要接 `ctx.web` seam 与 `webServer` 前缀路由；
宿主太旧时它什么都不注册，并在日志里说明原因。

## 为什么需要它

`ctx.web` seam 只会按 id 选中**一个**提供方：

| 状态 | seam 的行为 |
|---|---|
| 配置了提供方 id | 只用它，失败就是失败 |
| 没配 id，恰好一个可用 | 用它 |
| 没配 id，多个可用 | 抛 `WEB_PROVIDER_AMBIGUOUS` |

它本身既没有优先级链也没有回退。本插件向 seam 注册**一个**提供方
（`web-search-plus`），由它在内部跑链：

```
web_search 工具
   └─ ctx.web（固定指向 web-search-plus）
        ├─ 1. Tavily            → 在你的密钥槽之间轮换
        └─ 2. DeepSeek 原生     → 复用官方提供方实例
```

DeepSeek 节点调用的是**官方提供方实例**，而不是重写一份：它的密钥、账号令牌、接口地址
与用量上限继续来自**设置 → 网页搜索**，上游改动时不会漂移。

## 你会得到

- **有序回退**——两个提供方上下拖动排序；谁先答上就用谁，前一个失败（或可选地返回空）时下一个接着跑
- **多密钥轮换**——最多 20 个 Tavily 密钥槽。命中限流（`429`）或额度耗尽的槽会冷却，链自动换下一个；每个槽显示实时状态（`可用` / `已失效` / `冷却中`），正在用的那个有标记
- **逐密钥查额度**——一键向 Tavily 查询每个槽的当期用量，搜索失败之前就能看出哪把快用完了
- **交还干净**——*交还官方搜索* 把 `deepseek-official` 写回 `web` 行，链随即不再被调用。*试一次搜索* 跟随同一状态，不会在 seam 已指向别处时声称「链跑过了」
- **密钥只留在凭据域**——密钥经 `ctx.credentials` 写入，从不进设置文件、从不进快照响应、从不进日志。已保存的密钥点小眼睛即可按需查看：只在本机回环、带 `no-store` 的路由上向宿主要**一个**槽位
- **页面不会乱跳**——一个动作只锁自己那组控件；每秒的冷却计时不会重绘卡片；提示行保持固定高度，出现消息时卡片不位移
- **中英双语**——跟随界面语言（`zh` / `en`）

## 在插件页里管理

设置卡在 **插件 → 网页搜索++**；没有体验优化平台时回退到内核的**内置插件**页。四张卡：

| 卡片 | 做什么 |
|---|---|
| 使用优先级 | 调整链顺序；一个开关决定链是否生效 |
| Tavily 密钥 | 密钥槽、逐槽状态、查看 / 保存 / 清除 / 移除、添加槽位、重置冷却 |
| Tavily 选项 | 接口地址、搜索深度、结果上限、超时、限流冷却、摘要答案 |
| 运行状态 | 接管状态、链可用性、跑一次探测、查各密钥额度 |

## 链的实际行为

| 情况 | 结果 |
|---|---|
| 第一个节点答上 | 直接返回它的结果，后面的节点不调用 |
| 第一个节点抛错 | 记下原因，跑下一个 |
| 节点未注册 | 记为「未注册」，跑下一个 |
| 调用方取消 | 立刻穿透——取消**不会**触发回退 |
| 全部节点失败 | `WEB_SEARCH_CHAIN_EXHAUSTED`，每个节点一行原因 |

打开 `fallbackOnEmpty` 时，**空结果**算失败、链继续；关闭时，空结果是合法答案。

## 安全

- 管理路由只接受**本机回环**，并额外要求 `Host` 是回环地址、有 `Origin` 时必须同源、`Sec-Fetch-Site` 不得是 `cross-site`、写操作必须是 `application/json`——所以即使这些路由位于宿主会话鉴权之外，你浏览器里的页面也读不到你的密钥
- 所有列表接口里密钥值都是**只写**的：`GET` 永远不含密钥
- 查看路由每次只回**一个**槽位，带 `no-store`，拒绝不在配置里的引用名，且从不被自动调用
- 发布步骤会跑 `tools/scan-sensitive.mjs`，拦截 API key 形态、私钥、连接串、个人路径与会话 id

## 配置项

全部选项都在 profile 的 `cordis.patch.yml` 里本插件那一行，页面上也能改：

| 键 | 默认值 | 含义 |
|---|---|---|
| `priority` | `[tavily, deepseek-official]` | 链顺序 |
| `tavilyKeyRefs` | `[TAVILY_API_KEY]` | 凭据引用名，按轮换顺序 |
| `tavilyBaseURL` | `https://api.tavily.com` | 接口地址（后面拼 `/search` 与 `/usage`） |
| `tavilyMaxResults` | `8` | 单次结果上限（1–20） |
| `tavilySearchDepth` | `basic` | `basic` / `fast` / `ultra-fast` / `advanced` |
| `tavilyIncludeAnswer` | `true` | 向 Tavily 请求 LLM 摘要答案 |
| `tavilyTimeoutMs` | `30000` | 单次请求超时 |
| `tavilyRateLimitCooldownMs` | `60000` | 命中 `429` 后的冷却时长 |
| `fallbackOnEmpty` | `false` | 把空结果当作失败 |

## 开发

```sh
npm test          # 238 项单元测试，不联网、不需要密钥
npm run test:live # 用真实密钥跑一次真实搜索
```

结构：`lib/index.js`（宿主入口）· `lib/chain.js`（链）· `lib/tavily.js`（Tavily 节点 + 密钥环）
· `lib/routes.js`（管理路由）· `lib/client.js`（浏览器半侧）· `lib/schema.js`（配置）
· `docs/开发踩坑记录.md`（踩坑日志）。

## 已知限制

- Tavily 免费额度按**账号**计量，所以多个密钥只有在来自不同账号时才有意义
- `advanced` 深度的额度消耗是两倍
- seam 仍然只选一个提供方 id；本插件**就是**那一个提供方——排序是它的内部逻辑，不是 seam 的能力
- 在某些构建上，改写 `web` 行的提供方需要重启宿主；页面会如实说明，而不是假装已生效

## 许可证

[MIT](LICENSE)
