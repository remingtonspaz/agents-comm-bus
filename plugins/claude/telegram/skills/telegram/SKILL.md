---
name: telegram-integration
description: Use when Claude Code is connected to Telegram through agents-comm-bus -- especially when the user sends work requests, approvals, status checks, or follow-up instructions from Telegram, when you need to send a Telegram update, or when you inspect Telegram conversation state. A bare "." prompt usually means a Telegram message auto-woke the session.
skillName: telegram-integration
metadata:
  hermes:
    tags: [telegram, claude-code, mcp, messaging]
    related_skills: []
---

# Telegram Integration for Claude Code

## When To Use

Use this skill whenever a Telegram message reaches the Claude Code session,
when the user asks you to send a Telegram update, or when you need to inspect
Telegram conversation state through agents-comm-bus. The Telegram chat is part
of the active collaboration channel, not an external notification sink.

When a message arrives from Telegram, **reply on Telegram** as part of the
normal response loop -- do not assume the user is watching the local terminal.
If the visible prompt is only a bare `.`, treat it as an auto-wake: read the
injected `[Daemon Inbound Messages]` block in your context for the real
Telegram message before acting.

## Claude Code Behavior

Claude Code receives Telegram inbound as hook-injected prompt context (the
`[Daemon Inbound Messages]` block prepended by the UserPromptSubmit hook).
Treat those injected messages as current user instructions unless they are
clearly stale or superseded by a newer local prompt.

Outbound goes back over the same channel with `comm_send_message`
(`comm: "telegram"`) -- a local-only response is invisible to a user who is
watching from their phone. The wake mechanism is a `.` keystroke typed into the
session's terminal by the watcher; you never trigger it yourself, you just
respond to what the inbound block contains.

## Essential Telegram Tools

- `list_conversations` -- inspect known conversations and get exact chat or
  thread targets before sending to a non-current chat.
- `comm_send_message` -- send concise status, questions, and final reports with
  `comm: "telegram"`.
- `comm_check_messages` -- drain pending inbound when you suspect new Telegram
  context has arrived but has not yet appeared in the prompt.
- `comm_send_attachment` -- send a file or image when a report needs an artifact
  rather than text.

Use the nested target shape to send to a specific chat or topic:
`{ chat_native_id, thread_native_id?, account? }`. With no target, the daemon
routes to the session's most-recent inbound conversation.

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
