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

Open follow-ups (none blocking):

- Codex is daemon-backed with `CodexBridge` plus Codex hooks/install metadata,
  but the Codex + Telegram combination still needs the same human E2E pass
  Claude already completed.

- `💬 Other` → freetext path is wired but its observable behavior depends on
  how Claude Code's local `AskUserQuestion` UI handles typed freetext while
  in option-select mode; needs verification.
- `ClaudeWakeRegistry` is in-memory only; daemon restart loses wake-dir
  mappings until the next `claude_register_session` IPC call.
- `SessionStart` hook is unreliable on Windows (known Claude Code harness
  issue) — first prompt of a new Claude session is a manual "seed" prompt.

## Architecture

```
┌──────────────────┐         ┌─────────────────────────────┐         ┌──────────────┐
│ Claude Code      │  hooks  │  agents-comm-bus daemon     │ polls   │   Telegram   │
│  - hooks/claude/ ├────────►│  (per-user, WebSocket IPC)  │◄────────┤   bot API    │
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

- **Agent side** — `ClaudeBridge` (in `adapters/agent/claude/bridge.ts`)
  handles Claude's IPC methods, owns the inline-keyboard label choices
  specific to Claude's permission/question UX, writes wake responses to the
  watcher's filesystem dropbox. `CodexBridge`
  (`adapters/agent/codex/bridge.ts`) handles Codex IPC methods, app-server
  wake/steer capability dispatch, and blocking permission-query resolution.
  Future Gemini / etc. bridges live as siblings under `adapters/agent/`.
- **Comm side** — `TelegramCommAdapter` (in `adapters/comm/telegram/adapter.ts`)
  plus `TelegramCommAdapterFactory` (`factory.ts`) handles polling, sending,
  callback events, credential resolution, and contributes its MCP-tool IPC
  surface. Future Discord / Slack / Matrix adapters live as siblings under
  `adapters/comm/`.
- **Core daemon** — `runDaemon(options)` in `daemon.ts` knows nothing about
  specific agents or comms. The *only* file that imports both Claude- and
  Telegram-specific factories is `serve.ts` (32 lines, the composition root).

## Repo layout

```
.
├── agents-comm-bus-core/      # Shared types + Storage interface (no impl).
│   └── src/
│       ├── contracts/         # CommAdapter, AgentAdapter, ToolRegistry
│       ├── records/           # AccountRegistration, Conversation, Query, Session
│       ├── storage/           # Storage interface, MigrationRunner
│       └── ...
├── agents-comm-bus/           # The daemon + storage impl + adapters.
│   └── src/
│       ├── adapters/
│       │   ├── agent/claude/
│       │   │   ├── adapter.ts # ClaudeAgentAdapter (v3 contract, currently unused)
│       │   │   ├── bridge.ts  # ClaudeBridge + ClaudeBridgeFactory (v4 IPC handler)
│       │   │   └── wake.ts    # ClaudeWakeRegistry, writeClaudeWakeTrigger/Response
│       │   ├── agent/codex/
│       │   │   ├── adapter.ts # CodexAgentAdapter capabilities + hook/query mapping
│       │   │   ├── app-server.ts # Codex app-server turn/start + turn/steer client
│       │   │   └── bridge.ts  # CodexBridge + CodexBridgeFactory (v4 IPC handler)
│       │   └── comm/telegram/
│       │       ├── adapter.ts # TelegramCommAdapter
│       │       └── factory.ts # TelegramCommAdapterFactory + MCP IPC surface
│       ├── bootstrap/         # ensure-daemon, spawn-lock, handshake
│       ├── cli/               # account-add, account-list, account-remove CLI
│       ├── ipc/               # WebSocket protocol + server + client
│       ├── runtime/           # Generic contracts the daemon dispatches against:
│       │   ├── agent-bridge.ts
│       │   ├── comm-factory.ts
│       │   ├── ipc-method.ts
│       │   └── pending-inbound.ts
│       ├── storage/           # SqliteSessionStorage + JSONL transcripts/audit
│       ├── bus.ts             # MessageBus + DispatchSink + ResolveSink
│       ├── config.ts          # DAEMON_VERSION, IPC_PROTOCOL_VERSION
│       ├── daemon.ts          # runDaemon(options) library — NO adapter imports
│       └── serve.ts           # Composition root — wires factories into runDaemon
├── mcp-server/                # esbuild-bundled MCP shim exposing telegram_* tools
│   ├── server.js
│   └── dist/server.js         # bundled, gitignored
├── hooks/
│   ├── claude/
│   │   ├── permission-request.js   # PermissionRequest hook → claude_open_query
│   │   ├── user-prompt-submit.js   # UserPromptSubmit hook → claude_drain_inbound
│   │   └── wake-support.js         # spawns + targets enter-watcher.ps1
│   ├── permission-telegram.cjs     # Compat wrapper → claude/permission-request.js
│   ├── session-start.js            # SessionStart hook → ensures watcher
│   └── telegram-context.js         # Compat wrapper → claude/user-prompt-submit.js
├── scripts/
│   └── enter-watcher.ps1      # The wake watcher; polls trigger-enter, types via WM_CHAR
├── tests/architecture/        # bootstrap-race, ipc-versioning, plus per-adapter
└── docs/architecture/         # Sequence diagrams, e2e test guide + reports
```

## Build + test

The repo is three node packages; each has its own build:

```powershell
# agents-comm-bus-core (no dist tracked — gitignored)
cd agents-comm-bus-core
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
itself restarts — kill the `node …/mcp-server/dist/server.js` process and end
the Claude session to force a fresh spawn.

**Smoke test:** trigger an `AskUserQuestion` from Claude; confirm the Telegram
message arrives with HTML formatting + inline keyboard; tap a button; Claude's
CLI should auto-receive the corresponding digit + Enter.

## Running the daemon

The daemon is per-user, not per-project. It bootstraps lazily — any hook or
MCP-server call to `ensureDaemon()` spawns it if not already running. State
root is `~/.agents-comm-bus/`.

Entry point: `agents-comm-bus/dist/serve.js`. Spawning is automatic; for
manual debugging:

```powershell
node agents-comm-bus\dist\serve.js
```

Discovery files: `~/.agents-comm-bus/port` (listening port), `~/.agents-comm-bus/daemon.pid`
(the running daemon's PID). `ensure-daemon.ts` probes the port for a
version-compatible handshake before deciding whether to reuse or respawn.

## Adding a new comm adapter

1. Create `agents-comm-bus/src/adapters/comm/<name>/adapter.ts` implementing
   `CommAdapter` (from `agents-comm-bus-core/dist/contracts/comm-adapter.js`).
   At minimum: `start`, `stop`, `send`, `onInbound`, `onConnectionState`,
   `reportPressure`, `classifyFailure`. Optionally `onCallback`,
   `answerCallback`, `editMessage` if the platform supports inline buttons.
2. Create `agents-comm-bus/src/adapters/comm/<name>/factory.ts` implementing
   `CommAdapterFactory` (from `runtime/comm-factory.js`):
   - `commId` — the string written to `account_registrations.comm`.
   - `resolveCredentials(registration, env)` — read whatever `credentials_ref`
     scheme the adapter supports (`env:VARNAME`, `file:<path>`, etc.).
   - `fallbackFromEnv(env)` (optional) — dev-mode fallback when no
     registrations exist yet.
   - `create(credentials)` — instantiate the adapter.
   - `ipcMethods(deps)` (optional) — return a map of IPC method names to
     handlers (the MCP-tool surface). Method names should be prefixed with
     the comm id (e.g. `discord_send`).
3. Add the factory to `serve.ts`'s `commAdapterFactories` array.
4. If you want to use this comm from agents, add a corresponding tool in
   `mcp-server/server.js` so the agent's harness discovers it.

## Adding a new agent bridge

1. Create `agents-comm-bus/src/adapters/agent/<name>/bridge.ts` implementing
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
   shared IPC client (`agents-comm-bus/dist/ipc/client.js`).
4. Register the factory in `serve.ts`'s `agentBridgeFactories` array.

## Generic patterns

- **Composition root pattern.** `daemon.ts` is the library; `serve.ts` is
  the only file that wires it to specific adapters. Anything in `daemon.ts`
  with the words "claude" or "telegram" is a smell.
- **IPC method namespacing.** Bridges own `<agent>_*` methods (e.g.
  `claude_register_session`). Comm factories own `<comm>_*` methods (e.g.
  `telegram_send`). Generic methods like `list_conversations` are intrinsic
  to the daemon library.
- **Sinks for cross-cutting concerns.** `bus.setDispatchSink` (on each
  inbound) and `bus.setResolveSink` (on each query resolution) let the
  daemon route generic events to the agent bridge without bus.ts knowing
  about specific agents.
- **Shared inbound queue.** `pendingInbound` is owned by the daemon runtime
  and passed by reference to bridges + comm IPC handlers. Bridges drain it
  with their session-id stamping; comm-MCP handlers drain it generically.
- **Credentials are references, not secrets.** The DB stores
  `credentials_ref` (e.g. `env:TELEGRAM_BOT_TOKEN`, `file:/abs/path.json`).
  Adapter factories resolve them at startup; secrets never sit in the
  records table.
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
  the registration. `bus.send` resolves `target.account` (which may be
  either the `account_label` like `"main"` or the bot id directly) to a
  `bot_user_id` via the tolerant `registrationFor` lookup before keying
  the map.

## Anti-patterns (don't do these)

- **Don't import adapter modules from `daemon.ts`** — that's what the
  composition root in `serve.ts` is for. If `daemon.ts` needs to know about
  a specific adapter, add a generic interface in `runtime/` first.
- **Don't use `child_process.spawn(..., { detached: true })` to launch
  PowerShell scripts on Windows** — it's unreliable, the process often dies
  immediately or returns a phantom PID. Use `Start-Process -PassThru |
  Select-Object -ExpandProperty Id` via `execSync` instead. See
  `hooks/claude/wake-support.js`.
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
- **Don't forget to rebundle `mcp-server` after changing
  `bootstrap/ensure-daemon.ts`.** `mcp-server/dist/server.js` is an esbuild
  bundle that *inlines* `defaultSpawnDaemon`. The bundle stays stale until
  `npm run build` in `mcp-server/` rebakes it. If the bundle still spawns
  the old entry path, a cold start where the MCP server is the first to
  call `ensureDaemon()` will launch the wrong file (or a library-only
  daemon with no `main()`). In a lab with an always-running daemon this
  hides because the bundle's discovery probe finds the live daemon and
  skips the spawn. See commit `438f48b`.
- **Don't over-constrain account lookups by `bus.options.project`.** The
  daemon is per-user; `bus.options.project = process.cwd()` is just a
  hint, not a hard scope. `registrationFor`'s label-fallback first tries
  the daemon's cwd-project but then widens to all projects when nothing
  matches — otherwise manually-started daemons (cwd ≠ project) or
  daemons spawned from a subdirectory fail to resolve common labels like
  `"main"` and silently break outbound from `openClaudeQuery`. The
  bot-id path (`getAccountByBot`) is already project-independent. See
  commit `081b550`.

## State paths

All state under `~/.agents-comm-bus/` (per-user, never per-project):

| Path | What's there |
|------|--------------|
| `agents-comm-bus.db` | SQLite DB: accounts, conversations, sessions, queries, idempotency, transcript+blob refs |
| `port` | Daemon's listening WebSocket port |
| `daemon.pid` | Daemon process id |
| `spawn-lock*` | Bootstrap-race lock file |
| `audit/<date>.jsonl` | Append-only audit log: query_opened, query_resolved, inbound_received, outbound_sent, etc. |
| `chats/<conversation_id>/transcript.jsonl` | Per-conversation inbound + outbound transcript |
| `blobs/<hash>` | Content-addressed attachment blobs |
| `claude-wake/sessions/<key>/trigger-enter` | Wake trigger file (watcher polls this) |
| `claude-wake/sessions/<key>/permission-response.json` | Wake response payload (watcher reads, types chars) |
| `claude-wake/sessions/<key>/watcher.pid` | Watcher process id |
| `claude-wake/sessions/<key>/debug.log` | Watcher debug log |
| `claude-wake/sessions/<key>/watcher.lock` | Spawn-race lock for the watcher |

`<key>` is `<basename(project)>-<8-char-fnv1a-hash(project)>`. Computed by
`claudeWakeDirForProject` in `agents-comm-bus/src/adapters/agent/claude/wake.ts`
and the hook side in `hooks/claude/wake-support.js`.

## Configuration files

| File | Purpose |
|------|---------|
| `.mcp.json` (gitignored) | Local-dev MCP server registration with env-supplied creds |
| `.mcp.json.template` | Seed for `.mcp.json` after a fresh clone |
| `.claude-plugin/plugin.json` | Plugin metadata + canonical MCP server block for marketplace install |
| `.claude/telegram.json` (gitignored) | Per-project `{ botToken, userId }` — read by `TelegramCommAdapterFactory.resolveCredentials` as a fallback when the registration's `env:VARNAME` ref is unset |
| `.claude/settings.local.json` (gitignored) | Hook command paths + permission allow/deny rules |

For a fresh dev clone:

```powershell
cp .mcp.json.template .mcp.json
# Edit .mcp.json: set absolute paths and credentials
node agents-comm-bus\dist\cli\index.js account-add `
  --project "<absolute project path>" `
  --agent claude `
  --account-label main
# (with TELEGRAM_BOT_TOKEN exported)
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
correct. The plugin code referenced (`hooks/telegram-context.js`,
`hooks/permission-telegram.cjs`) now exists as thin compatibility wrappers
that delegate to `hooks/claude/*.js`; the original implementation lives in
the `main` branch.

### Wake / keystroke delivery (sessions 4–5, 2026-01-13 & 2026-02-14)

- **PostMessage WM_CHAR is the only reliable way** to type into a Claude Code
  console window on Windows. `WM_KEYDOWN` doesn't reach the console;
  `SetForegroundWindow` is blocked by focus-stealing prevention; `AppActivate`
  works but steals focus and breaks multi-session. `WriteConsoleInputW` looks
  like it works but ConPTY bypasses the console input buffer, so the chars
  never reach the agent.
- **`lParam = 1` is non-negotiable.** `lParam = 0` triggers 65536 repeats
  because the 16-bit repeat count wraps to max.
- **20 ms between chars** prevents drops on the receiving console.
- **VT escape sequences via WM_CHAR don't combine.** Each char is processed
  individually; arrow keys (`ESC [ B`) don't move the cursor. Use number-key
  selection for `AskUserQuestion`.
- **Process tree topology on Windows** (for finding the right cmd.exe):
  ```
  explorer.exe
    └─ cmd.exe (persistent — has the visible console)
         └─ claude.exe
              └─ cmd.exe (transient — exists only while a hook runs)
                   └─ node.exe (the hook process)
  ```
  Walking up from the hook's PID, the **first** cmd.exe is the transient one
  (dies with the hook). The watcher must target the **persistent** cmd.exe
  whose direct child is `claude.exe`.
- **Hook process has no console.** `GetConsoleWindow()` from inside the hook
  always returns 0. The window handle must come from walking the process
  tree, not from the hook's own console.

### Hook contract on Windows (session 4)

- **`SessionStart` hook is unreliable** in Claude Code on Windows (known
  harness issue). Workaround: also call `ensureClaudeWakeWatcher` from
  `UserPromptSubmit` (and now also `PermissionRequest`) so the watcher
  spawns at first prompt even if `SessionStart` never fires.
- **Node `spawn(detached:true)` on Windows often dies immediately**, especially
  when launching `powershell.exe -File`. Use `Start-Process -PassThru |
  Select-Object -ExpandProperty Id` via `execSync` to get the real PID of a
  detached child.

### MCP server bundling (session 3, still applies)

- `mcp-server` is bundled to a single file via `esbuild` so no `node_modules`
  is needed at runtime (3 MB bundle vs 46 MB modules).
- `node-telegram-bot-api` is CJS, the source is ESM, so the bundle needs:
  ```
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
  ```
  Required for Node 24+; without it, CJS deps crash at runtime when they call
  `require`.

### Universal-overhaul findings (2026-05-15 → 2026-05-16)

Picked up during the E2E test described in
`docs/architecture/2026-05-15-claude-telegram-e2e-test-report.md` and the
follow-up commits.

- **Schema SQL must be copied into `dist/`** — `tsc` only emits `.js`/`.d.ts`.
  `agents-comm-bus/scripts/copy-assets.js` handles this; without it,
  account-add silently fails (DB stays 0 bytes).
- **`upsertSession` must not include `most_recent_inbound_conversation_id`
  in its `ON CONFLICT DO UPDATE SET` clause.** That column has its own
  update path (`setSessionMostRecentInbound`) called from `drainClaudeInbound`;
  re-asserting it on every `claude_register_session` nulls the value out
  before `openClaudeQuery` reads it.
- **`queries.session_id` has a partial unique index** on `(session_id) WHERE
  resolved_at IS NULL`. Claude Code never tells the hook the user's local
  selection, so hook-opened queries never resolve. Mitigation:
  `supersedeOpenQueriesForSession` runs before every `bus.openQuery` and
  marks any leftover open queries as `resolution = {kind:"superseded"}`.
- **Daemon must read accounts from storage.** An earlier version only
  attached Telegram adapters when `process.env.TELEGRAM_BOT_TOKEN` was set
  in the daemon's own environment, ignoring the `account_registrations`
  table the CLI populates. The `TelegramCommAdapterFactory` now resolves
  credentials from `credentials_ref` (`env:VARNAME` with `.claude/telegram.json`
  fallback) for every registered row.
- **HTML rendering for query prompts requires `parse_mode: HTML`** on the
  `sendMessage` call, plus an HTML-escaped prompt body. `OutboundPayload.format
  = "html"` propagates through `telegramSendOptions` to set `parse_mode`.
- **Inline `callback_data` cap is 64 bytes** on Telegram. The `q:<query_id>:<value>`
  scheme fits at ~46 bytes max.
- **`connection_state: "degraded"` is sticky** in the Telegram adapter —
  emitted on every `polling_error` but never reset to `"connected"` on
  recovery. The state flag is informational; polling continues to work.

### Day-2 regression-fix findings (2026-05-17)

Discovered while implementing the Codex bridge alongside Claude, with
both registered under `comm="telegram"` with their own bots.

- **`mcp-server` bundle must be rebuilt after editing
  `bootstrap/ensure-daemon.ts`.** esbuild inlines the spawn target into
  the bundle. The fix for the daemon-vs-serve.js entry-point change
  (commit `96b40ad`) updated `ensure-daemon.ts` and the live `agents-comm-bus`
  dist, but `mcp-server/dist/server.js` carried the stale spawn line
  until a separate `npm run build` in `mcp-server/`. Symptom: hooks
  worked (they import the live `ensure-daemon.js`); a cold start where
  the MCP server is the first to call `ensureDaemon()` would have
  spawned the wrong path. Caught by Codex in code review; fixed in
  commit `438f48b`.
- **`MessageBus.comms` map collision on `comm.id`.** Two
  `account_registrations` rows with `comm="telegram"` (Claude bot
  `8950482517` + Codex bot `8988792099`) both produced `TelegramCommAdapter`
  instances with `comm.id="telegram"`. The bus's `Map<CommId, CommAdapter>`
  let the second adapter overwrite the first. Whichever bot lost the
  race sat orphaned (constructed but never started, inbound handler
  wired to nothing). The surviving adapter then 409'd against whichever
  external process was already polling its bot (e.g. the Codex MCP
  server polling Codex's bot directly). Fixed by adding
  `accountId: AccountId` to `CommAdapter`, threading it through
  `CommAdapterFactory.create`, and keying the bus map by
  `(commId, accountId)`. See commit `db8b4fd`. Codex correctly diagnosed
  this from the map structure alone before the polling 409 was traced.
- **`registrationFor` was over-constrained by `bus.options.project`.**
  Once `bus.send` started calling `registrationFor(target)` to resolve
  `target.account` → `bot_user_id`, manually-started daemons (whose cwd
  ≠ project) silently broke outbound from `openClaudeQuery`: the
  label-fallback lookup filtered by `bus.options.project = process.cwd()`,
  found nothing, and threw `no account registration for telegram/main`.
  Fix: widen the label fallback to all projects after the cwd-scoped
  lookup misses. Daemon is per-user, not per-project; cwd is just a
  hint. See commit `081b550`.
- **Adapter polling errors are silent by default.** When the daemon's
  Telegram adapter went `connected → degraded` repeatedly with no
  visible cause, the actual `polling_error` text (`ETELEGRAM: 409
  Conflict`) was being swallowed. The fix was diagnostic: temporarily
  log the error payload in the adapter's `polling_error` handler.
  Worth keeping a debug-mode toggle for this; otherwise future
  poll-failure bugs reduce to "stuck in degraded for unknown reason."

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
