# Codex Telegram Plugin

Bidirectional Telegram messaging for OpenAI Codex CLI and desktop, with remote permission control.

> **Branch status:** This `codex` branch is an in-progress port of the original Claude Code plugin to OpenAI Codex. The working Claude Code version lives on `main`. The repo URL still says "claude-code-telegram" — that's history.

## Features

- **Send messages to Telegram** — Codex can send updates, progress, and results
- **Receive messages from Telegram** — Send commands remotely; the Telegram message starts a fresh turn in your active Codex thread (no manual Enter)
- **Cross-surface** — Works with both Codex CLI and the Codex desktop app (both share `~/.codex/config.toml`)
- **Remote permission control** — Approve/deny tool permissions via Telegram using a blocking `PermissionRequest` hook
- **Numbered selection** for AskUserQuestion / plan-mode prompts
- **No keystroke injection, no watcher process** — replaced by Codex's app-server JSON-RPC and hook-based decisions

## Architecture differences vs the Claude Code version

The Codex port replaces several Windows-specific hacks with Codex-native interfaces:

| Concern | Claude Code version | Codex version |
|---------|---------------------|---------------|
| Permission decision | Watcher injects keystrokes into terminal | `PermissionRequest` hook returns blocking `{decision:{behavior:"allow"\|"deny"}}` |
| Wake idle agent | PostMessage WM_CHAR into the cmd.exe console | `turn/start` JSON-RPC over the app-server control socket |
| Find the right session | `findCmdAncestor` walks the Windows process tree | `thread/loaded/list` JSON-RPC — threads are addressable by ID |
| Platform support | Windows only | Same code on macOS, Linux, Windows |

## Requirements

- Codex CLI 0.124+ (or Codex desktop — both share `~/.codex/`)
- Node.js 18+
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- Your Telegram User ID

## Installation

> Codex plugin manifests cannot currently auto-declare MCP servers and there is no `${CODEX_PLUGIN_ROOT}` path-substitution macro. `mcp_servers` and `hooks` must live in `~/.codex/config.toml` with absolute paths. The installer below writes those entries for you, or you can paste the snippet manually — see [Manual setup](#manual-setup) at the bottom.

### 1. Clone the repo

```bash
git clone -b codex https://github.com/remingtonspaz/claude-code-telegram.git
cd claude-code-telegram
```

### 2. Build the MCP server bundle

```bash
cd mcp-server && npm install && npm run build
cd ..
```

### 3. Set Telegram credentials

Either drop a `<project>/.codex/telegram.json` in any project where you want the bot active:

```json
{
  "botToken": "YOUR_BOT_TOKEN",
  "userId": "YOUR_USER_ID"
}
```

…or set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID` as environment variables.

### 4. Wire it into Codex

```bash
node install-codex.js
```

This appends absolute-path entries for the MCP server and hooks into `~/.codex/config.toml`. Re-run any time the repo path changes.

> See [Manual setup](#manual-setup) below if you'd rather paste the TOML by hand.

### 5. Restart Codex

Restart the Codex CLI or desktop app to pick up the new config.

### 6. Verify

In a Codex session, run `/mcp` (or `codex mcp list`) — `telegram` should appear. Send a test message to your bot on Telegram; the next time you start a turn, you should see the message in context.

## Setup helpers

### Create a Telegram Bot

1. Message [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### Get your User ID

1. Message [@userinfobot](https://t.me/userinfobot)
2. It replies with your numeric user ID

### Start the conversation

Message your bot first — bots can't DM you until you've messaged them.

## Usage

### Sending messages from Codex

Codex calls these MCP tools:

| Tool | Description |
|------|-------------|
| `telegram_send` | Send a text message |
| `telegram_send_image` | Send an image file |
| `telegram_check_messages` | Check for pending messages |

### Receiving messages on Telegram

1. Send a message to your bot
2. The MCP server queues the message and triggers `turn/start` against your active thread via the local app-server control socket
3. Codex picks up the message as a new user turn — **no manual Enter, no terminal focus needed**

### Remote permission control

When Codex requests permission for a tool:

1. The `PermissionRequest` hook fires, sends the request to Telegram, and **blocks** waiting for a reply
2. Reply on Telegram:
   - `y` / `yes` — allow once
   - `n` / `no` — deny
   - `a` / `always` — allow this combination going forward
3. The hook returns the matching `{behavior:"allow"|"deny"}` and Codex continues

No watcher process, no keystrokes — the decision flows through Codex's hook system.

### AskUserQuestion / plan-mode

Numbered options surface in Telegram. Reply with the number; the response goes back through the same hook channel.

## Project structure

```
claude-code-telegram/
├── .codex-plugin/
│   └── plugin.json              # Codex plugin manifest
├── hooks/codex/
│   ├── user-prompt-submit.js    # Inject pending Telegram messages
│   └── permission-request.js    # Blocking permission decisions via Telegram
├── mcp-server/
│   ├── server.js                # MCP server source (Telegram bot, agent-aware)
│   └── dist/server.js           # Bundled (esbuild) — what Codex runs
├── install-codex.js             # Writes [mcp_servers.telegram] to ~/.codex/config.toml
└── README.md
```

The Claude Code surface from `main` (`.claude-plugin/`, `hooks/telegram-context.js`, `hooks/permission-telegram.cjs`, `scripts/enter-watcher.ps1`) is still present on this branch and is **not used** by the Codex port. The two ecosystems share the *same* MCP server bundle — agent identity is selected at spawn time via `--agent=codex` (see [Agent identity and channel split](#agent-identity-and-channel-split)). The Claude surface will be removed once Codex parity is reached.

## Agent identity and channel split

The MCP server bundle serves both Claude Code and Codex. To keep them from racing on shared session state when both run in the *same project directory*, the server picks its identity at spawn time:

| Spawn | Agent | Session dir | Credential preference |
|-------|-------|-------------|------------------------|
| Codex (via `install-codex.js`) | `codex` | `~/.codex-telegram/<basename>-<hash>/` | `<project>/.codex/telegram.json` first, then `.claude/telegram.json` |
| Claude Code (no flag) | `claude` (default) | `~/.claude-telegram/<basename>-<hash>/` | `<project>/.claude/telegram.json` first, then `.codex/telegram.json` |

The flag is passed in `args` — `install-codex.js` writes `args = ["<...>/server.js", "--agent=codex"]`. Equivalently, set `TELEGRAM_AGENT=codex` in the environment.

The Codex hooks (`hooks/codex/*.js`) always read/write `~/.codex-telegram/`, so they pair correctly with the agent-flagged MCP server. A simultaneous Claude Code session in the same project keeps reading/writing `~/.claude-telegram/` through the Claude hooks.

**Per-bot tokens:** if you want each agent to use a different Telegram bot account (recommended — Telegram allows only one polling consumer per bot token), put codex creds in `<project>/.codex/telegram.json` and claude creds in `<project>/.claude/telegram.json`. Each agent's MCP server will pick up its own.

## Manual setup

If you don't want to run `install-codex.js`, append this to `~/.codex/config.toml`, replacing `<ABSOLUTE_REPO_PATH>` with the absolute path to your clone:

```toml
[mcp_servers.telegram]
command = "node"
args = ["<ABSOLUTE_REPO_PATH>/mcp-server/dist/server.js", "--agent=codex"]

[features]
codex_hooks = true

[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node <ABSOLUTE_REPO_PATH>/hooks/codex/user-prompt-submit.js"

[[hooks.PermissionRequest]]
matcher = "*"

[[hooks.PermissionRequest.hooks]]
type = "command"
command = "node <ABSOLUTE_REPO_PATH>/hooks/codex/permission-request.js"
```

> The `--agent=codex` flag is what tells the MCP server to use `~/.codex-telegram/` (instead of the default `~/.claude-telegram/`). Without it, a Codex session in the same project as a Claude session will race on shared state. See [Agent identity and channel split](#agent-identity-and-channel-split).

Then restart Codex.

## Troubleshooting

### MCP server not connecting

- `codex mcp list` should show `telegram`
- Verify the path in `~/.codex/config.toml` resolves (`mcp_servers.telegram.args[0]`)
- Confirm `mcp-server/dist/server.js` exists (run `npm run build` in `mcp-server/`)

### Telegram messages don't trigger a turn

- Confirm a Codex CLI or desktop session is running — without one, there's no app-server control socket to call into
- Check `~/.codex/app-server-control/app-server-control.sock` exists while Codex is running
- Verify `thread/loaded/list` returns at least one thread (the MCP server tries this on each incoming message)

### Permission notifications don't appear

- Ensure `[features] codex_hooks = true` is set
- Verify the `PermissionRequest` hook entry in `~/.codex/config.toml` points to a path that exists
- Check the hook's stderr output (Codex surfaces it in the TUI status bar)

### Bot doesn't reply

- Make sure you've messaged the bot first (Telegram rule: bots can't DM you until you DM them)
- Verify `botToken` and `userId` are correct in `<project>/.codex/telegram.json` or environment variables

## Configuration files

| File | Purpose |
|------|---------|
| `~/.codex/config.toml` | mcp_servers + hooks entries (absolute paths) |
| `<project>/.codex/telegram.json` | Per-project Telegram credentials (preferred) |
| `~/.codex/app-server-control/app-server-control.sock` | Local control socket the MCP server connects to (created by Codex at runtime) |
| `mcp-server/dist/server.js` | Bundled MCP server (built via `npm run build`) |
| `~/.claude-telegram/<project>-<hash>/` | Per-session message queue and pending state |

## License

MIT

## Contributing

Contributions welcome — open an issue or PR. If you're working on the port itself, see `CLAUDE.md` for development notes (Claude Code conventions, since the dev environment for this branch is still Claude Code).
