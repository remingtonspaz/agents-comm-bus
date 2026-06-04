# Agent Reference — claude-code-telegram (universal-overhaul)

This branch retires the old single-agent / single-comm coupling. It introduces
a per-user **daemon** (`agents-comm-bus`) sitting between agent harnesses and
comm channels, with perpendicular adapter interfaces meeting at a thin bus.
See issue #7 for the full RFC.

## Current status

End-to-end working on Windows + Telegram with Claude Code as the agent:

- Inbound Telegram → Claude prompt-context injection: WORKING
- Outbound Claude → Telegram via MCP tool: WORKING
- Auto-wake (Telegram message → watcher types `.`+Enter into Claude terminal): WORKING
- Permission queries routed to Telegram with inline-keyboard buttons (`✅ / ❌ / 🔓`): WORKING
- `AskUserQuestion` routed to Telegram with numbered-option buttons + `💬 Other`: WORKING
- Text-reply resolution (`y` / `n` / `a` / `<digit>`) via watcher: WORKING
- Button-tap resolution via Telegram `callback_query`: WORKING
- HTML-formatted prompts (parity with the original plugin): WORKING

Codex + Telegram is now also confirmed end-to-end on Windows:

- Inbound Telegram -> Codex wake/resume via Codex app-server: WORKING
- Outbound Codex -> Telegram via MCP `comm_send_message` (`comm: "telegram"`): WORKING
- Codex permission prompts routed to Telegram inline buttons: WORKING
- Telegram button selection resolves back to the Codex session: WORKING
- Codex first-prompt `SessionStart` repair hook detects registered comm
  accounts without `CODEX_APP_SERVER_URL` and schedules the same-terminal
  bootstrapper: WORKING in local restart testing
- Mid-turn inbound uses `turn/steer` first, with `turn/start` fallback:
  WORKING in the tested Codex app-server version
- Claude and Codex can share `account_label=main` without sharing live comm
  adapters or conversation ids: WORKING

Open follow-ups (none blocking):

- `💬 Other` → freetext path is wired but its observable behavior depends on
  how Claude Code's local `AskUserQuestion` UI handles typed freetext while
  in option-select mode; needs verification.
- `ClaudeWakeRegistry` is in-memory only; daemon restart loses wake-dir
  mappings until the next `claude_register_session` IPC call.
- `SessionStart` hook is unreliable on Windows (known Claude Code harness
  issue, tracked upstream as
  [anthropics/claude-code#21468](https://github.com/anthropics/claude-code/issues/21468),
  still open + `stale` as of 2026-05-17) — first prompt of a new Claude
  session is a manual "seed" prompt.

## Architecture

```
┌──────────────────┐         ┌─────────────────────────────┐         ┌──────────────┐
│ Claude Code      │  hooks  │  agents-comm-bus daemon     │ polls   │   Telegram   │
│  - hosts/claude/hooks/ ├────────►│  (per-user, WebSocket IPC)  │◄────────┤   bot API    │
│  - MCP server    │  WS IPC │                             │ sends   │              │
└──────────────────┘  WS IPC │  ┌────────────────────────┐ │         └──────────────┘
                        ┌────┼─►│ MessageBus             │ │
                        │    │  │  + dispatch sink       │ │
                        │    │  │  + resolve sink        │ │
                        │    │  └────────────────────────┘ │
                        │    │           │                 │
                        │    │  ┌────────┴──────────┐      │
                        │    │  │ ClaudeBridge      │      │
                        │    │  │  (AgentBridge)    │      │
                        │    │  └────────┬──────────┘      │
                        │    │  ┌────────┴──────────┐      │
                        │    │  │ TelegramComm-     │      │
                        │    │  │  Adapter          │      │
                        │    │  └───────────────────┘      │
                        │    └─────────────────────────────┘
                        │                  │ writes
                        │                  ▼
                        │       ~/.agents-comm-bus/
                        │         claude-wake/sessions/<key>/
                        │           trigger-enter           ◄─── reads
                        │                                          ┌──────────────────┐
                        └──────── PostMessage WM_CHAR ─────────────┤ enter-watcher.ps1 │
                                  to persistent cmd.exe            └──────────────────┘
```

Three perpendicular layers meeting at the bus:

- **Agent side** — `ClaudeBridge` (in `core-daemon/bridges/claude/bridge.ts`)
  handles Claude's IPC methods, owns the inline-keyboard label choices
  specific to Claude's permission/question UX, writes wake responses to the
  watcher's filesystem dropbox. `CodexBridge`
  (`core-daemon/bridges/codex/bridge.ts`) handles Codex IPC methods, app-server
  wake/steer capability dispatch, and blocking permission-query resolution.
  Future Gemini / etc. bridges live as siblings under `core-daemon/bridges/`.
- **Comm side** — `TelegramCommAdapter` (in `adapters/telegram/adapter.ts`)
  plus `TelegramCommAdapterFactory` (`factory.ts`) handles polling, sending,
  callback events, credential resolution, and contributes its MCP-tool IPC
  surface. Future Discord / Slack / Matrix adapters live as sibling top-level
  folders under `adapters/`.
- **Core daemon** — `runDaemon(options)` in `daemon.ts` knows nothing about
  specific agents or comms. The *only* file that imports both Claude- and
  Telegram-specific factories is `serve.ts` (the composition root).

## Repo layout

```
.
├── packages/core-contracts/   # Shared types + Storage interface (no impl).
│   └── src/
│       ├── contracts/         # CommAdapter, AgentAdapter, ToolRegistry
│       ├── records/           # AccountRegistration, Conversation, Query, Session
│       ├── storage/           # Storage interface, MigrationRunner
│       └── ...
├── adapters/
│   └── telegram/
│       ├── adapter.ts         # TelegramCommAdapter
│       └── factory.ts         # TelegramCommAdapterFactory + MCP IPC surface
├── core-daemon/               # Daemon source (compiled into agents-comm-bus/dist/).
│   ├── bridges/
│   │   ├── claude/
│   │   │   ├── adapter.ts     # ClaudeAgentAdapter (v3 contract, currently unused)
│   │   │   ├── bridge.ts      # ClaudeBridge + ClaudeBridgeFactory (v4 IPC handler)
│   │   │   └── wake.ts        # ClaudeWakeRegistry, writeClaudeWakeTrigger/Response
│   │   └── codex/
│   │       ├── adapter.ts     # CodexAgentAdapter capabilities + hook/query mapping
│   │       ├── app-server.ts  # Codex app-server turn/start + turn/steer client
│   │       ├── app-server-lifecycle.ts # Codex app-server stop/kill logic
│   │       └── bridge.ts      # CodexBridge + CodexBridgeFactory (v4 IPC handler)
│   ├── bootstrap/             # ensure-daemon, spawn-lock, handshake
│   ├── cli/                   # account-add, account-list, account-remove, account-update-token CLI
│   ├── ipc/                   # WebSocket protocol + server + client
│   ├── runtime/               # Generic contracts the daemon dispatches against:
│   │   ├── agent-bridge.ts
│   │   ├── comm-factory.ts
│   │   ├── ipc-method.ts
│   │   └── pending-inbound.ts
│   ├── storage/               # SqliteSessionStorage + JSONL transcripts/audit
│   ├── bus.ts                 # MessageBus + DispatchSink + ResolveSink
│   ├── config.ts              # DAEMON_VERSION, IPC_PROTOCOL_VERSION
│   ├── daemon.ts              # runDaemon(options) library — NO adapter imports
│   └── serve.ts               # Composition root — wires factories into runDaemon
├── agents-comm-bus/           # Daemon npm package (dist tracked, built from core-daemon/).
├── mcp-server/                # esbuild-bundled MCP shim exposing comm_* tools
│   ├── server.js
│   └── dist/server.js         # bundled, gitignored
├── hosts/
│   ├── claude/
│   │   ├── claude-mcp-shim.js      # Claude MCP shim host entrypoint
│   │   └── hooks/
│   │       ├── hooks.json          # Claude hook manifest
│   │       ├── permission-request.js   # PermissionRequest hook → claude_open_query
│   │       ├── session-start.js        # SessionStart hook → ensures watcher
│   │       ├── user-prompt-submit.js   # UserPromptSubmit hook → claude_drain_inbound
│   │       └── wake-support.js         # spawns + targets enter-watcher.ps1
│   ├── codex/
│   │   ├── codex-mcp-shim.js       # Codex MCP shim host entrypoint
│   │   └── hooks/
│   │       ├── permission-request.js   # PermissionRequest hook → codex_open_query
│   │       ├── session-start.js        # SessionStart repair hook → managed restart
│   │       └── user-prompt-submit.js   # UserPromptSubmit hook → codex_drain_inbound
│   └── common/
│       └── mcp-shim-shared.js      # Shared MCP shim plumbing
├── scripts/
│   └── enter-watcher.ps1      # The wake watcher; polls trigger-enter, types via WM_CHAR
├── tests/architecture/        # bootstrap-race, ipc-versioning, plus per-adapter
└── docs/architecture/         # Sequence diagrams, e2e test guide + reports
```

## Build + test

The repo is three node packages; each has its own build:

```powershell
# packages/core-contracts (no dist tracked — gitignored)
cd packages/core-contracts
npm install
npm run build

# agents-comm-bus (dist IS tracked; tsc + asset copy for SQL schema)
cd ..\agents-comm-bus
npm install
npm run build

# mcp-server (esbuild bundle; dist tracked)
cd ..\mcp-server
npm install
npm run build
```

**The `agents-comm` / `agents-comm-bus` command (AGE-30).** In a
production/marketplace install, central install lays the admin CLI down at
`~/.agents-comm-bus/bin/cli.js` and writes `agents-comm` / `agents-comm-bus`
launcher shims next to it (Windows `.cmd` + POSIX). Add `~/.agents-comm-bus/bin`
to PATH **once** and the command works from anywhere — no `npm link`, no npm
global state:

```powershell
# one-time (PowerShell, current user):
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:USERPROFILE\.agents-comm-bus\bin", "User")
# then, from a new shell:
agents-comm account-list
```

The shims just run `node ~/.agents-comm-bus/bin/cli.js`, so a `node` on PATH is
the only prerequisite. The CLI rides under the daemon version (a `cli.bundle.js`
change bumps `DAEMON_VERSION`; no separate CLI version). For **source/dev** work
you can instead `npm link` from `agents-comm-bus/` to expose the bin commands
from the source dist — a dev convenience, not how marketplace installs get the
command.

Use `agents-comm account-update-token` to rotate a bot token; replacing the
bot identity requires `--allow-bot-change` and remaps per-bot allowlist rows
plus conversation `bot_user_id` references.

Tests (only the bootstrap-race + IPC-versioning suites run by default; others
are exercised via build typecheck):

```powershell
cd agents-comm-bus
npm test
```

Add new tests to `tests/architecture/*.test.ts`; tsx + `node --test` runner.

**Verifying changes touch real code:** for daemon/adapter changes, restart the
daemon (`Stop-Process` the pid in `~/.agents-comm-bus/daemon.pid`, delete the
`port` and `daemon.pid` files) so the next hook/MCP call respawns it via the
new `serve.js` entry. The MCP server picks up changes only when Claude Code
itself restarts — kill the `node …/mcp-server/dist/claude-mcp-shim.js` process and end
the Claude session to force a fresh spawn.

**Smoke test:** trigger an `AskUserQuestion` from Claude; confirm the Telegram
message arrives with HTML formatting + inline keyboard; tap a button; Claude's
CLI should auto-receive the corresponding digit + Enter.

## Running the daemon

The daemon is per-user, not per-project. It bootstraps lazily; any hook or
MCP-server call to `ensureDaemon()` spawns it if not already running. Durable
state root is `~/.agents-comm-bus/` by default.

Entry point: `agents-comm-bus/dist/core-daemon/serve.js`. Spawning is automatic; for
manual debugging:

```powershell
node agents-comm-bus\dist\core-daemon\serve.js
```

Production/default discovery files live at `~/.agents-comm-bus/port`,
`~/.agents-comm-bus/daemon.pid`, and `~/.agents-comm-bus/.spawn.lock`. Source
checkouts can split only these runtime discovery files by setting
`discoveryRoot` in `.agents-comm-bus-dev.json`; this repo uses the gitignored
workspace folder `.agents-comm-bus-discovery/` so a dev daemon can live
alongside the production daemon while sharing the durable DB/tokens root.
`ensure-daemon.ts` probes the discovery-root port for a protocol-compatible
handshake before deciding whether to reuse or spawn.

## Adding a new comm adapter

1. Create `adapters/<name>/adapter.ts` implementing
   `CommAdapter` (from `packages/core-contracts/dist/contracts/comm-adapter.js`).
   At minimum: `start`, `stop`, `send`, `onInbound`, `onConnectionState`,
   `reportPressure`, `classifyFailure`. Optionally `onCallback`,
   `answerCallback`, `editMessage` if the platform supports inline buttons.
2. Create `adapters/<name>/factory.ts` implementing
   `CommAdapterFactory` (from `runtime/comm-factory.js`):
   - `commId` — the string written to `account_registrations.comm`.
   - `resolveCredentials(registration, env)` — read the adapter's
     daemon-owned `file:<path>` credential reference. Env may still carry
     non-secret runtime options such as allowlist CSVs.
   - `create(credentials)` — instantiate the adapter.
   - `ipcMethods(deps)` (optional) — return a map of IPC method names to
     handlers (the MCP-tool surface). Method names should be prefixed with
     the comm id (e.g. `discord_send`).
3. Add the factory to `serve.ts`'s `commAdapterFactories` array.
4. If you want to use this comm from agents, add a corresponding tool in
   `hosts/claude/claude-mcp-shim.js` so the agent's harness discovers it.

## Adding a new agent bridge

1. Create `core-daemon/bridges/<name>/bridge.ts` implementing
   `AgentBridge` (from `runtime/agent-bridge.js`):
   - `agentId` — written to `sessions.agent` and `account_registrations.agent`.
   - `ipcMethods` — `ReadonlySet<string>` of method names this bridge owns.
     Convention: prefix with the agent id (e.g. `codex_register_session`).
   - `attach(comms)` — wire up `bus.setResolveSink` (write wake-style
     responses) and `comm.onCallback` (handle button taps).
   - `onInboundConversation(conversation)` (optional) — write a wake trigger
     so the agent processes the message.
   - `handleIpcMethod(method, params, ctx)` — dispatch within the bridge.
2. Add a sibling `AgentBridgeFactory` (`agentId` + `create(context)`).
3. Add hook scripts under `hooks/<agent>/` that talk to the daemon via the
   shared IPC client (`agents-comm-bus/dist/core-daemon/ipc/client.js`).
4. Register the factory in `serve.ts`'s `agentBridgeFactories` array.

## Generic patterns

- **Composition root pattern.** `daemon.ts` is the library; `serve.ts` is
  the only file that wires it to specific adapters. Anything in `daemon.ts`
  with the words "claude" or "telegram" is a smell.
- **Daemon version vs IPC protocol (these are different axes — don't conflate).**
  Two version constants live in `core-daemon/config.ts`:
  - `IPC_PROTOCOL_VERSION` is the **wire/schema contract** between the agent
    surfaces (MCP shim + hooks) and the daemon. Compatibility is keyed on the
    **major** component (`isProtocolCompatible` / `protocolMajor`). This is the
    ONLY thing that decides whether a running daemon can serve a client.
  - `DAEMON_VERSION` is the **bundle/artifact version**. It governs
    central-install superseding of `bin/daemon.js` (highest-wins) and the
    AGE-25 CI version-bump gate. It is **not** a runtime compatibility signal.

  `ensureDaemon` reuse is therefore gated on protocol only: a running daemon at
  a *different* `DAEMON_VERSION` but the same protocol major is **reused, never
  terminated** — so a 0.2.1 shim happily talks to a 0.2.2 daemon. Termination
  happens only on protocol **incompatibility**, and an older-protocol daemon is
  replaced while a *newer*-protocol daemon is never downgraded (it errors asking
  for a session restart). Practical consequence: a non-breaking `DAEMON_VERSION`
  bump (CLI/adapter/daemon patch) does **not** require a coordinated fleet
  restart; only an `IPC_PROTOCOL_VERSION` **major** bump does — so bump the
  protocol major (and only then) when you change the wire/schema in a
  backward-incompatible way. The earlier exact-`DAEMON_VERSION`-equality reuse
  check (in both directions) is what let two shims at different patch versions
  terminate each other's daemon forever; see `bootstrap/ensure-daemon.ts`.
  `npm run check:ipc-protocol` (AGE-34) enforces the same distinction in CI:
  it fingerprints the exported IPC protocol type/signature surface, ignores
  function bodies, and fails when that contract changes without an
  `IPC_PROTOCOL_VERSION` bump or explicit `IPC_COMPAT_NOTE`.
- **IPC method namespacing.** Bridges own `<agent>_*` methods (e.g.
  `claude_register_session`). Comm factories own `<comm>_*` methods (e.g.
  `telegram_send` on the daemon IPC side). The MCP shim exposes generic
  `comm_*` tools such as `comm_send_message`, `comm_send_attachment`, and
  `comm_check_messages`; explicit targets flow through the nested
  `target.{chat_native_id, thread_native_id?}` shape rather than flat
  Telegram-specific fields. Generic methods like `list_conversations` are
  intrinsic to the daemon library.
- **Sinks for cross-cutting concerns.** `bus.setDispatchSink` (on each
  inbound) and `bus.setResolveSink` (on each query resolution) let the
  daemon route generic events to the agent bridge without bus.ts knowing
  about specific agents.
- **Shared inbound queue.** `pendingInbound` is owned by the daemon runtime
  and passed by reference to bridges + comm IPC handlers. Bridges drain it
  with their session-id stamping; comm-MCP handlers drain it generically.
- **Lazy, session-triggered comm-adapter instantiation (AGE-38).** The daemon
  does **not** eager-load every registered bot at startup — it boots with
  **zero adapters** and brings up only the bots a `(project, agent)` session
  needs, via `ensureCommsForSession(project, agent)` (in `daemon.ts`) called
  from each bridge's register-session handler (`claude_register_session` /
  `codex_register_session`). This makes the daemon *courteous*: a daemon only
  contends for (and leases, AGE-35) the bots its live sessions actually use, so
  a dev/main-dev daemon working on one project no longer reclaims every prod
  bot across all projects. The instantiation is idempotent (skip bots already
  live or in-flight) and best-effort per bot (a bad credential is logged, not
  thrown — it must not fail session registration). The shared add-sequence
  (`addAdapterForRegistration`) is `createAdapterFromRegistration` →
  `bus.registerComm` → `bridge.attachComm` *for every bridge* (this wires
  button-tap callback resolution — easy to forget) → `adapter.start()`, with
  rollback (best-effort `adapter.stop()` — a partial start can leak a poller,
  e.g. the Telegram adapter spins up its `getUpdates` poller before `getMe()`
  resolves — then `unregisterComm` + `detachComm`) on a failed start so a
  failed-to-start adapter is never wedged in `bus.comms` or left polling
  outside the lease. The lease wrapper (`wrapWithLease.start`) does the same
  `inner.stop()` before releasing the lease on an inner-start failure. A
  **zero-adapter
  daemon is a valid steady state** — `checkDaemonPidOwnership` keys on
  pid-file ownership, never adapter count, so a daemon with no live sessions
  does not self-retire. Consistency invariants that ride with this: (a) the
  **reload path is scope-gated** — `reloadAdapters` hot-adds a row only if it is
  already live OR its `(agent, project)` scope is active (a session for it
  registered this daemon-lifetime, tracked in `activeScopes`); rows for projects
  the daemon isn't serving stay lazy, so a CLI write firing
  `reload_registrations` can't re-introduce eager global loading, while
  `account-add` for an actively-served project still takes effect immediately
  (active-scope eviction rides with the deferred session-exit work); (b)
  **drains are scoped to the session's
  `(project, agent)`**, not agent-wide — `ownedAccountKeys(session)` /
  `resolveOwnedAccountKeys` resolve the session's project so one project's
  session can't sweep another project's pending inbound. **No release-on-exit
  yet:** an instantiated adapter stays until daemon stop. The rare case where a
  would-be-outranked daemon needs a bot a higher-rank daemon holds is handled
  manually (drop the dev marker, kill the dev daemon + its pid marker, let the
  account's session re-ensure into prod); robust refcount-release is deferred
  until per-host session-*exit* tracking is reliable.
- **Credentials are daemon-owned file references, not inline secrets.** The
  DB stores `credentials_ref` as `file:/abs/path.json`. Adapter factories
  resolve them at startup; secrets never sit in the records table.
- **Callback resolutions bypass TTL.** When a user actively taps a button or
  sends a text reply, the query resolves even if its TTL passed. TTL is for
  abandoned queries, not slow ones.
- **Supersede prior open queries when opening a new one.** Claude Code never
  re-invokes hooks with the user's local selection, so hook-opened queries
  never close themselves. `daemon.openClaudeQuery` calls
  `supersedeOpenQueriesForSession` before each `bus.openQuery` to keep the
  partial unique index `idx_queries_one_open_per_session` from deadlocking.
- **Multi-bot support via `(commId, accountId)` keying.** `MessageBus.comms`
  is `Map<string, CommAdapter>` keyed by `${commId}:${accountId}` so a
  single daemon can host one bot per agent (Claude bot + Codex bot, both
  with `comm.id="telegram"`) without collision. Every `CommAdapter` is
  required to expose `readonly accountId` (e.g. Telegram `bot_user_id`)
  and `CommAdapterFactory.create(credentials, accountId)` takes it from
  the registration. `bus.send` requires `target.account` to be a concrete
  `bot_user_id` (AGE-15): `registrationFor` resolves it via `getAccountByBot`
  only and rejects account labels — labels like `"main"` are ambiguous across
  agents (Claude and Codex both register `"main"`). The inbound block surfaces
  the bot id as `account=<id>`; omit `target` entirely to reply to the
  session's most-recent inbound.
- **Conversation identity includes `agent`.** `conversation_id` and the
  SQLite conversations primary key include `project + agent + comm +
  account_label + chat_native_id + thread_native_id`. Claude and Codex may
  both use `account_label="main"` for the same Telegram chat; they must still
  get separate transcript files and query-resolution windows.
- **Codex wake is steer-first.** Telegram inbound for Codex calls
  `turn/steer` with the actual daemon-delivered message context, then falls
  back to `turn/start` only if steering fails. A successful steer removes the
  delivered messages from `pendingInbound` so a later `UserPromptSubmit` does
  not inject duplicates.
- **Path-only Codex MCP config is intentional.** Global Codex config should
  only point at `mcp-server/dist/codex-mcp-shim.js`. Session-specific app-server URL,
  thread id, and daemon session id come from `scripts/bootstrap-codex-session.ps1`
  and runtime discovery in `hosts/codex/codex-mcp-shim.js`.
- **Codex `SessionStart` is first-prompt repair, not true process startup.**
  `hosts/codex/hooks/session-start.js` only schedules a same-terminal bootstrap
  restart when daemon IPC reports that this project has a Codex comm account
  registration and the current process lacks a reachable managed app-server
  (`CODEX_APP_SERVER_URL` + `AGENTS_COMM_BUS_SESSION_ID`). It has a short
  restart-loop guard under `~/.agents-comm-bus/codex-bootstrapper/`. The hook
  must pass the detected Codex thread id to the bootstrapper with `-ThreadId`;
  relying on inherited env alone can relaunch Codex on a fresh comm-bus session
  instead of the existing thread.
- **Codex `PermissionRequest` hooks disable auto-mode classification.**
  Unlike Claude, enabling a Codex `PermissionRequest` hook currently disables
  Codex's auto-mode classifier. The current workaround for the most seamless
  Codex experience is to manually disable the `PermissionRequest` hook and
  rely on local Codex permission handling rather than comm-bus-routed
  permission prompts.
- **Codex app-server lifecycle is MCP-owned.** The MCP shim registers the
  Codex session with `manage_app_server_lifecycle=true` and
  `replace_existing_lease=true`. When that lease closes and remains idle after
  a short grace delay, `CodexBridge` stops the bootstrapper-tracked app-server
  PID and terminal PID, but only after command-line verification against the
  recorded `appServerUrl` / wrapper path. Short-lived hook registrations must
  not own app-server cleanup.

## Anti-patterns (don't do these)

- **Don't import adapter modules from `daemon.ts`** — that's what the
  composition root in `serve.ts` is for. If `daemon.ts` needs to know about
  a specific adapter, add a generic interface in `runtime/` first.
- **Don't use `child_process.spawn(..., { detached: true })` to launch
  PowerShell scripts on Windows** — it's unreliable, the process often dies
  immediately or returns a phantom PID. Use `Start-Process -PassThru |
  Select-Object -ExpandProperty Id` via `execSync` instead. See
  `hosts/claude/hooks/wake-support.js`.
- **Don't return the first `cmd.exe` walking up the process tree from a
  hook** — that's the *transient* cmd.exe (child of `claude.exe`), which
  dies when the hook exits. Walk the full chain and return the cmd.exe
  whose direct child is `claude.exe` (the *persistent* one with the visible
  console window). See `findCmdAncestor` in `wake-support.js`.
- **Don't call `PostMessage(hwnd, WM_CHAR, ch, 0)`** — `lParam = 0` triggers
  **65536 repeats** because the 16-bit repeat count wraps. Always use
  `lParam = 1`. See `scripts/enter-watcher.ps1`.
- **Don't use `WM_KEYDOWN` for console windows via PostMessage** — only
  `WM_CHAR` reaches them. VT escape sequences (`ESC [ B`) also don't
  combine — each char processed individually. Use number-key selection.
- **Don't clobber DB columns on UPSERT that have their own update path.**
  `upsertSession`'s `ON CONFLICT DO UPDATE SET` excludes
  `most_recent_inbound_conversation_id` because `setSessionMostRecentInbound`
  writes it independently — including it in the upsert nulled out the value
  every time `claude_register_session` fired (which is before *every* hook
  IPC call). One commit's worth of debugging avoided by this rule.
- **Don't enforce TTL on callback-resolution paths** — the user actively
  responded; "expired" is the wrong outcome. Only enforce TTL when the
  resolution path is "I assume you weren't going to answer."
- **Don't bundle multiple comm tokens behind one bot account.** Telegram
  rejects duplicate `getUpdates` consumers with a 409 Conflict; multiple
  daemons polling the same bot is the same correctness bug. The
  `account_registrations` unique index on `(comm, bot_user_id)` enforces
  this.
- **Don't add comm-specific fields to `OutboundPayload`** — keep it generic
  (`format`, `inline_keyboard`, `attachments`). Adapters that don't support
  a field ignore it.
- **Don't key `MessageBus.comms` by `comm.id` alone.** A daemon legitimately
  hosts multiple adapters with the same `comm.id` (e.g. one Telegram bot
  per agent). The map key must be `(commId, accountId)`. The first version
  of the multi-agent setup keyed by `commId` only, and the second adapter
  silently overwrote the first — its bot's polling never started, messages
  sat unread on Telegram, and the surviving adapter 409'd against whichever
  external process was already polling its bot. See commit `db8b4fd`.
- **Don't key conversations by `(project, comm, account_label, chat)` alone.**
  Claude and Codex can both register Telegram as `account_label="main"` for
  the same chat. Omitting `agent` mixes transcripts and can let plain-text
  query replies resolve against the wrong agent. See commit `ef0c96e`.
- **Don't remove `pendingInbound` entries by `message_id` alone in a bridge.**
  The shared queue can hold two entries with the same `message_id` when the
  same platform message reaches two bots (e.g. one Telegram group chat with
  both a Claude bot and a Codex bot — each adapter pushes its own entry,
  distinguished only by `chat.account`). Scoping a remove by message_id
  alone wipes the sibling entry, so the *other* agent's drain hook
  subsequently finds an empty queue and never injects the inbound into the
  prompt. Symptom from the user's perspective: "wake fires but no inbound
  appears." Remove by the composite key `(message_id, chat.comm, chat.account)`
  — same shape `accountKey` already uses for filter paths. The Claude side
  doesn't hit this because `ClaudeBridge.drainPendingInbound` removes by
  index inside an `accountKey`-filtered loop; only the Codex side's
  post-steer cleanup carried the bug.
- **Don't forget to rebundle `mcp-server` after changing
  `bootstrap/ensure-daemon.ts`.** `mcp-server/dist/claude-mcp-shim.js` is an esbuild
  bundle that *inlines* `defaultSpawnDaemon`. The bundle stays stale until
  `npm run build` in `mcp-server/` rebakes it. If the bundle still spawns
  the old entry path, a cold start where the MCP server is the first to
  call `ensureDaemon()` will launch the wrong file (or a library-only
  daemon with no `main()`). In a lab with an always-running daemon this
  hides because the bundle's discovery probe finds the live daemon and
  skips the spawn. See commit `438f48b`. The shim also inlines the whole
  central-install path (`executeInstallPlan` etc.), so the same staleness bit
  AGE-23 Phase B / AGE-26 (missing schema sidecars + ESM pins). **`npm run
  verify:clean-build` (AGE-29) now guards this**: it rebuilds every tracked
  generated artifact and fails if any drifted from source. Run it (and the CI
  on `windows-latest` runs it) after touching the install path / daemon /
  adapters; it's the enforcement for this whole anti-pattern.
- **Route outbound by `bot_user_id`, never by `account_label` (AGE-15).**
  `registrationFor` resolves `target.account` via `getAccountByBot` ONLY; an
  account label fails loud with an actionable error. The old label fallback
  (try the daemon's cwd-project, then widen to all projects) was the source of
  the 2026-05-30 cross-agent misroute — `"main"` resolved to whichever
  registration was found first — so it has been removed. `getAccountByBot` is
  already project-independent, so the daemon-is-per-user concern that once
  motivated the project-widening (`081b550`) no longer applies to routing:
  there is no label resolution left to widen. Agents must send a concrete bot
  id (surfaced as `account=<id>` in the inbound block / `bot=<id>` from
  `list_conversations`) or omit `target` to reply to the most-recent inbound.
- **Don't use account labels when sending session-derived targets.** When a
  session has a recent conversation, resolve it back to the concrete
  `(project, agent, comm, account_label)` registration and send with
  `bot_user_id`. Labels like `"main"` are only human aliases and are
  ambiguous across agents. See commit `cbc4a43`.
- **Don't wake Codex with `turn/start` unconditionally.** If Codex is already
  busy after a tool call, another `turn/start` can leave the session in a long
  `"working..."` state. Use the steer-first path and keep the fallback.

## State paths

Durable state lives under `~/.agents-comm-bus/` by default (per-user, never
per-project). Production/default discovery also uses this root; source/dev
checkouts may put only `port` / `daemon.pid` / `.spawn.lock` under a separate
gitignored `discoveryRoot`.

| Path | What's there |
|------|--------------|
| `agents-comm-bus.db` | SQLite DB: accounts, conversations, sessions, queries, idempotency, transcript+blob refs |
| `port` | Daemon's listening WebSocket port |
| `daemon.pid` | Daemon process id |
| `.spawn.lock` | Bootstrap-race lock file |
| `bin/daemon.js` (+ `package.json`, `*.sql`) | Central-installed self-contained daemon bundle + ESM pin + migration sidecars (AGE-23) |
| `bin/cli.js` + `agents-comm` / `agents-comm-bus` (`.cmd`) | Central-installed admin CLI bundle + launcher shims; add `bin/` to PATH (AGE-30) |
| `bin/version.json` | Daemon (incl. CLI) bundle version + ref-count provenance |
| `adapters/<comm>.js` (+ `package.json`, `<comm>.version.json`) | Central-installed comm adapter bundle, dynamically loaded by the daemon (AGE-26) |
| `audit/<date>.jsonl` | Append-only audit log: query_opened, query_resolved, inbound_received, outbound_sent, etc. |
| `chats/<conversation_id>/transcript.jsonl` | Per-conversation inbound + outbound transcript |
| `blobs/<hash>` | Content-addressed attachment blobs |
| `tokens/<comm>/<project-key>/<agent>/<bot-id>.json` | Daemon-owned token files used by `file:` credential refs created by `account-add --bot-token` |
| `claude-wake/sessions/<key>/trigger-enter` | Wake trigger file (watcher polls this) |
| `claude-wake/sessions/<key>/permission-response.json` | Wake response payload (watcher reads, types chars) |
| `claude-wake/sessions/<key>/watcher.pid` | Watcher process id |
| `claude-wake/sessions/<key>/debug.log` | Watcher debug log |
| `claude-wake/sessions/<key>/watcher.lock` | Spawn-race lock for the watcher |

When `.agents-comm-bus-dev.json` includes
`"discoveryRoot": ".agents-comm-bus-discovery"`, that folder contains the dev
daemon's `port`, `daemon.pid`, and `.spawn.lock`. It does not contain DB,
tokens, transcripts, central-install bundles, or comm locks. Comm-resource
leases stay homedir/global, so prod and dev daemons still arbitrate exclusive
single-consumer resources even while using separate discovery roots. There is no
central enumeration of all discovery roots in v1; the global comm locks are the
central ownership view.

`<key>` is `<basename(project)>-<8-char-fnv1a-hash(project)>`. Computed by
`claudeWakeDirForProject` in `core-daemon/bridges/claude/wake.ts`
and the hook side in `hosts/claude/hooks/wake-support.js`.

## Configuration files

| File | Purpose |
|------|---------|
| `.mcp.json` (gitignored) | Local-dev MCP server registration path/env overrides |
| `.mcp.json.template` | Seed for `.mcp.json` after a fresh clone |
| `.claude-plugin/plugin.json` | Plugin metadata + canonical MCP server block for marketplace install |
| `.claude/telegram.json` (gitignored) | Legacy per-project Telegram config used only by migration readers; runtime credentials live in daemon-owned token files |
| `.claude/settings.local.json` (gitignored) | Hook command paths + permission allow/deny rules |
| `.codex/config.toml` (gitignored) | Project-local Codex hook config written by `install-codex.js`; global `~/.codex/config.toml` should keep only the path-only MCP server entry. |

Legacy `env:` Telegram credential refs are not a supported runtime scheme
anymore. On first startup after the upgrade, resolvable legacy rows are
migrated once into daemon-owned `file:` token refs using either the named env
var or the old project-local `.<agent>/telegram.json` / `.claude/telegram.json`
fallback. Rows that cannot be migrated are skipped with an actionable daemon log;
rerun `account-update-token --bot-token` to create the file ref.

For a fresh dev clone:

```powershell
cp .mcp.json.template .mcp.json
# Edit .mcp.json: set absolute paths and dev overrides.
# After the first central install, add ~/.agents-comm-bus/bin to PATH once,
# then use the central CLI:
agents-comm account-add `
  --project "<absolute project path>" `
  --agent claude `
  --account-label main `
  --bot-token "<telegram bot token>"
```

## Troubleshooting

| Symptom | First thing to check |
|---------|----------------------|
| MCP tools missing in Claude session | Restart Claude (MCP servers only spawn at session start). |
| `mcp__telegram__*` calls time out | Daemon not running or version mismatch. Kill the running daemon (PID in `~/.agents-comm-bus/daemon.pid`), remove `port` + `daemon.pid`, retry. |
| Inbound Telegram messages don't reach Claude | `~/.agents-comm-bus/daemon.stderr.log` (if running via Start-Process) or daemon's stderr; check `audit/*.jsonl` for `inbound_received` events. If no events, the Telegram adapter isn't polling — credentials probably didn't resolve. |
| Telegram → Claude wake doesn't fire | `~/.agents-comm-bus/claude-wake/sessions/<key>/debug.log`. If `trigger-enter` exists but is unconsumed, watcher is dead. If trigger never appears, daemon's `onInboundConversation` didn't fire. |
| Permission prompt button tap does nothing | `~/.agents-comm-bus/permission-hook.trace.log` (when enabled); audit log for `query_resolved` event. If `query_expired`, bump TTL or check that callback resolutions actually bypass TTL. |
| Buttons render but tap returns "Already resolved" on first try | Likely an old `q_*` query is still open and superseded the new one; check `queries` table for `resolved_at IS NULL` rows. The fix landed in `daemon.openClaudeQuery → supersedeOpenQueriesForSession`. |
| `UNIQUE constraint failed: queries.session_id` in trace | Same as above — partial unique index `idx_queries_one_open_per_session`. Ensure the supersede call is wired. |
| Watcher targets the wrong terminal | `wake-support.js` is returning the transient cmd.exe. Verify the process tree walk; `findCmdAncestor` should return the cmd.exe whose direct child is `claude.exe`. |
| Characters dropped, doubled, or sent 65536× | `lParam` in the `PostMessage WM_CHAR` call must be `1`, not `0`. |
| `AskUserQuestion` instantly selects option 1 | The `y` + Enter from a prior permission approval is leaking into the question UI. Make sure the permission hook auto-approves `AskUserQuestion` with `{decision:{behavior:"allow"}}` so no `y`+Enter precedes the question. |
| Daemon respawns endlessly | Spawn-lock race; check `~/.agents-comm-bus/spawn-lock*`. Manually remove if stale. |
| Telegram returns `409 Conflict: terminated by other getUpdates` | Two daemons polling the same bot. Kill one. |
| Codex inbound triggers long `working...` | Check that the live daemon has the steer-first Codex bridge. Rebuild `agents-comm-bus`, restart the daemon, and relaunch Codex via `scripts/bootstrap-codex-session.ps1`. |
| Codex sends through the Claude bot | Check `account_registrations` and conversation identity. Session-derived sends and query prompts must resolve to the concrete Codex `bot_user_id`, not label `main`. |

### Useful debug commands

```powershell
# Daemon state
Get-Content "$env:USERPROFILE\.agents-comm-bus\port"
Get-Process -Id (Get-Content "$env:USERPROFILE\.agents-comm-bus\daemon.pid") -ErrorAction SilentlyContinue

# Audit tail (skip connection-state spam)
Get-Content "$env:USERPROFILE\.agents-comm-bus\audit\$(Get-Date -Format yyyy-MM-dd).jsonl" |
  Where-Object { $_ -notmatch 'connection_state' } | Select-Object -Last 20

# Watcher state
$wake = "$env:USERPROFILE\.agents-comm-bus\claude-wake\sessions\<key>"
Get-Content "$wake\debug.log" -Tail 10
Get-Process -Id (Get-Content "$wake\watcher.pid") -ErrorAction SilentlyContinue

# Inspect a single query
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(require('os').homedir()+'/.agents-comm-bus/agents-comm-bus.db');console.log(db.prepare('SELECT * FROM queries WHERE query_id = ?').get('q_...'))"
```

## Historical notes (preserve)

These findings predate the universal-overhaul refactor but remain technically
correct. The plugin code referenced (`hosts/claude/hooks/user-prompt-submit.js`,
`hosts/claude/hooks/permission-request.js`) now exists as thin compatibility wrappers
that delegate to `hosts/claude/hooks/*.js`; the original implementation lives in
the `main` branch.

- [Wake / keystroke delivery](docs/hist/wake-keystroke-delivery.md)
- [Hook contract on Windows](docs/hist/hook-contract-on-windows.md)
- [MCP server bundling](docs/hist/mcp-server-bundling.md)
- [Universal-overhaul findings](docs/hist/universal-overhaul-findings.md)
- [Day-2 regression-fix findings](docs/hist/day-2-regression-fix-findings.md)
- [Codex + Telegram E2E findings](docs/hist/codex-telegram-e2e-findings.md)

## Session history (sessions 1–5 + universal-overhaul)

| Session | Date | Topic |
|---------|------|-------|
| 1 | 2026-01-09 | Initial watcher auto-spawn and debug logging. |
| 2 | 2026-01-09 | Built permission control via Telegram (`y`/`n`/`a` responses). |
| 3 | 2026-01-09 | Plugin conversion — converted from standalone to Claude Code plugin format. |
| 4 | 2026-01-13 | Watcher auto-spawn fixes (Node spawn unreliable on Windows; `SessionStart` hook bug workaround). |
| 5 | 2026-02-14 | PostMessage WM_CHAR adopted; `AskUserQuestion` numbered-option selection. |
| Universal overhaul | 2026-05-15 → 2026-05-16 | Daemon + adapter architecture per issue #7; inline-keyboard buttons; daemon adapter-agnostic via composition root. See `docs/architecture/2026-05-15-claude-telegram-e2e-test-report.md`. |
| Multi-agent shakedown | 2026-05-17 | Codex bridge added alongside Claude; multi-adapter regression fixes (mcp-server rebundle, `(commId, accountId)` map keying, project-independent label fallback). |
| Codex E2E shakedown | 2026-05-17 | Codex + Telegram live E2E confirmed; bootstrapper, steer-first wake, bot-id routing, and agent-scoped conversation identity. See `docs/architecture/2026-05-17-codex-telegram-e2e-test-report.md`. |
