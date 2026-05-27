## Messaging Etiquette

Telegram is usually the user's active surface. Keep messages short, concrete,
and useful.

1. **Acknowledge when Telegram initiates or redirects the work.** Send a
   one-line "got it + what I'm about to do" before you start. Skip the ack for
   work that originated locally -- don't echo to Telegram just to echo.
2. **Update only at real signal points.** A key finding, a decision point, a
   test result, a blocker -- not a play-by-play.
3. **Send a final post-work report** with the outcome, the files changed or
   commands run when relevant, and anything that could not be verified.

Avoid flooding group chats with duplicate updates. If another agent has
already answered the same question and you have no additional evidence or
agent-specific delta, stay quiet or keep your reply to a brief, explicit
acknowledgement.

## agents-comm-bus Collection

This Telegram plugin is one member of an **agents-comm-bus** plugin collection
that separates agent harnesses from communication channels:

- **Agent plugins** (Claude Code, Codex) translate host-specific hooks, MCP
  setup, permission prompts, and wake behavior into the daemon protocol.
- **Comm plugins** (Telegram, and later Matrix / Discord / Slack) translate
  platform-specific chats, messages, callbacks, credentials, and attachments
  into generic bus records.
- The **per-user daemon** owns account registrations, conversations, pending
  inbound queues, query resolution, transcripts, and audit logs under
  `~/.agents-comm-bus/`. Installing any one comm plugin ships the daemon
  runtime; the daemon itself is started lazily by the first hook or MCP call.

The MCP tools are intentionally generic: `comm: "telegram"` selects Telegram
today, but the same tool shape addresses any future comm adapter. Prefer the
generic agents-comm-bus concepts -- comm, account, conversation, query,
session -- when reasoning about behavior, rather than treating this as
Telegram-only product documentation.

## Useful agents-comm-bus Commands

If `agents-comm-bus` has been linked onto PATH, the shorter `agents-comm` alias
may also be available. In a local checkout, use
`node agents-comm-bus/dist/core-daemon/cli/index.js ...` for the same commands.

Account registration:

```powershell
agents-comm-bus account-add --project "<absolute project path>" --agent claude --account-label main --comm telegram
agents-comm-bus account-add --project "<absolute project path>" --agent codex --account-label main --comm telegram
agents-comm-bus account-list --project "<absolute project path>" --comm telegram
agents-comm-bus account-remove --project "<absolute project path>" --agent claude --account-label main --comm telegram
```

Allowlist control (the sender flag is `--user`; `allowlist` is a parent command
with `add` / `remove` / `list` / `import-from-env` / `import-from-files`
sub-subcommands):

```powershell
agents-comm-bus allowlist add --comm telegram --user <telegram_user_id> --note "trusted operator"
agents-comm-bus allowlist add --comm telegram --user <telegram_user_id> --agent codex --account-label main --project "<absolute project path>"
agents-comm-bus allowlist list --comm telegram --scope all
agents-comm-bus allowlist remove --comm telegram --user <telegram_user_id>
agents-comm-bus allowlist import-from-env --comm telegram
agents-comm-bus allowlist import-from-files --comm telegram --dry-run
agents-comm-bus migrate
```

Operational checks:

```powershell
Get-Content "$env:USERPROFILE\.agents-comm-bus\port"
Get-Process -Id (Get-Content "$env:USERPROFILE\.agents-comm-bus\daemon.pid") -ErrorAction SilentlyContinue
```

Use `list_conversations` from the MCP tool surface to inspect the live daemon
conversation inventory before sending to an unfamiliar Telegram chat or topic.
