# Claude + Telegram End-to-End Test Guide

This guide validates the `universal-overhaul` Claude + Telegram path after
Phase 2: daemon bootstrap, explicit Telegram registration, MCP shim tools,
Claude hook delivery, and daemon-backed query records.

## Prerequisites

- Node.js 22+
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

## 2. Register Telegram Account

Use the same project path you will open Claude from.

```powershell
$env:TELEGRAM_BOT_TOKEN="123456:your-token"

node agents-comm-bus\dist\cli\index.js account-add `
  --project "D:\Documents\claude-code-telegram-universal-overhaul" `
  --agent claude `
  --account-label main
```

Verify:

```powershell
node agents-comm-bus\dist\cli\index.js account-list --agent claude --comm telegram
```

## 3. Configure Claude MCP

In the project `.mcp.json`, point Claude at the built MCP shim:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": [
        "D:\\Documents\\claude-code-telegram-universal-overhaul\\mcp-server\\dist\\server.js"
      ],
      "env": {
        "TELEGRAM_BOT_TOKEN": "123456:your-token",
        "TELEGRAM_USER_ID": "your-telegram-user-id"
      }
    }
  }
}
```

## 4. Configure Claude Hooks

If not installed as a plugin, add or update `.claude/settings.local.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node D:\\Documents\\claude-code-telegram-universal-overhaul\\hooks\\claude\\user-prompt-submit.js"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node D:\\Documents\\claude-code-telegram-universal-overhaul\\hooks\\claude\\permission-request.js"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node D:\\Documents\\claude-code-telegram-universal-overhaul\\hooks\\session-start.js"
          }
        ]
      }
    ]
  }
}
```

## 5. Start Telegram Chat

In Telegram:

1. Open your bot.
2. Send `/start`.
3. Send `hello from telegram`.

## 6. Start Claude

Open Claude from the same project directory:

```powershell
cd D:\Documents\claude-code-telegram-universal-overhaul
claude
```

In Claude:

- Check `/mcp`.
- Confirm `telegram` is connected.

## 7. Test Inbound Telegram To Claude

In Telegram, send:

```text
hello from telegram e2e test
```

Then in Claude submit any prompt, for example:

```text
Check whether there are Telegram messages and summarize them.
```

Expected:

- Claude receives injected context from daemon-delivered inbound messages.
- No legacy `~/.claude-telegram/queue.json` should be required.

## 8. Test Claude To Telegram

In Claude, use the MCP tool or ask:

```text
Send "hello from Claude e2e test" to Telegram using comm_send_message with comm "telegram".
```

If there is no recent inbound session target, pass an explicit nested
`target` object like `{ chat_native_id: "...", thread_native_id: "..." }` or
ask Claude to use one. The shim no longer accepts flat `chat_id` /
`message_thread_id` fields. You can find conversations with:

```text
List Telegram conversations using list_conversations.
```

Expected:

- Message arrives in Telegram.
- Conversation inventory is visible through `list_conversations`.

## 9. Test Permission Query Path

Ask Claude to do something that triggers permission, for example:

```text
Run: echo phase2-permission-test
```

Expected:

- Claude permission flow goes through daemon-backed `Query` records.
- If Telegram reply routing is available from a recent inbound conversation,
  the prompt should be sent there.
- Reply `y`, `n`, or `a` in Telegram.

## 10. Inspect Daemon State

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

## Reset For A Clean Test

Stop Claude, then remove daemon discovery files if needed:

```powershell
Remove-Item "$env:USERPROFILE\.agents-comm-bus\port" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.agents-comm-bus\daemon.pid" -Force -ErrorAction SilentlyContinue
```

Only delete the DB for a full reset:

```powershell
Remove-Item "$env:USERPROFILE\.agents-comm-bus\agents-comm-bus.db*" -Force
```

Then rerun account registration.
