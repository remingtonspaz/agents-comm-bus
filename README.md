# agents-comm-bus Telegram Plugin

Bidirectional Telegram messaging through a per-user `agents-comm-bus` daemon.
Claude and Codex entrypoints remain plugin/MCP shims, but Telegram polling and
durable state now live in one daemon under `~/.agents-comm-bus/`.

## Phase 1 Architecture

- `agents-comm-bus` owns Telegram polling; MCP servers no longer start their own pollers.
- Structured state lives in SQLite at `~/.agents-comm-bus/agents-comm-bus.db`.
- Transcripts and audit logs are JSONL under `~/.agents-comm-bus/chats/` and `~/.agents-comm-bus/audit/`.
- Account registration is explicit with `agents-comm-bus account-add`; inbound routing resolves `(comm, bot_user_id)`.
- The MCP tool surface talks to the daemon over localhost WebSocket IPC and includes `list_conversations`.
- The daemon is started lazily by plugin/MCP shims through `ensureDaemon()`. No service install is required for Phase 1.

## Features

- **Send messages to Telegram** - Claude can send updates, progress, and results
- **Receive messages from Telegram** - Send commands to Claude remotely
- **Auto-enter** - Messages trigger Claude automatically (no manual Enter needed)
- **Remote permission control** - Approve/deny tool permissions via Telegram
- **Slash command forwarding** - Send `;commit` on Telegram to run `/commit` in Claude Code
- **Session-specific targeting** - Works correctly with multiple Claude windows

## Requirements

- Node.js 22+ (`node:sqlite` is required)
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- Your Telegram User ID

## Installation

### As a Plugin

1. Add the marketplace:
   ```
   /plugin marketplace add https://github.com/remingtonspaz/claude-code-telegram
   ```

2. Install the plugin:
   ```
   /plugin install telegram-integration:telegram
   ```

3. Run the installer from the plugin directory if your plugin manager did not build packages automatically:
   ```bash
   node install.js
   ```

4. Register a Telegram account explicitly (see Setup below)

5. Restart Claude Code

### From Source

1. Clone or download this repository into your project directory
2. Run the installer:
   ```bash
   node install.js
   ```
3. Configure your Telegram credentials (see Setup below)
4. Restart Claude Code

### Manual Installation

1. Clone or download this repository
2. Install and build dependencies:
   ```bash
   node install.js
   ```
3. Copy `.mcp.json.template` to `.mcp.json` and add your credentials
5. Configure hooks in `.claude/settings.local.json` (see Hooks Configuration below)
6. Restart Claude Code

## Setup

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 2. Get Your User ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. It will reply with your user ID (a number like `123456789`)

### 3. Register the Telegram Account

Phase 1 uses explicit account registrations. The daemon writes credentials by
reference and stores account ownership in SQLite.

```bash
TELEGRAM_BOT_TOKEN="your_bot_token_here" \
node agents-comm-bus/dist/core-daemon/cli/index.js account-add \
  --project "/path/to/project" \
  --agent claude \
  --account-label main
```

The registration refuses duplicate ownership for the same `(comm, bot_user_id)`.
For a transition release, legacy `.claude/telegram.json`, `.codex/telegram.json`,
`~/.claude-telegram/*`, and `~/.codex-telegram/*` files are readable only as
migration inputs. New writes go to `~/.agents-comm-bus/`.

### 4. Configure MCP Environment

Add the MCP server to your project's `.mcp.json` with your credentials:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/path/to/claude-code-telegram/hosts/claude/claude-mcp-shim.js"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "your_bot_token_here",
        "TELEGRAM_USER_ID": "your_user_id_here"
      }
    }
  }
}
```

Replace `/path/to/claude-code-telegram` with:
- **Source install:** The path where you cloned the repo (e.g., `./claude-code-telegram`)
- **Plugin install:** The plugin cache path (check `~/.claude/plugins/`)

Each project can have its own `.mcp.json` with different Telegram credentials.

### 5. Start Your Bot

Message your bot on Telegram to start the conversation. The bot can only message you if you've messaged it first.

### 6. Restart Claude Code

Restart Claude Code to load the MCP server and hooks.

### 7. Verify Installation

Run the status check to verify everything is configured:
```bash
node install.js --status
```

Or check `/mcp` in Claude Code to see if the telegram server is connected.

The MCP tools are:
- `comm_send_message({ comm, message, target? })`
- `comm_send_attachment({ comm, path, caption?, target? })`
- `comm_check_messages({ comm? })`
- `list_conversations({ comm?, limit? })`

For Telegram, explicit targets must use the nested `target` object shape
`{ chat_native_id, thread_native_id? }`. Omitting `target` lets the daemon use
the session's most recent inbound conversation when available; otherwise it
returns an explicit-target error. The shim no longer accepts flat
`chat_id`/`message_thread_id` fields.

## Hooks Configuration

The hooks should be configured automatically if you place this plugin in your project. If not, add the following to `.claude/settings.local.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node path/to/hosts/claude/hooks/user-prompt-submit.js"
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
            "command": "node path/to/hosts/claude/hooks/permission-request.js"
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
            "command": "node path/to/hosts/claude/hooks/session-start.js"
          }
        ]
      }
    ]
  }
}
```

## Usage

### Sending Messages

Claude can send messages to you using the MCP tools:

- `comm_send_message` - Send a text message
- `comm_send_attachment` - Send an image or other file
- `comm_check_messages` - Check for pending messages

### Receiving Messages

1. Send a message to your bot on Telegram
2. Claude receives it automatically on the next prompt
3. Messages appear in context as: `[Telegram Messages Received] ...`

### Auto-Enter Feature

When you send a Telegram message, the watcher script automatically:
1. Detects the incoming message
2. Focuses the Claude Code window
3. Sends a keystroke to trigger processing

No need to manually press Enter!

### Remote Permission Control

When Claude needs permission for a tool:

1. You receive a notification: `Permission Request - Tool: Bash`
2. Reply with:
   - `y` or `yes` - Allow once
   - `n` or `no` - Deny
   - `a` or `always` - Always allow
3. The watcher sends your response to Claude

### Slash Command Forwarding

Send Claude Code slash commands from Telegram using `;` as the prefix (since Telegram reserves `/` for bot commands):

1. Send `;commit` on Telegram
2. The bot confirms: "Forwarding /commit to Claude Code..."
3. The watcher types `/commit` + Enter into the terminal
4. Claude Code executes the command

**Notes:**
- Only single-word commands work: `;commit`, `;help`, `;mcp`
- Multi-word messages like `;foo bar` are treated as regular messages

## Project Structure

```
claude-code-telegram/
├── .claude-plugin/
│   └── plugin.json              # Plugin metadata
├── hosts/
│   ├── claude/
│   │   ├── claude-mcp-shim.js   # Claude MCP shim entrypoint
│   │   └── hooks/
│   │       ├── hooks.json       # Claude hook manifest
│   │       ├── permission-request.js
│   │       ├── session-start.js
│   │       ├── user-prompt-submit.js
│   │       └── wake-support.js
│   ├── codex/
│   │   ├── codex-mcp-shim.js    # Codex MCP shim entrypoint
│   │   └── hooks/
│   │       ├── permission-request.js
│   │       ├── session-start.js
│   │       └── user-prompt-submit.js
│   └── common/
│       └── mcp-shim-shared.js   # Shared MCP shim plumbing
├── skills/
│   └── telegram/
│       └── SKILL.md             # Claude skill instructions
├── scripts/
│   ├── enter-watcher.ps1        # Keystroke automation (main watcher)
│   ├── list-windows.ps1         # Helper to find Claude windows
│   ├── send-enter.ps1           # Helper to send keystrokes
│   └── post-install.js          # Post-install setup script
├── mcp-server/
│   ├── server.js                # MCP server with Telegram bot
│   └── package.json             # MCP server dependencies
├── .mcp.json.template           # Credential template
├── install.js                   # Installation script
├── package.json                 # Root package.json
└── README.md
```

## Components

| Component | Purpose |
|-----------|---------|
| agents-comm-bus daemon | Owns Telegram polling, SQLite state, transcripts, audit, and IPC |
| MCP Server | Thin IPC shim exposing tools to Claude/Codex |
| UserPromptSubmit Hook | Starts the daemon lazily and injects daemon-delivered context |
| PermissionRequest Hook | Routes query/permission work through daemon-backed records |
| SessionStart Hook | Auto-spawns the watcher on session start |
| Enter Watcher | PowerShell script for keystroke automation |
| Skill | Guides Claude on using the integration |

## Troubleshooting

### MCP server not connecting

1. Check `/mcp` in Claude Code
2. Verify `.mcp.json` exists with valid credentials
3. Ensure the daemon and MCP shim are built (`node install.js`)
4. Restart Claude Code

### Messages not being received

1. Run `list_conversations` to confirm daemon conversation inventory
2. Verify bot token is valid
3. Ensure you're messaging from the authorized user ID
4. Check `~/.agents-comm-bus/port` and `~/.agents-comm-bus/daemon.pid` for stale daemon discovery files

### Auto-enter not working

1. Check if watcher is running (look for PowerShell process)
2. Verify Claude Code is in a cmd.exe window
3. Try restarting Claude Code session

### Permission notifications not appearing

1. Ensure PermissionRequest hook is configured in `.claude/settings.local.json`
2. Check that the tool isn't already in the allow list
3. Verify Telegram bot is connected

### Check installation status

Run the diagnostic command:
```bash
node install.js --status
```

## Configuration Files

| File | Purpose |
|------|---------|
| `.mcp.json` | MCP server config with credentials (gitignored) |
| `.mcp.json.template` | Template for credentials |
| `~/.agents-comm-bus/agents-comm-bus.db` | SQLite structured daemon state |
| `~/.agents-comm-bus/chats/*/transcript.jsonl` | Conversation transcripts |
| `~/.agents-comm-bus/audit/*.jsonl` | Daily audit logs |
| `~/.agents-comm-bus/port` | Daemon IPC discovery port |
| `~/.agents-comm-bus/daemon.pid` | Daemon process discovery |

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.
