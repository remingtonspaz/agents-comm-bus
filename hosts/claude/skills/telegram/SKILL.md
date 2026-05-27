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
