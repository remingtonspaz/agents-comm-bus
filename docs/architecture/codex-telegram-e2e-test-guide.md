# Codex + Telegram End-to-End Test Guide

This guide validates the `universal-overhaul` Codex + Telegram path after
Phase 3: daemon bootstrap, explicit Telegram registration, MCP shim tools,
Codex hook delivery, Codex app-server wake/steer, and daemon-backed query
records.

The current implementation is daemon-backed. It must not depend on
`~/.codex-telegram/queue.json`, `pending-permission.json`, or
`permission-response.json`.

## Prerequisites

- Node.js 22+
- Codex CLI with hook support and app-server support
- A Telegram bot token from BotFather
- Your Telegram user ID
- Current branch: `universal-overhaul`
- Repo path used below:

```powershell
D:\Documents\claude-code-telegram-universal-overhaul
```

Adjust paths if your checkout lives elsewhere.

## 1. Build From Repo Root

```powershell
cd D:\Documents\claude-code-telegram-universal-overhaul

cd agents-comm-bus-core
npm install
npm run build

cd ..\agents-comm-bus
npm install
npm run build

cd ..\mcp-server
npm install
npm run build

cd ..
```

## 2. Register Telegram Account For Codex

Use the same project path you will open Codex from.

```powershell
$env:TELEGRAM_BOT_TOKEN="123456:your-token"

node agents-comm-bus\dist\cli\index.js account-add `
  --project "D:\Documents\claude-code-telegram-universal-overhaul" `
  --agent codex `
  --account-label main
```

Verify:

```powershell
node agents-comm-bus\dist\cli\index.js account-list --agent codex --comm telegram
```

Expected:

- One `telegram` account registration exists for `agent=codex`.
- The daemon state root is still `~/.agents-comm-bus/`, not
  `~/.codex-telegram/`.

## 3. Configure Codex MCP

Recommended:

```powershell
node install-codex.js --force
```

This writes or replaces the `[mcp_servers.telegram]` block in
`~/.codex/config.toml` with the built shared MCP shim. The global MCP entry is
path-only; session-specific app-server state is supplied by the bootstrapper
environment when Codex starts. It also installs project-local Codex hook
commands into `.codex/config.toml` for the current project.

Manual equivalent:

```toml
[mcp_servers.telegram]
command = "node"
args = ["D:\\Documents\\claude-code-telegram-universal-overhaul\\mcp-server\\dist\\server.js"]
```

## 4. Verify Codex Hooks

`install-codex.js` writes the hook block to the project-local
`.codex/config.toml`:

```toml
[features]
hooks = true

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node D:\\Documents\\claude-code-telegram-universal-overhaul\\hooks\\codex\\user-prompt-submit.js"

[[hooks.PermissionRequest]]
matcher = "*"

[[hooks.PermissionRequest.hooks]]
type = "command"
command = "node D:\\Documents\\claude-code-telegram-universal-overhaul\\hooks\\codex\\permission-request.js"
```

Expected:

- `UserPromptSubmit` calls `codex_register_session`, then
  `codex_drain_inbound`.
- `PermissionRequest` calls `codex_register_session`, then blocks on
  `codex_open_query`.
- Neither hook reads or writes legacy `~/.codex-telegram/*` runtime files.

## 5. Start Telegram Chat

In Telegram:

1. Open your bot.
2. Send `/start`.
3. Send `hello from telegram to codex`.

## 6. Start Codex App Server And Codex

Use the bootstrapper from the same project directory. It starts a separate
Codex app-server window, reports the app-server PID, and runs Codex with the
matching `CODEX_APP_SERVER_URL` and daemon session id.

Fresh session:

```powershell
cd D:\Documents\claude-code-telegram-universal-overhaul
.\scripts\bootstrap-codex-session.ps1 -Exec
```

Resume an existing thread:

```powershell
cd D:\Documents\claude-code-telegram-universal-overhaul
.\scripts\bootstrap-codex-session.ps1 `
  -ThreadId "019e2dc2-afb1-7171-8f55-bc5cacb03370" `
  -Exec
```

To allocate a known port or replace an old Codex process:

```powershell
.\scripts\bootstrap-codex-session.ps1 -Port 4501 -KillPid 12345 -Exec
```

In Codex:

- Check `/mcp` or run `codex mcp list` in a separate shell.
- Confirm `telegram` is connected.

## 7. Test Inbound Telegram To Codex On Prompt Submit

In Telegram, send:

```text
hello from telegram codex e2e test
```

Then in Codex submit any prompt, for example:

```text
Check whether there are Telegram messages and summarize them.
```

Expected:

- Codex receives injected context from daemon-delivered inbound messages.
- The message text is wrapped in a `[Daemon Inbound Messages]` block.
- No legacy `~/.codex-telegram/queue.json` is required.
- `sessions.agent` for the active session is `codex`.

## 8. Test Codex To Telegram

In Codex, ask:

```text
Send "hello from Codex e2e test" to Telegram using telegram_send.
```

If there is no recent inbound session target, pass an explicit `chat_id` or ask
Codex to list conversations first:

```text
List Telegram conversations using list_conversations.
```

Expected:

- Message arrives in Telegram.
- Conversation inventory is visible through `list_conversations`.
- Outbound transcript is appended under `~/.agents-comm-bus/chats/*`.

## 9. Test Telegram To Codex Auto-Wake

Keep the Codex app-server and remote Codex session running. In Telegram, send:

```text
wake codex from telegram
```

Expected:

- The daemon stores the inbound message before wake.
- `CodexBridge` calls the Codex app-server `turn/start` path.
- Codex starts a new turn or otherwise surfaces the Telegram message without
  manual terminal keystroke injection.

If Codex is already mid-turn, record whether `turn/start` is rejected. The
Phase 3 adapter exposes `midTurnPolicy = "steer"` and has `turn/steer` support,
but live behavior depends on the current Codex app-server protocol.

## 10. Test Permission Query Path

Ask Codex to do something that triggers a permission request, for example:

```text
Run: echo codex-permission-test
```

Expected:

- The Codex `PermissionRequest` hook opens a daemon-backed `Query`.
- The permission prompt is sent to the most recent Telegram conversation for
  the Codex session.
- Telegram shows inline buttons and also accepts text replies:
  - `y` or `yes` means allow
  - `n` or `no` means deny
  - `a` or `always` maps to allow once in Codex, because the Codex hook output
    currently supports allow/deny behavior.
- Codex continues or fails closed based on the Telegram response.

Record:

- Whether button taps resolve the query.
- Whether text replies resolve the query.
- Whether timeout fails closed with a deny decision.

## 11. Test Mid-Turn Steering If Available

Start a longer Codex task, then send a Telegram message while it is running:

```text
add this guidance while codex is working
```

Expected target behavior:

- The Codex adapter can call app-server `turn/steer`.
- If the current Codex app-server rejects steering, record the exact error and
  confirm the message remains durable in daemon state or is picked up on the
  next prompt submit.

This step is explicitly observational. Do not mark Phase 3 live steering as
fully verified unless Codex accepts `turn/steer` in the running version.

## 12. Inspect Daemon State

State root:

```powershell
dir $env:USERPROFILE\.agents-comm-bus
```

Useful files:

- `agents-comm-bus.db`
- `port`
- `daemon.pid`
- `audit\*.jsonl`
- `chats\*\transcript.jsonl`

Useful checks:

```powershell
Get-Content "$env:USERPROFILE\.agents-comm-bus\port"
Get-Process -Id (Get-Content "$env:USERPROFILE\.agents-comm-bus\daemon.pid") -ErrorAction SilentlyContinue

Get-Content "$env:USERPROFILE\.agents-comm-bus\audit\$(Get-Date -Format yyyy-MM-dd).jsonl" |
  Where-Object { $_ -notmatch 'connection_state' } |
  Select-Object -Last 30
```

Expected:

- Inbound and outbound events use the shared daemon.
- Query events have `agent=codex`.
- No active runtime state is written under `~/.codex-telegram`.

## Reset For A Clean Test

Stop Codex and the app-server. Then remove daemon discovery files if needed:

```powershell
Remove-Item "$env:USERPROFILE\.agents-comm-bus\port" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.agents-comm-bus\daemon.pid" -Force -ErrorAction SilentlyContinue
```

Only delete the DB for a full reset:

```powershell
Remove-Item "$env:USERPROFILE\.agents-comm-bus\agents-comm-bus.db*" -Force
```

Then rerun account registration for `--agent codex`.

## E2E Result Template

Use this checklist when writing the test report:

- Build completed:
- Account registration for `agent=codex` completed:
- MCP `telegram` visible in Codex:
- Hooks enabled and firing:
- Telegram inbound injected on prompt submit:
- Codex outbound `telegram_send` delivered:
- Telegram inbound auto-wake via `turn/start`:
- Permission query opened and sent to Telegram:
- Permission resolved by button:
- Permission resolved by text reply:
- Timeout fail-closed behavior observed:
- Mid-turn `turn/steer` behavior:
- No `~/.codex-telegram` runtime dependency observed:
- Audit/transcript artifacts checked:
- Bugs or follow-ups:
