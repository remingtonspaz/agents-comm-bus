# Codex + Telegram E2E Test Report

- **Date:** 2026-05-17
- **Branch:** `universal-overhaul`
- **Guide:** [`codex-telegram-e2e-test-guide.md`](./codex-telegram-e2e-test-guide.md)
- **Outcome:** Codex + Telegram is end-to-end working after the bootstrap,
  lease, turn-control, bot-routing, and conversation-identity fixes landed.
  Inbound Telegram messages wake/resume Codex, outbound replies use the Codex
  bot, and permission prompts plus button selections route through the Codex
  path.

## Scope

This pass validated the Phase 3 Codex integration against the shared
`agents-comm-bus` daemon:

- path-only global Codex MCP registration
- project-local Codex hook installation
- bootstrapper-launched Codex app-server + resumed Codex session
- Telegram inbound auto-wake via Codex app-server RPC
- Codex outbound via `telegram_send`
- Codex `PermissionRequest` routing through Telegram inline buttons
- coexistence with Claude + Telegram on the same daemon

The test was iterative. Several failures were found only after running the
live Codex + Telegram loop with a real app-server and two Telegram bot
registrations (`agent=claude` and `agent=codex`, both using
`account_label=main`).

## Current working state

Confirmed by live testing:

- Telegram inbound to Codex wakes the resumed session consistently.
- Codex can reply to Telegram using the Codex bot.
- Subsequent inbound messages no longer leave Codex stuck in a long
  `"working..."` state.
- Codex permission prompts are sent through the Codex bot.
- Permission button selection resolves back into the Codex session.
- Claude and Codex conversations no longer share a conversation key when both
  use `account_label=main`.

The final pushed commits for this pass:

- `cbc4a43` - `Stabilize Codex Telegram E2E flow`
- `ef0c96e` - `Separate conversations by agent`

## Issues found and fixes applied

### 1. Path-only Codex MCP config needed session bootstrap support

Goal: the global Codex config should only need:

```toml
[mcp_servers.telegram]
command = "node"
args = ["...\\mcp-server\\dist\\server.js"]
```

That means session-specific values such as app-server URL, thread id, and
stable daemon session id cannot live in global config arguments. The solution
was to add a session bootstrapper and make the MCP shim discover enough local
runtime context to register the active session.

Implemented in `cbc4a43`:

- Added `scripts/bootstrap-codex-session.ps1`.
- Starts a separate Codex app-server PowerShell window.
- Finds a free port in `4500-4600` when none is supplied.
- Optionally resumes a thread id.
- Runs Codex with `--remote ws://127.0.0.1:<port>`.
- Reports the app-server PID.
- Sets a stable `AGENTS_COMM_BUS_SESSION_ID`.

Observed successful test launches used:

- bootstrapper PowerShell PID examples: `40272`, `72012`, `58896`
- app-server URL: `ws://127.0.0.1:4501`
- resumed thread: `019e2dc2-afb1-7171-8f55-bc5cacb03370`
- daemon session: `codex_e8b91d40b5447858f1659723`

### 2. MCP bundle spawned the wrong daemon entry on cold start

The MCP server bundle inlines its imports. A cold start where the MCP server
was the first caller of `ensureDaemon()` could resolve the daemon entry
relative to the bundled MCP artifact and spawn the wrong path.

Fix:

- `mcp-server/server.js` now supplies a custom `spawnDaemonFromMcpShim()`.
- The bundled shim explicitly resolves `agents-comm-bus/dist/serve.js`.
- `mcp-server/dist/server.js` was rebuilt.

### 3. Codex session leases were lost or clobbered across hook/MCP calls

The persistent MCP process is the useful long-lived Codex registration because
it knows the app-server URL. Hooks also call `codex_register_session`, but they
are short-lived. Before the fix, hook upserts could clobber lease fields or a
new daemon could reject re-registration because a stale persisted lease still
existed.

Fix:

- `upsertSession()` no longer updates lease columns on conflict.
- `codex_register_session` is idempotent when the lease is already held.
- Persistent MCP registrations can reclaim stale leases after a daemon restart.
- `persist_after_disconnect` keeps the bridge mapping after the MCP IPC socket
  closes.

### 4. Inbound wake used `turn/start` even when Codex was already busy

Live symptom:

1. First inbound worked.
2. Codex replied to Telegram.
3. After the reply, later inbound messages triggered long `"working..."`
   states that needed interruption.

Root cause: the Codex adapter advertised `midTurnPolicy = "steer"`, but
`CodexBridge.onInboundConversation()` always called the wake path, which used
`turn/start` with `"."`.

Fix:

- Added `CodexAgentAdapter.wakeOrSteer()`.
- Inbound now tries `turn/steer` first with the actual daemon-delivered
  Telegram message context.
- If steering fails, it falls back to `turn/start`.
- When steering succeeds, the delivered messages are removed from the pending
  hook queue so they are not injected twice on a later `UserPromptSubmit`.

Live result: inbound + outbound became consistent after this change.

### 5. Outbound replies selected the Claude bot

Live symptom: Codex received inbound through the Codex bot, but a
`telegram_send` reply went out through the Claude bot.

Root cause: when `telegram_send` omitted an explicit target, `bus.send()`
resolved the session target via most-recent conversation, but then label
fallback could resolve `account_label=main` to the first Telegram registration.
With both Claude and Codex registered as `main`, this was ambiguous.

Fix:

- `MessageBus.targetFromSession()` now resolves the session's conversation
  back to the matching `(project, agent, comm, account_label)` registration.
- The resulting `ChatRef.account` is the concrete `bot_user_id`, not the label.

Live result: Codex outbound replies used the Codex bot.

### 6. Permission prompts still selected the Claude bot

Live symptom: normal Codex outbound was fixed, but Codex permission prompts
were still sent through the Claude bot. Button selection still resolved back
to Codex, which showed query ids and callback handling were mostly correct.

Root cause: `CodexBridge.openQuery()` built `origin_chat.account` from
`conversation.account_label`, again using `"main"` instead of the concrete
Codex bot id.

Fix:

- `CodexBridge.openQuery()` now resolves the conversation to the concrete
  registration before sending the permission prompt.
- The analogous Claude query path was updated to use the same concrete
  bot-id lookup.
- Explicit `chat_id` sends in `TelegramCommAdapterFactory` now prefer the
  active session's project/agent registration before falling back globally.

Live result: permission prompt routing confirmed fixed.

### 7. Claude and Codex shared the same `conversation_id`

Follow-up flagged by another session:

> Claude and Codex still share the same conversation_id when both registrations
> use account_label=main. The bot target is now correct, but the conversation
> key should probably include agent or concrete bot id to avoid mixed
> transcripts and possible plain-text query resolution collisions.

This was a real bug.

Root cause: conversation identity was:

```text
project + comm + account_label + chat_native_id + thread_native_id
```

Because both registrations used `account_label=main`, Claude and Codex
conversations for the same Telegram chat collapsed into the same row and same
`chats/<conversation_id>/transcript.jsonl`.

Fix in `ef0c96e`:

- `Storage.findConversation()` now includes `agent`.
- `conversationIdForPk()` includes `agent`.
- SQLite conversations primary key now includes `agent`.
- Added storage migration
  `002_conversation_agent_identity.sql`.
- Added tests for same-label Claude/Codex separation in both bus and SQLite
  coverage.

Live DB verification after daemon restart:

```text
PRAGMA user_version = 2
PRIMARY KEY (project, agent, comm, account_label, chat_native_id, thread_native_id)
```

New Codex inbound after migration used a new Codex-specific conversation id:

```text
conv_5c38348a1fa695afeadf7d98
```

## Bootstrapper notes

The bootstrapper starts the app-server in a separate terminal window. If a user
runs the script directly in their current terminal with `-Exec`, Codex runs in
that terminal and only the app-server gets its own window.

Current supported flows:

```powershell
.\scripts\bootstrap-codex-session.ps1 -Exec
.\scripts\bootstrap-codex-session.ps1 -ThreadId $env:CODEX_THREAD_ID -Exec
.\scripts\bootstrap-codex-session.ps1 -RestartCurrent -SameTerminal -Exec
.\scripts\bootstrap-codex-session.ps1 -RestartCurrent -SameTerminal -PlanOnly -Json
```

The same-terminal restart path schedules a hidden restart baton, stops the
discovered Codex process, then types a tiny relay script into the original
terminal. The relay starts a fresh app-server and resumes Codex with the
matching remote URL.

The bootstrapper now persists app-server metadata under
`~/.agents-comm-bus/codex-bootstrapper/sessions/`. Same-terminal restart
relays pass `-StopPreviousAppServer` so repeated bootstrapper runs can replace
their own previous companion app-server. The larger plugin/runtime should still
track plugin-launched app-servers and terminate them when the Codex session
ends; the bootstrapper only owns app-servers it launched and recorded.

## Verification

Builds:

```powershell
cd agents-comm-bus-core
npm run build

cd ..\agents-comm-bus
npm run build

cd ..\mcp-server
npm run build
```

Tests run during the iteration:

```powershell
cd agents-comm-bus
npm test

node --test --import tsx `
  "../tests/architecture/bus-invariants.test.ts" `
  "../tests/architecture/sqlite-schema.test.ts" `
  "../tests/architecture/codex-agent-adapter.test.ts" `
  "../tests/architecture/codex-turn-control.test.ts"
```

Observed pass counts:

- default `agents-comm-bus npm test`: 10 passing
- focused architecture suite: 16 passing before the conversation-id split
- focused suite including conversation-id tests: passing after the split

Live daemon verification:

- daemon restarted after each rebuilt daemon change
- final migration run produced SQLite `user_version = 2`
- daemon session for Codex refreshed with the stable session id

## Remaining follow-ups

- Historical transcript files from before `ef0c96e` are not split
  retroactively. New records use the agent-scoped conversation id.
- `agents-comm-bus` still has old app-server / MCP processes from other
  sessions on this machine. They are valid long-running sessions, not stale
  state by default, but they complicate process inspection during tests.
- The bootstrapper owns restart-time cleanup for app-servers it launched and
  recorded. Plugin-level process tracking should still handle cleanup when a
  Codex session exits.
- Mid-turn steering is now functionally verified in this local setup, but it
  depends on the currently installed Codex app-server accepting `turn/steer`.
  Future Codex protocol changes should keep this covered in E2E.
- `.claude/agents/command-center-updater.md` is local/untracked and was not
  committed with this report.

## Files of interest

- `scripts/bootstrap-codex-session.ps1` - Codex app-server/session launcher.
- `install-codex.js` - path-only global MCP registration plus project-local
  Codex hook config.
- `mcp-server/server.js` - Codex runtime discovery and persistent session
  registration.
- `hooks/codex/user-prompt-submit.js` - daemon inbound drain/injection hook.
- `hooks/codex/permission-request.js` - daemon-backed permission query hook.
- `agents-comm-bus/src/adapters/agent/codex/{adapter,bridge}.ts` - Codex
  wake/steer, query, lease, and session handling.
- `agents-comm-bus/src/adapters/comm/telegram/factory.ts` - Telegram MCP
  send surface and session-scoped explicit target resolution.
- `agents-comm-bus/src/bus.ts` - session target selection and agent-scoped
  conversation identity.
- `agents-comm-bus/src/storage/schema/002_conversation_agent_identity.sql` -
  live DB migration for agent-scoped conversation identity.
