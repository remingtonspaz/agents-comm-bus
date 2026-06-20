---
name: agents-comm-discord
description: Use when Pi is connected to Discord through agents-comm-bus -- especially when a Discord message arrives as a [Daemon Inbound Messages] block, when you need to send a Discord update, or when you inspect Discord conversation state. The Discord channel is the active collaboration channel, not a notification sink.
metadata:
  comm: discord
  agent: pi
---

# Discord Integration for Pi

## When To Use

Use this skill whenever a Discord message reaches the Pi session, when the
user asks you to send a Discord update, or when you need to inspect Discord
conversation state through agents-comm-bus. The Discord channel is part of the
active collaboration channel, not an external notification sink.

When a message arrives from Discord, **reply on Discord** as part of the
normal response loop -- do not assume the user is watching the local terminal.

## Pi Behavior

Pi receives Discord inbound through the **agents-comm-bus Pi extension** -- a
background poller (2s interval) that drains pending inbound from the daemon and
injects it as a **user message** containing the `[Daemon Inbound Messages]`
block. There are no hooks, no watcher keystroke, and no app-server wake path.

Treat the `[Daemon Inbound Messages]` block as a live user instruction from the
remote Discord user. The block contains the message text, sender, timestamp, and
routing envelope (`comm`, `account`, `chat_native_id`, `conversation_id`, etc.).

If Pi is busy (mid-turn or streaming), inbound arrives as a **follow-up** queued
after the current turn completes -- not lost, not dropped.

Outbound goes back over the same channel with `comm_send_message`
(`comm: "discord"`) -- a local-only response is invisible to a user who is
watching from Discord.

## Essential Discord Tools

- `comm_send_message` -- send concise status, questions, and final reports with
  `comm: "discord"`.
- `comm_send_attachment` -- send a file or image when a report needs an artifact
  rather than text.
- `comm_check_messages` -- drain pending inbound when you suspect new Discord
  context has arrived but has not yet appeared as a user message.
- `list_conversations` -- inspect known conversations and get exact channel
  targets before sending to a non-current chat.

Prefer sending with **no target** -- the daemon routes to the session's
most-recent inbound conversation by concrete identity automatically. Only set
a target to reach a different channel: `{ chat_native_id, thread_native_id?,
account? }`. When you do, `account` must be the concrete **bot id** (the
`account=<id>` value in your inbound block, or `bot=<id>` from
`list_conversations`) -- account *labels* like `"main"` are rejected as
routing targets because they are ambiguous across agents.
