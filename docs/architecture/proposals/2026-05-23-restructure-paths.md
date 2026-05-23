# Restructure path mapping — proposal

**Status:** proposal / source-of-truth path manifest for the restructure
**Date:** 2026-05-23
**Decision snapshot:**
- **#1 bridge location:** settled — daemon-side agent bridges live under `core/bridges/<agent>/`
- **#2 `agents-comm-bus-core` fold vs separate:** still pending
- **#3 MCP shim comm-genericity:** architectural concern dissolved; per-agent shim split is restructure mechanics, not a prerequisite

## Boundary definitions

- **`core/`** means **daemon runtime**, not "agent-agnostic kernel." Agent-specific code that runs inside the daemon process belongs here.
- **`core/bridges/`** contains **daemon-side agent protocol handlers**.
- **`hosts/<agent>/`** contains the **installed edge** for that host: MCP shim, hooks, skills, manifest wiring, and other host-runtime glue.
- **`hosts/common/`** is allowed for **shared host-side plumbing** used by multiple host entrypoints (for example shared MCP-shim code). It is still host-edge code, not daemon runtime.
- **`adapters/<comm>/`** contains **comm/provider integrations**.
- **Review/planning reference rule:** when referring to bridge entry files, use the full path (for example `core/bridges/claude/bridge.ts`), never bare `bridge.ts`.

---

## 1) Current → proposed path table

| Current path | Proposed path | Notes |
|---|---|---|
| `agents-comm-bus/src/daemon.ts` | `core/daemon.ts` | Daemon library entrypoint stays in runtime core. |
| `agents-comm-bus/src/bus.ts` | `core/bus.ts` | MessageBus is daemon runtime, not host glue. |
| `agents-comm-bus/src/serve.ts` | `core/serve.ts` | Composition root remains daemon-side. |
| `agents-comm-bus/src/config.ts` | `core/config.ts` | Daemon runtime config. |
| `agents-comm-bus/src/paths.ts` | `core/paths.ts` | Daemon path resolution. |
| `agents-comm-bus/src/runtime/**` | `core/runtime/**` | Shared daemon runtime contracts/helpers. |
| `agents-comm-bus/src/ipc/**` | `core/ipc/**` | Daemon IPC server/client/protocol plumbing. |
| `agents-comm-bus/src/bootstrap/**` | `core/bootstrap/**` | Daemon bootstrap / discovery / spawn lock logic. |
| `agents-comm-bus/src/storage/**` | `core/storage/**` | SQLite / blobs / audit / transcript stores remain daemon runtime. |
| `agents-comm-bus/src/migrations/**` | `core/migrations/**` | Legacy-import logic stays with daemon runtime. |
| `agents-comm-bus/src/cli/**` | `core/cli/**` | CLI continues to operate on daemon/runtime state. |
| `agents-comm-bus/src/types/vendor.d.ts` | `core/types/vendor.d.ts` | Keep with daemon source unless superseded during TS cleanup. Final `types/` consolidation depends on decision #2 if `agents-comm-bus-core/src/types/**` is folded into the restructured tree. |
| `agents-comm-bus/src/adapters/comm/telegram/**` | `adapters/telegram/**` | CommAdapter source moves out of daemon package tree into top-level comm space. |
| `agents-comm-bus/src/adapters/comm/<future-comm>/**` | `adapters/<future-comm>/**` | Same rule for Matrix/Discord/Slack/etc. |
| `agents-comm-bus/src/adapters/agent/claude/bridge.ts` | `core/bridges/claude/bridge.ts` | Settled decision #1: bridge is daemon-side agent runtime. |
| `agents-comm-bus/src/adapters/agent/claude/adapter.ts` | `core/bridges/claude/adapter.ts` | Companion file stays grouped with Claude bridge module. |
| `agents-comm-bus/src/adapters/agent/claude/wake.ts` | `core/bridges/claude/wake.ts` | Claude wake behavior is daemon-side bridge support code. |
| `agents-comm-bus/src/adapters/agent/codex/bridge.ts` | `core/bridges/codex/bridge.ts` | Settled decision #1. |
| `agents-comm-bus/src/adapters/agent/codex/adapter.ts` | `core/bridges/codex/adapter.ts` | Companion file stays grouped with Codex bridge module. |
| `agents-comm-bus/src/adapters/agent/codex/app-server.ts` | `core/bridges/codex/app-server.ts` | Codex app-server handshake/runtime support is daemon-side bridge code today. |
| `agents-comm-bus/src/adapters/agent/codex/app-server-lifecycle.ts` | `core/bridges/codex/app-server-lifecycle.ts` | Same as above. |
| `mcp-server/server.js` | `hosts/common/mcp-shim-shared.js` + `hosts/claude/claude-mcp-shim.js` + `hosts/codex/codex-mcp-shim.js` | Shared plumbing extracted once; final per-agent entrypoints live under `hosts/<agent>/`. Exact extraction split is part of the restructure, not a prerequisite. |
| `mcp-server/codex-app-server.js` | `hosts/codex/codex-app-server.js` | Codex host helper; keep with Codex host-side glue unless later folded into bridge/runtime code. |
| `hooks/claude/permission-request.js` | `hosts/claude/hooks/permission-request.js` | Host-installed Claude hook. |
| `hooks/claude/user-prompt-submit.js` | `hosts/claude/hooks/user-prompt-submit.js` | Host-installed Claude hook. |
| `hooks/claude/wake-support.js` | `hosts/claude/hooks/wake-support.js` | Host-installed Claude hook/helper. |
| `hooks/codex/permission-request.js` | `hosts/codex/hooks/permission-request.js` | Host-installed Codex hook. |
| `hooks/codex/user-prompt-submit.js` | `hosts/codex/hooks/user-prompt-submit.js` | Host-installed Codex hook. |
| `hooks/codex/session-start.js` | `hosts/codex/hooks/session-start.js` | Host-installed Codex hook. |
| `hooks/session-start.js` | `hosts/claude/hooks/session-start.js` or delete during cleanup | Current root-level path should either become explicit Claude host glue or be removed if superseded. Prefer deleting thin root-level compatibility wrappers during the hard-cut restructure unless a concrete compatibility contract still requires them. |
| `hooks/telegram-context.js` | delete during cleanup | Current file is a thin backcompat wrapper into Claude host glue. Prefer deleting root-level compatibility wrappers during the hard-cut restructure rather than carrying them forward. |
| `skills/telegram/SKILL.md` | `hosts/claude/skills/telegram.md` and `hosts/codex/skills/telegram.md` | Source can be duplicated or generated from a shared template; shipped artifact is per-agent. |
| `.claude-plugin/plugin.json` | `plugins/claude/<comm>/.claude-plugin/plugin.json` | Built artifact location per install-model doc. The `.claude-plugin/` directory is intentionally nested inside each comm-specific plugin subtree. |
| `.codex-plugin/plugin.json` | `plugins/codex/<comm>/.codex-plugin/plugin.json` | Built artifact location per install-model doc. |
| `.mcp.json.template` | `plugins/codex/<comm>/.mcp.json` (generated artifact) or `hosts/codex/.mcp.json.template` | Exact template-vs-generated choice is implementation detail; Codex still owns this file at the host/plugin edge. |
| `agents-comm-bus-core/**` | **pending decision #2** | Either remains a separate package or is folded into the new tree. Do not hard-code paths until decision #2 is resolved. |

### Notes on `agents-comm-bus-core` (decision #2 pending)

This proposal deliberately does **not** freeze the final home for `agents-comm-bus-core/**`.
Two valid branches remain open:

1. **Keep separate package**
   - `agents-comm-bus-core/**` stays as-is
   - `core/**`, `adapters/**`, and `hosts/**` import from it
2. **Fold into the restructured tree**
   - contracts/types/records/storage interfaces move into a new shared location inside the monorepo
   - import paths update accordingly

All other path moves in this document are compatible with either choice.

---

## 2) What stays in `hosts/<agent>/`

After the move, `hosts/<agent>/` is the **installed edge** for that agent host. It should contain only code/artifacts that are coupled to the host runtime, not daemon-resident bridge logic.

### Stays in `hosts/<agent>/`

- `<agent>-mcp-shim.js`
  - per-agent MCP entrypoint
  - stateless forwarder into the daemon
- `hooks/**`
  - host lifecycle hooks
  - prompt-submit / permission / session-start / wake glue
- `skills/**`
  - host-consumable skill/docs shipped with the plugin
- host manifest/config wiring
  - e.g. `.claude-plugin/plugin.json`
  - e.g. Codex `.codex-plugin/plugin.json`
  - e.g. Codex `.mcp.json`
- other host-only helpers
  - e.g. Codex MCP/app-server startup helpers if they are launched from the host/plugin side rather than the daemon side

### Must not live in `hosts/<agent>/`

- daemon `MessageBus` logic
- daemon-side `AgentBridge` implementations
- daemon-side query resolution / comm callback wiring
- daemon-owned storage / IPC / migration logic
- CommAdapters

### Rule of thumb

If a module is imported by the daemon composition root and runs **inside the daemon process**, it belongs in `core/` (including `core/bridges/`), not in `hosts/<agent>/`.

---

## 3) What `serve.ts` imports after the move

The composition root stays small and remains the load-bearing wire diagram reviewers can inspect to verify the runtime boundary.

### Current shape

```ts
import { runDaemon } from "./daemon.js";
import { TelegramCommAdapterFactory } from "./adapters/comm/telegram/factory.js";
import { ClaudeBridgeFactory } from "./adapters/agent/claude/bridge.js";
import { CodexBridgeFactory } from "./adapters/agent/codex/bridge.js";
```

### Proposed shape

```ts
import { runDaemon } from "./daemon.js";
import { TelegramCommAdapterFactory } from "../adapters/telegram/factory.js";
import { ClaudeBridgeFactory } from "./bridges/claude/bridge.js";
import { CodexBridgeFactory } from "./bridges/codex/bridge.js";
```

If/when more comms land:

```ts
import { MatrixCommAdapterFactory } from "../adapters/matrix/factory.js";
import { DiscordCommAdapterFactory } from "../adapters/discord/factory.js";
```

If/when daemon-side bridge discovery is introduced later, the boundary still holds:
- discovery belongs with daemon runtime (`core/bridge-discovery/**` or similar)
- discovered bridge factories still instantiate daemon-side `AgentBridge`s
- `hosts/<agent>/` remains install/runtime edge only

---

## Summary

This path mapping locks in the settled bridge decision without pre-committing the unresolved `agents-comm-bus-core` fold/separate question.

- **Settled now:**
  - daemon-side agent bridges move under `core/bridges/<agent>/`
  - comm adapters move under top-level `adapters/<comm>/`
  - host-installed shims/hooks/skills/manifests live under `hosts/<agent>/`
- **Still open:**
  - whether `agents-comm-bus-core` remains separate or is folded into the restructured tree

That leaves this document usable as the restructure path manifest immediately, while preserving one remaining structural decision for follow-up.
