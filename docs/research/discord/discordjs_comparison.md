# Discord Library Comparison for agents-comm-bus

## Executive Summary

| Dimension | discord.js | Oceanic | Detritus | Eris |
|-----------|------------|---------|----------|------|
| **Stars** | 26,727 | 314 | 209 | 1,510 |
| **Weekly npm downloads** | 692,961 | 1,783 | 1,069 | 2,511 |
| **Open issues** | 154 | 0 | 16 | 46 |
| **Last release** | 2026-05-01 (14.26.4) | 2026-03-06 (1.14.0) | 2021-08-25 (0.16.2) | 2024-09-22 (0.18.0) |
| **Last commit** | 2026-05-26 | 2026-06-03 | 2026-06-01 | 2025-09-28 |
| **License** | Apache-2.0 | MIT | BSD-2-Clause | MIT |
| **TypeScript defs** | Native TS (src in JS, typings) | Native TS (compiled to dist) | Full TS source | DT community types |
| **Node engine** | >=22.12.0 | >=18.13.0 | unspecified | >=10.4.0 |
| **Monorepo** | Yes (21 packages) | No | Hierarchical (rest+socket) | No |
| **Overall verdict** | **Recommended** | Viable alternative | Avoid (stalled) | Viable, lower-level |

---

## 1. discord.js — Deep Dive

### Maturity & Maintenance
- **Age**: Created 2015-08-10 (10+ years), the oldest and most established Discord library.
- **Contributor base**: 400+ contributors, active OpenCollective funding, CI/CD with codecov.
- **Release cadence**: Very active — 14.26.4 shipped 2026-05-01, with multiple patch releases per month.
- **Discord server**: Official support community with badge-linked invite (discord.gg/djs).
- **Operational confidence**: High. The project has survived every Discord API breaking change and rewrite (v11 -> v12 -> v13 -> v14).

### TypeScript & API Ergonomics
- **Type coverage**: Full. Even though main source is still JavaScript, `typings/index.d.ts` is actively maintained and ships with the package.
- **Developer experience**: Rich, object-oriented API with builder pattern (`EmbedBuilder`, `ActionRowBuilder`, `ModalBuilder`).
- **Intents & permissions**: First-class support for Gateway Intents, permission bitfields, and granular REST options.
- **Monorepo model**: Decomposed into targeted packages (`@discordjs/rest`, `@discordjs/ws`, `@discordjs/builders`, `@discordjs/voice`, `@discordjs/collection`, etc.).这使得只引入需要的子系统成为可能，但主包已包含全部功能。
- **ESM/CJS dual**: Supports both ESM and CommonJS via conditional exports.

### Gateway & REST Coverage
- **Gateway**: Full coverage via `@discordjs/ws`. Supports sharding, clustering, and custom shard strategies.
- **REST**: Separate `@discordjs/rest` package with rate-limit bucket handling, retries, and global rate-limit awareness.
- **Voice**: `@discordjs/voice` provides full voice channel support (opus, encryption, WebRTC-like signaling).
- **Caching**: Built-in strong caching of guilds, channels, users, members, messages. Customizable cache strategy.
- **Webhook**: Full support for incoming/outgoing webhooks.

### Event Model
- `Client` extends `EventEmitter` (via `@vladfrangu/async_event_emitter`).
- Events mirror Discord Gateway dispatch names (`messageCreate`, `interactionCreate`, `guildMemberAdd`, etc.).
- Strongly typed event arguments via TypeScript declaration merging.

### Ecosystem
- Largest third-party ecosystem: command frameworks (CommandKit, Sapphire, etc.), dashboard integrations, pagination libraries, music bots.
- Most StackOverflow / Reddit answers reference discord.js.
- Extensive official guide and documentation website.

### Known Issues / Caveats
- **Heavy abstraction**: The caching layer and rich object model add memory overhead. For a lightweight bus adapter, importing only `@discordjs/rest` + `@discordjs/ws` may be preferable.
- **Breaking changes**: Major versions (v13 -> v14) have historically introduced significant API surface changes.
- **Node version requirement**: Main package now requires Node >=22.12.0, which may be aggressive for some deployment targets.
- **Bundle size**: The full package includes voice and many builders; tree-shaking is possible but ESM-first builds are recommended.

---

## 2. Oceanic

### Maturity & Maintenance
- **Age**: Created 2022-08-07 (~3.5 years old).
- **Stars/forks**: 314 stars, 32 forks — small but healthy.
- **Release cadence**: Active. v1.14.0 on 2026-03-06, with consistent semver-major bumps.
- **Last commit**: 2026-06-03 — current and actively maintained.
- **Open issues**: 0 — either very well managed or low usage.

### TypeScript & API Ergonomics
- **Type coverage**: Full. Written in TypeScript, compiles to `dist/`. `.d.ts` ships with the package.
- **Developer experience**: Clean, minimal API. README shows a concise `new Client({ token })` -> `client.connect()` pattern.
- **Dependencies**: Only `tslib` and `ws` — extremely lightweight.

### Gateway & REST Coverage
- **Gateway**: WebSocket-based gateway with full event support.
- **REST**: Built-in REST client.
- **Caching**: Configurable caching. Less aggressive defaults than discord.js.
- **Voice**: Not mentioned as a highlight; may require manual integration.

### Event Model
- EventEmitter-based (`client.on("ready", ...)`).
- README warns that unhandled `error` events throw `UncaughtError`, which is a sharp edge for robust adapters.

### Ecosystem
- Smaller than discord.js by an order of magnitude.
- Good for projects that want a lighter abstraction without sacrificing TypeScript.

### Known Issues / Caveats
- **Small community**: Far fewer StackOverflow answers and example bots.
- **Error event hazard**: Missing an `error` listener can crash the process — adapter code must attach one defensively.
- **Fewer voice/builder utilities**: If the adapter ever needs voice or rich UI builders, extra work is required.

---

## 3. Detritus

### Maturity & Maintenance
- **Age**: Created 2018-02-03 (~8 years).
- **Stars/forks**: 209 stars, 22 forks.
- **Release cadence**: **Effectively stalled**. Last npm release was 0.16.2 on 2021-08-25 (nearly 5 years ago).
- **Last commit**: 2026-06-01 on GitHub — suggests activity on `master` but no published release.
- **Open issues**: 16.

### TypeScript & API Ergonomics
- **Type coverage**: Full TypeScript source. Uses `detritus-client-rest` and `detritus-client-socket` sub-packages.
- **Developer experience**: Two client classes — `ShardClient` and `ClusterClient`. Explicit separation of concerns.

### Gateway & REST Coverage
- Separated REST and Gateway packages allow fine-grained control.
- Covers both low-level Gateway events and higher-level REST abstractions.

### Event Model
- Event-driven; mirrors Discord Gateway events.

### Ecosystem
- Very small community. Limited examples outside the official docs.

### Known Issues / Caveats
- **Stalled releases**: The npm package is years behind the GitHub source. Relying on published releases is risky; vendoring from Git is required for current fixes.
- **Low adoption**: ~1,069 weekly downloads, indicating minimal production usage compared to discord.js.
- **BSD-2-Clause**: License is permissive, but less common than MIT/Apache in the Node ecosystem.

**Verdict**: Not recommended for a new project. The stalled release cycle is a red flag for operational stability.

---

## 4. Eris

### Maturity & Maintenance
- **Age**: Created 2016-06-30 (~9 years).
- **Stars/forks**: 1,510 stars, 406 forks. Respectable, though far below discord.js.
- **Release cadence**: Slowed. Last release 0.18.0 on 2024-09-22; prior releases were multi-year gaps.
- **Last commit**: 2025-09-28 — still receiving commits, but release cadence is sparse.
- **Open issues**: 46.

### TypeScript & API Ergonomics
- **Type coverage**: Community types via `@types/eris`. No native `types` field in package.json.
- **Developer experience**: Lower-level than discord.js. `new Eris("Bot TOKEN", { intents: [...] })` — manual intent specification is visible in the README.
- **Dependencies**: Only `ws`. Extremely minimal.

### Gateway & REST Coverage
- Full Gateway and REST coverage.
- No built-in aggressive caching — leaves caching strategy to the user.
- Voice support available as optional native dependency (requires Python 2.7 + C++ compiler for voice builds).
- `no-optional` install path is documented for lighter deployments.

### Event Model
- Standard EventEmitter (`bot.on("messageCreate", ...)`).
- Lower abstraction: raw Gateway payloads are closer to the surface.

### Ecosystem
- Moderate. Popular among developers who prefer lower-level control.
- Many older Discord bots were built with Eris before discord.js v13 stabilized.

### Known Issues / Caveats
- **Minimal abstraction**: Adapter code would need to build its own caching, builders, and utility layers.
- **Sparse releases**: 9 months between 0.17.2 and 0.18.0; even longer gaps historically.
- **Voice build complexity**: Optional native dependencies for voice can complicate containerized deployments.
- **Community types**: `@types/eris` may lag behind the library.

---

## Adapter Implementation Fit for agents-comm-bus

For a transport adapter in `agents-comm-bus`, the Discord adapter needs to:

1. **Authenticate** with a bot token.
2. **Poll/receive** inbound messages (Gateway `messageCreate`, `interactionCreate`, DMs).
3. **Send** outbound messages (REST `POST /channels/{id}/messages`).
4. **Handle** permission/query U-turns (inline buttons via message components).
5. **Reconnect** gracefully on Gateway disconnects.
6. **Run reliably** under a long-lived daemon process.

### Fit Analysis

| Need | discord.js | Oceanic | Detritus | Eris |
|------|------------|---------|----------|------|
| Token auth | Native `bot` token in `Client` options | Native `token` in `Client` | Native | Native `Bot TOKEN` prefix |
| Inbound polling | Gateway events via `on("messageCreate")` | Gateway events | Gateway events | Gateway events |
| Outbound send | `channel.send()`, `interaction.reply()` | `client.rest.channels.createMessage()` | REST subpackage | `bot.createMessage()` |
| Inline buttons | `ActionRowBuilder` + `ButtonBuilder` | Component support | Component support | Raw component objects |
| Graceful reconnect | Built-in Gateway reconnection | Built-in | Built-in | Built-in |
| Daemon lifetime | Robust, production-proven | Good | Unsure (stalled) | Good |
| TypeScript safety | Excellent | Excellent | Excellent | Fair (community types) |
| Memory overhead | Higher (caching) | Lower | Lower | Lowest |

### Specific Notes for agents-comm-bus

- **discord.js** is the strongest match because:
  - Its component builders (`ActionRowBuilder`, `ButtonBuilder`) map cleanly to the Telegram-style inline-keyboard UX already implemented in the bus.
  - `@discordjs/rest` can be used independently if the daemon wants to avoid Gateway state entirely (webhook-only mode), or `@discordjs/ws` + `@discordjs/core` for a lighter gateway path.
  - The monorepo design means the adapter can import only `rest` + `ws` + `builders`, keeping bundle size reasonable.
  - Documentation is the best of any Discord library — essential for future maintainers.

- **Oceanic** is a viable runner-up if the project wants to minimize dependencies (only 2 runtime deps vs discord.js's 13+). However, the `error` event hazard and smaller community increase operational risk.

- **Eris** suits a team that prefers low-level, cache-free control. But the lack of native types and long release gaps make it less attractive for a TypeScript-first project.

- **Detritus** should be ruled out due to its stalled release history.

---

## Recommendation

**Primary choice: discord.js** (specifically the `@discordjs/rest` + `@discordjs/ws` + `@discordjs/builders` subpackages if weight is a concern).

**Secondary choice: Oceanic** if dependency count and bundle size are hard constraints.

**Avoid: Detritus** due to release stagnation.

---

## References

- discord.js repo: https://github.com/discordjs/discord.js
- discord.js docs: https://discord.js.org
- Oceanic repo: https://github.com/OceanicJS/Oceanic
- Detritus repo: https://github.com/detritusjs/client
- Eris repo: https://github.com/abalabahaha/eris
- Eris docs: https://abal.moe/Eris/
- npm weekly download stats retrieved 2026-06-06 from `https://api.npmjs.org/downloads/point/last-week/{pkg}`
- GitHub metadata retrieved 2026-06-06 from `https://api.github.com/repos/{owner}/{repo}`
