---
name: agents-comm-matrix
description: Use when Pi is connected to Matrix through agents-comm-bus -- especially when a Matrix message arrives as a [Daemon Inbound Messages] block, when you need to send a Matrix update, or when you inspect Matrix conversation state. The Matrix room is the active collaboration channel, not a notification sink.
metadata:
  comm: matrix
  agent: pi
---

# Matrix Integration for Pi

## When To Use

Use this skill whenever a Matrix message reaches the Pi session, when the
user asks you to send a Matrix update, or when you need to inspect Matrix
conversation state through agents-comm-bus. The Matrix room is part of the
active collaboration channel, not an external notification sink.

When a message arrives from Matrix, **reply on Matrix** as part of the
normal response loop -- do not assume the user is watching the local terminal.

## Pi Behavior

Pi receives Matrix inbound through the **agents-comm-bus Pi extension** -- a
background poller (2s interval) that drains pending inbound from the daemon and
injects it as a **user message** containing the `[Daemon Inbound Messages]`
block. There are no hooks, no watcher keystroke, and no app-server wake path.

Treat the `[Daemon Inbound Messages]` block as a live user instruction from the
remote Matrix user. The block contains the message text, sender, timestamp, and
routing envelope (`comm`, `account`, `chat_native_id`, `conversation_id`, etc.).

If Pi is busy (mid-turn or streaming), inbound arrives as a **follow-up** queued
after the current turn completes -- not lost, not dropped.

Outbound goes back over the same channel with `comm_send_message`
(`comm: "matrix"`) -- a local-only response is invisible to a user who is
watching from Matrix.

## Essential Matrix Tools

- `comm_send_message` -- send concise status, questions, and final reports with
  `comm: "matrix"`.
- `comm_send_attachment` -- send a file or image when a report needs an artifact
  rather than text.
- `comm_check_messages` -- drain pending inbound when you suspect new Matrix
  context has arrived but has not yet appeared as a user message.
- `list_conversations` -- inspect known conversations and get exact room
  targets before sending to a non-current chat.

Prefer sending with **no target** -- the daemon routes to the session's
most-recent inbound conversation by concrete identity automatically. Only set
a target to reach a different room: `{ chat_native_id, thread_native_id?,
account? }`. When you do, `account` must be the concrete **bot id** (the
Matrix MXID from `account=<id>` in your inbound block, or `bot=<id>` from
`list_conversations`) -- account *labels* like `"main"` are rejected as
routing targets because they are ambiguous across agents.
