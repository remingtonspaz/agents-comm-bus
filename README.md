# agents-comm-bus

Bidirectional messaging for Claude Code, Codex, and Pi through a shared
per-user `agents-comm-bus` daemon. Agent host plugins stay thin: they expose
tools and lifecycle hooks, while comm polling, account ownership, conversations,
queries, transcripts, and audit logs live under `~/.agents-comm-bus/`.
Supports Telegram, Discord, Matrix, and local curl ingress.

## What It Provides

- Send messages and attachments from Claude Code, Codex, or Pi.
- Receive messages into the active agent session from Telegram, Discord, Matrix,
  or local curl ingress.
- Route permission and question prompts through comm inline buttons (Claude/Codex).
- Share one per-user daemon across multiple agents and bot accounts.
- Keep routing keyed by concrete bot IDs, not human labels.
- Persist state in SQLite plus JSONL transcript/audit files under
  `~/.agents-comm-bus/`.

## Requirements

- Node.js 22 or newer. The daemon uses `node:sqlite`.
- A bot token for your chosen comm (e.g. Telegram from
  [@BotFather](https://t.me/botfather), Discord application token, Matrix
  access token).
- Your platform user ID, if you want allowlist restrictions.
- One bot per registered agent/project account. Platforms reject multiple
  consumers for the same token.

## Installation

**Quick install (Windows PowerShell):**

```powershell
irm https://raw.githubusercontent.com/remingtonspaz/agents-comm-bus/main/scripts/install.ps1 | iex
```

The installer detects installed coding agents, lets you pick which comms to
install, and runs the appropriate plugin install commands for each agent.
Account registration (bot token, allowlist) is a separate manual step via the
daemon CLI — see [Account Management](#account-management).

---

The intended end-user path is marketplace installation, then explicit account
registration. The plugin should not require users to clone this repository or run
source install scripts.

Jump to your agent: [Claude Code](#claude-code) · [Codex](#codex) · [Pi](#pi)

### Claude Code

1. Add the marketplace.

   ```text
   /plugin marketplace add https://github.com/remingtonspaz/agents-comm-bus-claude
   ```

2. Install the comm plugin(s) you want. Each comm is its own plugin under the
   `agents-comm-bus-claude` marketplace; installing any one ships the shared
   per-user daemon runtime.

   ```text
   /plugin install agents-comm-bus-telegram@agents-comm-bus-claude
   /plugin install agents-comm-bus-discord@agents-comm-bus-claude
   /plugin install agents-comm-bus-matrix@agents-comm-bus-claude
   /plugin install agents-comm-bus-curl@agents-comm-bus-claude
   ```

3. Restart Claude Code so the MCP server and hooks are loaded.

4. Register the bot account from a terminal. The `agents-comm` command is
   installed by the daemon's central install at `~/.agents-comm-bus/bin` (it
   appears after the first session/hook runs). Add that directory to PATH once
   so the command resolves from any shell — no `npm install`/`npm link` needed:

   ```powershell
   [Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:USERPROFILE\.agents-comm-bus\bin", "User")
   ```

   Then register the account (open a new shell so PATH is refreshed). Set `--comm`
   to the channel you installed:

   ```powershell
   agents-comm account-add `
     --project "<absolute project path>" `
     --agent claude `
     --account-label main `
     --comm telegram `
     --bot-token "<bot token>"
   ```

   See [Account Management](#account-management) for token rotation, relabel, and
   removal.

5. Hand the bot a first message so the channel allows it to reply (message the bot
   on Telegram / Discord / Matrix). The curl comm is local inbound-only — POST to
   its loopback endpoint instead.

6. In Claude Code, check `/mcp` and confirm the comm's MCP server is connected.

### Codex

1. Add the marketplace.

   ```text
   /plugin marketplace add https://github.com/remingtonspaz/agents-comm-bus-codex
   ```

2. Install the comm plugin(s) you want. Each comm is its own plugin under the
   `agents-comm-bus-codex` marketplace; installing any one ships the shared
   per-user daemon runtime.

   ```text
   /plugin install agents-comm-bus-telegram@agents-comm-bus-codex
   /plugin install agents-comm-bus-discord@agents-comm-bus-codex
   /plugin install agents-comm-bus-matrix@agents-comm-bus-codex
   /plugin install agents-comm-bus-curl@agents-comm-bus-codex
   ```

3. Restart Codex so the MCP server and hooks are loaded.

4. Register the bot account from a terminal. The `agents-comm` command is
   installed by the daemon's central install at `~/.agents-comm-bus/bin` (it
   appears after the first session/hook runs). Add that directory to PATH once
   so the command resolves from any shell:

   ```powershell
   [Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:USERPROFILE\.agents-comm-bus\bin", "User")
   ```

   Then register the account (open a new shell so PATH is refreshed). Set `--comm`
   to the channel you installed:

   ```powershell
   agents-comm account-add `
     --project "<absolute project path>" `
     --agent codex `
     --account-label main `
     --comm telegram `
     --bot-token "<bot token>"
   ```

   See [Account Management](#account-management) for token rotation, relabel, and
   removal.

5. Hand the bot a first message so the channel allows it to reply (message the bot
   on Telegram / Discord / Matrix). The curl comm is local inbound-only - POST to
   its loopback endpoint instead.

For marketplace/plugin installs, the Codex plugins ship their MCP and hook
configuration with the plugin. Restart Codex after install so the MCP server and
hooks load; session URL, thread ID, and daemon session ID are discovered at
runtime.

### Pi

1. Install the comm package(s) you want. Each comm is its own Pi package that
   bundles the shared `@agents-comm-bus/pi-core` extension (comm-generic tools +
   lifecycle + poller). Installing one brings the daemon runtime via the
   `agents-comm-bus` dependency.

   ```bash
   pi install git:github.com/remingtonspaz/agents-comm-bus-pi-telegram
   pi install git:github.com/remingtonspaz/agents-comm-bus-pi-discord
   pi install git:github.com/remingtonspaz/agents-comm-bus-pi-matrix
   pi install git:github.com/remingtonspaz/agents-comm-bus-pi-curl
   ```

2. Restart Pi so the extension is loaded.

3. Register the bot account from a terminal. The `agents-comm` command is
   installed by the daemon's central install at `~/.agents-comm-bus/bin` (it
   appears after the first session runs). Add that directory to PATH once
   so the command resolves from any shell:

   ```powershell
   [Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:USERPROFILE\.agents-comm-bus\bin", "User")
   ```

   Then register the account (open a new shell so PATH is refreshed). Set `--comm`
   to the channel you installed:

   ```powershell
   agents-comm account-add `
     --project "<absolute project path>" `
     --agent pi `
     --account-label main `
     --comm telegram `
     --bot-token "<bot token>"
   ```

   See [Account Management](#account-management) for token rotation, relabel, and
   removal.

4. Allowlist the sender so the bot accepts their messages:

   ```powershell
   agents-comm allowlist add --comm telegram --user <your_telegram_id> --bot-id <bot_id>
   ```

5. Hand the bot a first message so the channel allows it to reply (message the bot
   on Telegram / Discord / Matrix). The curl comm is local inbound-only - POST to
   its loopback endpoint instead.

Pi uses a per-comm package model: each `pi-<comm>` package bundles `pi-core`
(comm-generic tools + lifecycle + poller) via `bundledDependencies`. The core
holds the four `comm_send_message` / `comm_send_attachment` /
`comm_check_messages` / `list_conversations` tools; the per-comm package
contributes its adapter bundle + install-stamp + skill. Installing multiple
comms is additive — each brings its own adapter + skill, all sharing the same
comm-generic tool surface.

## Account Management

Account registration is explicit. The daemon stores the bot token in a
daemon-owned file and stores only a `credentials_ref` in SQLite.
Legacy `env:` registrations are migrated once to daemon-owned file refs when
the token is still available from the old env var or project-local Telegram
config. New registrations should use `--bot-token`.

### Useful Agent Prompts

The Claude Code, Codex, and Pi plugins include skills that describe the
`agents-comm` CLI, so once the plugin is installed your agent should be equipped
to help with account setup and maintenance. Useful prompts include:

- "Add a Discord account for Claude with the bot token aabbcc for the project
  xyz."
- "Add a Discord account for Claude for the project xyz. I have the token -
  tell me which file to put it in after you've made the entry."
- "Here's a Telegram token for you: aabbcc."
- "Add allowlists for the Claude and Codex bots in project xyz so they can talk
  to each other."
- "Remove the Telegram bot for Codex in xyz."
- "Tell me where the token records for Claude in xyz are located."

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
