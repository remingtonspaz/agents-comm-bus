# agents-comm-bus Telegram Plugin

Bidirectional Telegram messaging for Claude Code and Codex through a shared
per-user `agents-comm-bus` daemon. Agent host plugins stay thin: they expose MCP
tools and hooks, while Telegram polling, account ownership, conversations,
queries, transcripts, and audit logs live under `~/.agents-comm-bus/`.

## Release Status

`universal-overhaul` is not marketplace-release ready until the production
install gate added in `0a20bf3` passes as a hard test. AGE-23 owns the packaging
work that makes staged marketplace artifacts self-contained. Until that lands,
source/dev mode can work, but fresh marketplace installs are expected to fail the
`production marketplace install (release gate)` tests.

Use [docs/architecture/release-readiness.md](docs/architecture/release-readiness.md)
as the checklist before publishing this branch as `main` or updating marketplace
repositories.

## What It Provides

- Send Telegram messages and attachments from Claude Code or Codex.
- Receive Telegram messages into the active agent session.
- Route permission and question prompts through Telegram inline buttons.
- Share one per-user daemon across multiple agents and Telegram bot accounts.
- Keep routing keyed by concrete bot IDs, not human labels.
- Persist state in SQLite plus JSONL transcript/audit files under
  `~/.agents-comm-bus/`.

## Requirements

- Node.js 22 or newer. The daemon uses `node:sqlite`.
- A Telegram bot token from [@BotFather](https://t.me/botfather).
- Your Telegram numeric user ID, if you want allowlist restrictions.
- One Telegram bot per registered agent/project account. Telegram rejects
  multiple `getUpdates` consumers for the same bot token.

## Marketplace Installation

The intended end-user path is marketplace installation, then explicit account
registration. The plugin should not require users to clone this repository or run
source install scripts.

### Claude Code

1. Add the marketplace.

   ```text
   /plugin marketplace add https://github.com/remingtonspaz/claude-code-telegram
   ```

2. Install the Telegram plugin.

   ```text
   /plugin install telegram-integration:telegram
   ```

3. Restart Claude Code so the MCP server and hooks are loaded.

4. Register the Telegram bot account from a terminal. The `agents-comm` command
   is installed by the daemon's central install at `~/.agents-comm-bus/bin` (it
   appears after the first session/hook runs). Add that directory to PATH once
   so the command resolves from any shell — no `npm install`/`npm link` needed:

   ```powershell
   [Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:USERPROFILE\.agents-comm-bus\bin", "User")
   ```

   Then register the account (open a new shell so PATH is refreshed):

   ```powershell
   agents-comm account-add `
     --project "<absolute project path>" `
     --agent claude `
     --account-label main `
     --bot-token "<telegram bot token>"
   ```

5. Message the bot once from Telegram so Telegram allows the bot to reply.

6. In Claude Code, check `/mcp` and confirm the `telegram` MCP server is
   connected.

### Codex

Install the Codex Telegram plugin through the Codex plugin flow for the staged
artifact, then register the account with `--agent codex`:

```powershell
agents-comm account-add `
  --project "<absolute project path>" `
  --agent codex `
  --account-label main `
  --bot-token "<telegram bot token>"
```

Codex session startup currently needs the project-local hook configuration that
points at the staged Codex MCP shim. Keep the global Codex MCP config path-only;
session URL, thread ID, and daemon session ID are discovered at runtime.

## Account Management

Account registration is explicit. The daemon stores the bot token in a
daemon-owned file and stores only a `credentials_ref` in SQLite.
Legacy `env:` registrations are migrated once to daemon-owned file refs when
the token is still available from the old env var or project-local Telegram
config. New registrations should use `--bot-token`.

Common commands:

```powershell
# List registrations.
agents-comm account-list

# Register a bot.
agents-comm account-add `
  --project "<absolute project path>" `
  --agent claude `
  --account-label main `
  --bot-token "<telegram bot token>"

# Rotate the token for the same bot, or intentionally replace the bot.
agents-comm account-update-token `
  --bot-id "<current bot id>" `
  --bot-token "<new telegram bot token>"

# Relabel a registered account.
agents-comm account-relabel `
  --bot-id "<bot id>" `
  --new-account-label "<new label>"

# Remove a registered account.
agents-comm account-remove `
  --bot-id "<bot id>"
```

Labels are display aliases. Side-effecting commands should prefer `--bot-id`;
label targeting is accepted only when it resolves to exactly one account.

## Allowlist

By default, Telegram authorization depends on the adapter configuration and
daemon records. Manage allowlist rows with:

```powershell
# Add a global Telegram sender allowlist row.
agents-comm allowlist add `
  --comm telegram `
  --user "<telegram user id>"

# Add a per-bot allowlist row.
agents-comm allowlist add `
  --comm telegram `
  --user "<telegram user id>" `
  --bot-id "<bot id>"

# Inspect rows.
agents-comm allowlist list `
  --comm telegram `
  --scope all
```

Per-bot allowlist selectors accept `--bot-id` or an unambiguous label selector.

## MCP Tools

The host MCP shims expose generic comm tools:

- `comm_send_message({ comm, message, target? })`
- `comm_send_attachment({ comm, path, caption?, target? })`
- `comm_check_messages({ comm? })`
- `list_conversations({ comm?, limit? })`

For Telegram, explicit targets use the nested shape:

```json
{
  "comm": "telegram",
  "target": {
    "account": "<bot id>",
    "chat_native_id": "<telegram chat id>",
    "thread_native_id": "<optional topic/thread id>"
  }
}
```

Omitting `target` lets the daemon use the session's most recent inbound
conversation when available. Flat `chat_id` and `message_thread_id` fields are
not accepted.

## Source Development

Source mode is for contributors, not the marketplace user path.

```powershell
npm install
npm --workspace packages/core-contracts run build
npm --workspace agents-comm-bus run build
npm --workspace mcp-server run build
npm run stage:plugins
```

Optional local CLI:

```powershell
cd agents-comm-bus
npm link
agents-comm account-list
```

For a source checkout, `.agents-comm-bus-dev.json` marks development mode so
hooks can resolve source-built artifacts instead of production central-install
artifacts. Do not document source paths as the marketplace install path.

## Known Caveats

- Marketplace production installs are blocked until AGE-23 makes staged daemon
  and hook runtime artifacts self-contained.
- Claude auto-wake currently depends on the Windows PowerShell watcher and
  console keystroke path.
- Claude `SessionStart` is unreliable on Windows due to an upstream Claude Code
  harness issue; the first prompt of a new Claude session may need a manual seed
  prompt.
- Codex `PermissionRequest` hooks can disable Codex auto-mode classification.
  The current workaround is to use local Codex permission handling when seamless
  auto-mode is more important than Telegram-routed permission prompts.
- First-run account setup is still terminal-based through `account-add`.

## State Paths

All durable state is per-user:

| Path | Purpose |
| --- | --- |
| `~/.agents-comm-bus/agents-comm-bus.db` | SQLite daemon state |
| `~/.agents-comm-bus/tokens/` | Daemon-owned Telegram token files |
| `~/.agents-comm-bus/chats/<conversation_id>/transcript.jsonl` | Per-conversation transcripts |
| `~/.agents-comm-bus/audit/<date>.jsonl` | Audit log |
| `~/.agents-comm-bus/port` | Production/default daemon IPC port discovery |
| `~/.agents-comm-bus/daemon.pid` | Production/default daemon process discovery |
| `~/.agents-comm-bus/claude-wake/` | Claude watcher trigger/response files |

State never lives under a plugin install directory, so it survives plugin
reinstalls and upgrades.
Source/dev checkouts can keep durable state shared while moving only runtime
discovery files (`port`, `daemon.pid`, `.spawn.lock`) into a gitignored
workspace folder such as `.agents-comm-bus-discovery/` via
`.agents-comm-bus-dev.json`.

## Troubleshooting

### MCP server missing or disconnected

Restart the host agent session. MCP servers are loaded at session start.

### Telegram messages are not received

Check the active discovery root's `daemon.pid` and `port` files, plus the daily
audit log under `~/.agents-comm-bus/audit/`. Production/default discovery uses
`~/.agents-comm-bus/`; source/dev checkouts may use `.agents-comm-bus-discovery/`.
A `409 Conflict` from Telegram means another process is polling the same bot
token.

### Sends use the wrong bot

Run `account-list` and confirm the target uses the concrete bot ID. Labels are
aliases and can be ambiguous across agents.

### Daemon code changed but behavior did not

Restart the daemon by stopping the PID in the active discovery root's
`daemon.pid` and deleting the stale `port` and `daemon.pid` files. The next hook
or MCP call will spawn a fresh daemon.

## License

MIT
