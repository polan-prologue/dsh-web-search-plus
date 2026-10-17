# dsh-web-search-plus

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-web-search-plus)](https://www.npmjs.com/package/dsh-web-search-plus)
[![stars](https://img.shields.io/github/stars/polan-prologue/dsh-web-search-plus?style=flat)](https://github.com/polan-prologue/dsh-web-search-plus)

Provider **priority** for DeepSeek Harness web search: put Tavily and the native DeepSeek
provider in whatever order you want, fall through to the next one when the first fails, and
rotate several Tavily keys to spread the free daily quota.

## Install

```sh
dsh plugin --profile desktop add dsh-web-search-plus
```

Refresh the browser once, then open **Plugins → 网页搜索++** and press **Take over**.

Pinned tag instead of the npm release:

```sh
dsh plugin --profile desktop add github:polan-prologue/dsh-web-search-plus#v0.1.2
```

**Requires dsh 0.1.0 or newer.** The plugin talks to the `ctx.web` seam and the `webServer`
prefix routes; on an older host it registers nothing and says why in the log.

## Why this exists

The `ctx.web` seam selects **exactly one** provider by id:

| State | What the seam does |
|---|---|
| A provider id is configured | Uses only that one; failure is failure |
| No id, exactly one provider usable | Uses it |
| No id, several usable | Throws `WEB_PROVIDER_AMBIGUOUS` |

There is no priority chain and no fallback. This plugin registers **one** provider
(`web-search-plus`) and runs the chain inside it:

```
web_search tool
   └─ ctx.web (pinned to web-search-plus)
        ├─ 1. Tavily            → rotates across your key slots
        └─ 2. DeepSeek native   → reuses the official provider instance
```

The DeepSeek node calls the **official provider instance** rather than re-implementing it, so
its key, account token, endpoint and usage limits keep coming from **Settings → Web search** —
nothing drifts when upstream changes.

## What you get

- **Ordered fallback** — move the two providers up and down; the first one that answers wins, the next runs when the previous fails or (optionally) returns nothing
- **Multi-key rotation** — up to 20 Tavily key slots. A rate-limited (`429`) or quota-exhausted key cools down and the chain moves to the next one automatically; each slot shows its live state (`ready` / `invalid` / `cooling down`) and the one in use is marked
- **Per-key usage** — ask Tavily for each slot's current plan usage in one click, so you can see which key is nearly spent before a search fails
- **Hand back cleanly** — *Hand back to official search* writes `deepseek-official` back to the `web` row and the chain stops being consulted. The *Try one search* probe follows the same state, so it never claims the chain ran while the seam points somewhere else
- **Secrets stay in the credential domain** — keys are written through `ctx.credentials`, never to the settings file, never into a snapshot response, never into a log. Saved keys can be revealed on request with the eye button, which asks the host for exactly one slot over a loopback-only, no-store route
- **No surprises on the page** — an action locks only its own control group; the 1 s cooldown ticker does not repaint the cards; the note line keeps its height so cards do not shift when a message appears
- **Bilingual UI** — follows the interface language (`zh` / `en`)

## Manage it from the Plugins page

The settings card lives in **Plugins → 网页搜索++**, and falls back to the kernel
**Built-in plugins** page when the experience platform is absent. Four cards:

| Card | What it does |
|---|---|
| Priority | Reorder the chain; one switch decides whether the chain is consulted at all |
| Tavily keys | Key slots, per-slot state, reveal / save / clear / remove, add slot, reset cooldowns |
| Tavily options | Endpoint, search depth, result cap, timeout, rate-limit cooldown, answer summary |
| Status | Takeover state, chain availability, run one probe, fetch per-key usage |

## How the chain actually behaves

| Situation | Result |
|---|---|
| First node answers | Its result is returned; later nodes are not called |
| First node throws | Reason is recorded, next node runs |
| Node is not registered | Recorded as *not registered*, next node runs |
| Caller cancels | Propagates immediately — cancellation does **not** fall through |
| Every node fails | `WEB_SEARCH_CHAIN_EXHAUSTED`, one line per node with its reason |

With `fallbackOnEmpty` on, an **empty** result counts as a failure and the chain continues; off,
an empty result is a legitimate answer.

## Security

- Management routes accept **loopback only**, and additionally require a loopback `Host`, a same-origin `Origin` when present, a non-`cross-site` `Sec-Fetch-Site`, and `application/json` on writes — so a page in your browser cannot read your keys even though these routes sit outside the host's session auth
- Key values are write-only in every listing: `GET` never contains a secret
- The reveal route returns **one** slot per request, carries `no-store`, refuses refs that are not configured, and is never called automatically
- The publish step runs `tools/scan-sensitive.mjs`, which blocks API-key shapes, private keys, connection strings, personal paths and session ids

## Configuration

Every option lives in the plugin row of your profile's `cordis.patch.yml` and is editable from
the page:

| Key | Default | Meaning |
|---|---|---|
| `priority` | `[tavily, deepseek-official]` | Chain order |
| `tavilyKeyRefs` | `[TAVILY_API_KEY]` | Credential refs, in rotation order |
| `tavilyBaseURL` | `https://api.tavily.com` | Endpoint (`/search` and `/usage` are appended) |
| `tavilyMaxResults` | `8` | Results per search (1–20) |
| `tavilySearchDepth` | `basic` | `basic` / `fast` / `ultra-fast` / `advanced` |
| `tavilyIncludeAnswer` | `true` | Ask Tavily for an LLM answer summary |
| `tavilyTimeoutMs` | `30000` | Per-request timeout |
| `tavilyRateLimitCooldownMs` | `60000` | Cooldown after a `429` |
| `fallbackOnEmpty` | `false` | Treat an empty result as a failure |

## Development

```sh
npm test          # 238 unit tests, no network, no keys
npm run test:live # real search against a real key
```

Layout: `lib/index.js` (host entry) · `lib/chain.js` (the chain) · `lib/tavily.js` (Tavily node
+ key ring) · `lib/routes.js` (management routes) · `lib/client.js` (browser half) ·
`lib/schema.js` (config) · `docs/开发踩坑记录.md` (pitfall log).

## Known limits

- Tavily's free tier is metered **per account**, so several keys only help when they come from different accounts
- `advanced` depth costs twice the credits
- The seam still selects one provider id; this plugin *is* that one provider — the ordering is its internal logic, not a seam feature
- Changing the `web` row's provider needs a host restart on some builds; the page says so instead of pretending

## License

[MIT](LICENSE)
