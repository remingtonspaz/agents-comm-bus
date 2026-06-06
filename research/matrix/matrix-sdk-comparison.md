# Matrix SDK / Library Comparison for agents-comm-bus

> Research date: 2026-06-06  
> Target runtime: Node.js >=22, TypeScript ESM  
> Use case: Comm adapter for Matrix protocol in the agents-comm-bus daemon

---

## Executive Summary

For a Node.js/TypeScript comm adapter, four SDKs are worth evaluating in detail, while several Python and Rust libraries exist but are split-language or niche. The primary recommendation is `matrix-bot-sdk` for **bot/bridge use cases**, with `matrix-js-sdk` as the fallback if full client-side encryption (E2EE) or Element-level compatibility is required.

---

## Serious Candidates (Node.js + TypeScript)

### 1. matrix-bot-sdk (turt2live)

| Attribute | Details |
|-----------|---------|
| **Repository** | https://github.com/turt2live/matrix-bot-sdk |
| **npm** | `matrix-bot-sdk` |
| **Language** | TypeScript |
| **License** | MIT |
| **Stars** | ~268 |
| **Maintenance** | Active; last commit ~3 months ago; maintained by Travis Ralston (turt2live), former Matrix.org SRE |
| **Dependencies** | `@matrix-org/matrix-sdk-crypto-nodejs`, `express`, `request`, `sanitize-html`, `postgres`, etc. |
| **Node engine** | `>=22.0.0` |

#### Strengths
- **Purpose-built for bots and bridges** — room management, event handling, and appservice support are first-class.
- **Higher-level abstractions** than matrix-js-sdk: `MatrixClient`, `AutojoinRoomsMixin`, `SimpleFsStorageProvider`, `SQLStorageProvider`.
- **Strong appservice support** if you later want to run as an appservice rather than a simple bot.
- **Type definitions ship with the package**; written in TypeScript.
- **Crypto support** via rust-sdk Node.js bindings (`@matrix-org/matrix-sdk-crypto-nodejs`).

#### Weaknesses / Caveats
- Smaller ecosystem (268 stars vs. 2.1k for matrix-js-sdk).
- Depends on `request` and `request-promise` which are deprecated in the Node.js ecosystem (though still maintained here).
- Last release cadence is slower than matrix-js-sdk; some features may lag behind spec releases.
- Documentation is JSDoc-generated and functional but less extensive than Element's SDK docs.

#### Fit / Non-Fit for agents-comm-bus
- **Fit** if the adapter acts as a bot user (joins rooms, sends/receives messages, handles simple state events).
- **Non-Fit** if you need deep client UI features (widget API, VoIP call handling, rich media previews).

---

### 2. matrix-js-sdk (matrix-org)

| Attribute | Details |
|-----------|---------|
| **Repository** | https://github.com/matrix-org/matrix-js-sdk |
| **npm** | `matrix-js-sdk` |
| **Language** | TypeScript (compiled with Babel) |
| **License** | Apache-2.0 |
| **Stars** | ~2,129 |
| **Maintenance** | Very active; sponsored by Element; commits daily; 542 tags |
| **Dependencies** | `@matrix-org/matrix-sdk-crypto-wasm`, `oidc-client-ts`, `p-retry`, `sdp-transform`, etc. |
| **Node engine** | `>=22.0.0` |

#### Strengths
- **Official, spec-compliant reference SDK** for Matrix Client-Server API.
- **Mature E2EE implementation** via WASM crypto bindings (`matrix-sdk-crypto-wasm`).
- **Browser + Node.js** support out of the box.
- **Broad feature coverage**: room state, sync, presence, media, typing, receipts, full crypto, widgets, VoIP.
- **Large community and issue tracker** means edge cases are usually documented.
- Element Web/Desktop depend on this SDK, so it tracks the spec closely.

#### Weaknesses / Caveats
- **Lower-level API**: you write more glue code for bot-like patterns (autojoin, simple command parsing, storage).
- **Heavy dependency tree**: includes browser-specific deps (sdp-transform, oidc-client-ts) even if you only use Node.js.
- **Requires more boilerplate** for simple bot tasks compared to matrix-bot-sdk.
- **Build complexity**: uses Babel + pnpm; embedding into another TypeScript project may need explicit transpile configuration.
- **License is Apache-2.0** (vs. MIT for bot-sdk) — compatible with MIT but slightly more restrictive.

#### Fit / Non-Fit for agents-comm-bus
- **Fit** if you need maximum spec coverage, E2EE, or plan to support encrypted Matrix rooms.
- **Fit** if you want the safest long-term maintenance bet (Element sponsorship).
- **Non-Fit** if bundle size or dependency weight matters; bot-sdk is leaner for pure bot use.

---

### 3. matrix-rust-sdk (matrix-org) — with Node.js bindings

| Attribute | Details |
|-----------|---------|
| **Repository** | https://github.com/matrix-org/matrix-rust-sdk |
| **Language** | Rust (with WASM / Node.js bindings) |
| **License** | Apache-2.0 |
| **Stars** | ~2,145 |
| **Maintenance** | Very active; Element core team; bleeding-edge crypto performance |

#### Strengths
- **Best-in-class E2EE performance** and memory safety.
- Used as the crypto backend for matrix-js-sdk (WASM) and matrix-bot-sdk (Node.js native bindings).
- Actively developed; future-proof.

#### Weaknesses / Caveats
- **Not a direct Node.js SDK**: you consume it via bindings (`@matrix-org/matrix-sdk-crypto-wasm` or `@matrix-org/matrix-sdk-crypto-nodejs`), not as a primary application SDK.
- **Steeper integration cost** for a TypeScript project: N-API or WASM boundary adds complexity.
- Not a standalone replacement for either bot-sdk or js-sdk unless you want to write a Rust daemon.

#### Fit / Non-Fit for agents-comm-bus
- **Fit** only as a crypto submodule (which both Node SDKs already do).
- **Non-Fit** as a direct adapter dependency unless the entire daemon is rewritten in Rust.

---

## Cross-Language / Niche Candidates

### 4. matrix-nio (Python)

| Attribute | Details |
|-----------|---------|
| **Repository** | https://github.com/matrix-nio/matrix-nio |
| **Language** | Python |
| **License** | ISC-like (ambiguous SPDX) |
| **Stars** | ~702 |

- **Sans-I/O design**: great for asyncio Python.
- **Not compatible** with the agents-comm-bus Node.js/TypeScript runtime.
- Consider only if a Python microservice bridge is acceptable, but that breaks the current adapter architecture.

#### Fit / Non-Fit
- **Non-Fit** for direct integration into the existing TypeScript daemon.

---

### 5. simple-matrix-sdk (community)

| Attribute | Details |
|-----------|---------|
| **Repository** | https://github.com/krazykirby99999/simple-matrix-sdk |
| **Language** | JavaScript |

- Zero-dependency, minimal implementation.
- Not actively maintained; lacks E2EE, sync v2, or robust error handling.

#### Fit / Non-Fit
- **Non-Fit** for production use but could serve as a proof-of-concept if bundle size is paramount.

---

## Comparison Matrix

| Criterion | matrix-bot-sdk | matrix-js-sdk | matrix-rust-sdk* | matrix-nio |
|-----------|---------------|---------------|------------------|------------|
| **Runtime** | Node.js >=22 | Node.js + Browser | Rust / WASM bindings | Python 3 |
| **Language** | TypeScript | TypeScript | Rust | Python |
| **License** | MIT | Apache-2.0 | Apache-2.0 | Ambiguous |
| **Maintenance** | Active (author-led) | Very active (Element) | Very active | Moderate |
| **Stars** | ~268 | ~2,129 | ~2,145 | ~702 |
| **Spec coverage** | Bot-focused, ~80% | Full client, ~99% | Full client, ~99% | Full client, ~90% |
| **E2EE** | Yes (rust bindings) | Yes (WASM) | Native best-in-class | Yes (optional) |
| **Typing** | First-class TS | First-class TS | Rust + TS bindings | Python type hints |
| **Bot helpers** | Excellent (built-in) | Manual / community | None direct | Minimal |
| **Appservices** | Built-in support | Community modules | None direct | Minimal |
| **Sync (v2/sliding)** | Sync v2 | Sync v2 + sliding sync | Sliding sync native | Sync v2 |
| **Storage abstractions** | Yes (FS, SQL) | Manual or custom | SQLite via bindings | Yes (memory/disk) |
| **Bundle size** | Medium | Large (browser deps) | N/A (bindings only) | N/A |
| **Current project fit** | **High** | **High** | **Low** (bindings only) | **None** (wrong runtime) |

*Rust SDK is evaluated here as a direct dependency, not as a crypto backend.

---

## Compatibility with agents-comm-bus Runtime

| Concern | Assessment |
|---------|------------|
| **Node.js >=22** | Both matrix-js-sdk and matrix-bot-sdk require `>=22`. The project already specifies `>=22` in root `package.json`. |
| **ESM (`"type": "module"`)** | Both SDKs ship ESM-compatible builds. matrix-js-sdk uses `"type": "module"`; matrix-bot-sdk compiles to CommonJS but works in ESM via `import`. |
| **TypeScript 5.x** | Both have native `.d.ts` definitions. bot-sdk is simpler to integrate; js-sdk may need `@ts-ignore` for some Babel-generated types. |
| **Workspace / monorepo** | Straightforward `npm install` into the daemon or a new `adapters/matrix/` workspace package. No architectural blockers. |
| **Crypto native modules** | `@matrix-org/matrix-sdk-crypto-nodejs` (bot-sdk) and `@matrix-org/matrix-sdk-crypto-wasm` (js-sdk) both contain native binaries/WASM. Ensure CI/build environment supports N-API or WASM runtime. |

---

## Recommendation

For an **agents-comm-bus Matrix comm adapter**, `matrix-bot-sdk` is the pragmatic first choice:

1. **Aligned scope**: It is designed for bots/bridges, not full clients, matching the likely adapter pattern (listen to rooms, send messages, handle commands).
2. **Ergonomic abstractions**: `AutojoinRoomsMixin`, `SimpleFsStorageProvider`, and baked-in `MatrixClient` event emitters reduce boilerplate significantly versus matrix-js-sdk.
3. **Sufficient crypto**: E2EE is supported via the same Rust bindings that power matrix-js-sdk; for a bot adapter, this is adequate.
4. **Lighter dependency graph**: No browser-specific media/VoIP deps that bloat the daemon bundle.

**Use `matrix-js-sdk` instead if**:
- Future roadmap includes running a full Matrix client (user registration flows, device verification UI, widget support).
- You want the highest spec-completeness guarantee and do not mind writing helper layers yourself.
- Element/Web compatibility is a hard requirement.

---

## Source Links

- matrix-bot-sdk: https://github.com/turt2live/matrix-bot-sdk
- matrix-js-sdk: https://github.com/matrix-org/matrix-js-sdk
- matrix-rust-sdk: https://github.com/matrix-org/matrix-rust-sdk
- matrix-nio: https://github.com/matrix-nio/matrix-nio
- matrix-bot-sdk docs: https://turt2live.github.io/matrix-bot-sdk/index.html
- matrix-js-sdk npm: https://www.npmjs.com/package/matrix-js-sdk
