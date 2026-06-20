---
name: agents-comm-curl
description: Use when Pi receives messages injected by local systems through the agents-comm-bus curl adapter -- cron heartbeats, CI status reports, kanban/Hermes notes, or local scripts POSTing context to this session. Also use when the user asks how to push local context into the session over HTTP.
metadata:
  comm: curl
  agent: pi
---

# Curl Ingress for Pi

## When To Use

Use this skill whenever an inbound message with `comm=curl` reaches the
Pi session. These messages come from **local systems** -- cron jobs,
CI pipelines, kanban/Hermes reports, or small scripts -- that POSTed payload
context to the agents-comm-bus daemon's local curl endpoint to wake this
session and inject context.

## Pi Behavior

Pi receives curl inbound through the **agents-comm-bus Pi extension** -- a
background poller (2s interval) that drains pending inbound from the daemon and
injects it as a **user message** containing the `[Daemon Inbound Messages]`
block. There are no hooks, no watcher keystroke, and no app-server wake path.

Treat the payload as machine-generated context or instructions from the local
system identified by its `sender_id` (e.g. `ci`, `cron`, `hermes`), unless it
is clearly stale.

**The curl comm is local inbound-only -- there is no reply channel.** The
HTTP exchange ended when the message was accepted, so `comm_send_message`
with `comm: "curl"` fails by design. If a human should see your response,
reply over a bidirectional comm registered for this project (e.g.
`comm: "telegram"`), or just act on the context locally.

## Essential Tools

- `comm_check_messages` -- drain pending inbound (optionally `comm: "curl"`)
  when you suspect new injected context has not yet appeared as a user message.
- `list_conversations` -- inspect curl conversations; each caller bins into a
  synthetic conversation keyed by its `chat_native_id` (default
  `curl:<sender_id>`).

## Posting To This Session (for reference)

Local systems POST to the loopback endpoint discovered from
`~/.agents-comm-bus/curl/<account>/endpoint.json`:

```bash
curl -s -X POST "http://127.0.0.1:<port>/messages" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"project":"<abs project path>","agent":"pi","sender_id":"ci","text":"build green"}'
```

Optional fields: `chat_native_id` (conversation bin) and `metadata` (object,
kept in the transcript for troubleshooting).
