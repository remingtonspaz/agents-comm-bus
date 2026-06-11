---
name: curl-ingress
description: Use when Claude Code receives messages injected by local systems through the agents-comm-bus curl adapter -- cron heartbeats, CI status reports, kanban/Hermes notes, or local scripts POSTing context to this session. Also use when the user asks how to push local context into the session over HTTP.
skillName: curl-ingress
metadata:
  hermes:
    tags: [curl, claude-code, mcp, ingress, automation]
    related_skills: []
---
# Curl Ingress for Claude Code

## When To Use

Use this skill whenever an inbound message with `comm=curl` reaches the
Claude Code session. These messages come from **local systems** — cron jobs,
CI pipelines, kanban/Hermes reports, or small scripts — that POSTed payload
context to the agents-comm-bus daemon's local curl endpoint to wake this
session and inject context.

## Claude Code Behavior

Claude Code receives curl inbound as hook-injected prompt context (the
`[Daemon Inbound Messages]` block prepended by the UserPromptSubmit hook).
Treat the payload as machine-generated context or instructions from the local
system identified by its `sender_id` (e.g. `ci`, `cron`, `hermes`), unless it
is clearly stale.

**The curl comm is local inbound-only — there is no reply channel.** The
HTTP exchange ended when the message was accepted, so `comm_send_message`
with `comm: "curl"` fails by design. If a human should see your response,
reply over a bidirectional comm registered for this project (e.g.
`comm: "telegram"`), or just act on the context locally.

## Essential Tools

- `comm_check_messages` -- drain pending inbound (optionally `comm: "curl"`)
  when you suspect new injected context has not yet appeared in the prompt.
- `list_conversations` -- inspect curl conversations; each caller bins into a
  synthetic conversation keyed by its `chat_native_id` (default
  `curl:<sender_id>`).

## Posting To This Session (for reference)

Local systems POST to the loopback endpoint discovered from
`~/.agents-comm-bus/curl/<account>/endpoint.json`:

```bash
curl -s -X POST "http://127.0.0.1:<port>/messages" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"project":"<abs project path>","agent":"claude","sender_id":"ci","text":"build green"}'
```

Optional fields: `chat_native_id` (conversation bin) and `metadata` (object,
kept in the transcript for troubleshooting).
