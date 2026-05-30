---
name: telegram-integration
description: Use when Codex is connected to Telegram through agents-comm-bus -- especially when the user sends work requests, approvals, status checks, or follow-up instructions from Telegram, when you need to send a Telegram update, or when you inspect Telegram conversation state.
skillName: telegram-integration
metadata:
  hermes:
    tags: [telegram, codex, mcp, messaging]
    related_skills: []
---
# Telegram Integration for Codex

## When To Use

Use this skill whenever a Telegram message reaches the Codex session, when the
user asks you to send a Telegram update, or when you need to inspect Telegram
conversation state through agents-comm-bus. The Telegram chat is part of the
active collaboration channel, not an external notification sink.

When a message arrives from Telegram, **reply on Telegram** as part of the
normal response loop -- do not assume the user is watching the local terminal.

## Codex Behavior

Codex receives Telegram inbound through the agents-comm-bus Codex bridge and
its app-server wake path. In current builds the bridge **steers the active
Codex turn first**, falling back to starting a new turn only when steering is
unavailable -- so an inbound message may arrive mid-turn rather than as a fresh
prompt. Treat injected Telegram messages as live user instructions unless they
are clearly stale or superseded by a newer local prompt.

Outbound goes back over the same channel with `comm_send_message`
(`comm: "telegram"`) -- a local-only response is invisible to a user who is
watching from their phone.

## Essential Telegram Tools

- `list_conversations` -- inspect known conversations and get exact chat or
  thread targets before sending to a non-current chat.
- `comm_send_message` -- send concise status, questions, and final reports with
  `comm: "telegram"`.
- `comm_check_messages` -- drain pending inbound when you suspect new Telegram
  context has arrived but has not yet appeared in the prompt.
- `comm_send_attachment` -- send a file or image when a report needs an artifact
  rather than text.

Prefer sending with **no target** — the daemon routes to the session's
most-recent inbound conversation by concrete identity automatically. Only set
a target to reach a different chat: `{ chat_native_id, thread_native_id?,
account? }`. When you do, `account` must be the concrete **bot id** (the
`account=<id>` value in your inbound block, or `bot=<id>` from
`list_conversations`) — account *labels* like `"main"` are rejected as
routing targets because they are ambiguous across agents.
