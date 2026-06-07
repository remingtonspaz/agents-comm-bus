---
name: matrix-integration
description: Use when Claude Code is connected to Matrix through agents-comm-bus -- especially when the user sends work requests, approvals, status checks, or follow-up instructions from Matrix, when you need to send a Matrix update, or when you inspect Matrix conversation state.
skillName: matrix-integration
metadata:
  hermes:
    tags: [matrix, claude-code, mcp, messaging]
    related_skills: []
---

# Matrix Integration for Claude Code

## When To Use

Use this skill whenever a Matrix message reaches the Claude Code session,
when the user asks you to send a Matrix update, or when you need to inspect
Matrix conversation state through agents-comm-bus. The Matrix channel is part
of the active collaboration channel, not an external notification sink.

When a message arrives from Matrix, **reply on Matrix** as part of the
normal response loop -- do not assume the user is watching the local terminal.

## Claude Code Behavior

Claude Code receives Matrix inbound as hook-injected prompt context (the
`[Daemon Inbound Messages]` block prepended by the UserPromptSubmit hook).
Treat those injected messages as current user instructions unless they are
clearly stale or superseded by a newer local prompt.

Outbound goes back over the same channel with `comm_send_message`
(`comm: "matrix"`) -- a local-only response is invisible to a user who is
watching from Matrix.

## Essential Matrix Tools

- `list_conversations` -- inspect known conversations and get exact room
  targets before sending to a non-current chat.
- `comm_send_message` -- send concise status, questions, and final reports with
  `comm: "matrix"`.
- `comm_check_messages` -- drain pending inbound when you suspect new Matrix
  context has arrived but has not yet appeared in the prompt.
- `comm_send_attachment` -- send a file or image when a report needs an artifact
  rather than text.

Prefer sending with **no target** — the daemon routes to the session's
most-recent inbound conversation by concrete identity automatically. Only set
a target to reach a different room: `{ chat_native_id, thread_native_id?,
account? }`. When you do, `account` must be the concrete **bot id** (the
Matrix MXID from `account=<id>` in your inbound block, or `bot=<id>` from
`list_conversations`) — account *labels* like `"main"` are rejected as
routing targets because they are ambiguous across agents.
