# Slack API — research for `SlackAdapter`

> Researched 2026-05-18.

Reference material for a `CommAdapter` implementation targeting Slack. The
adapter has to honor the bus invariants in
[invariants.md](../architecture/invariants.md) — in particular the single-
owner registration rule and the `(comm, bot_user_id)` lookup key.

Canonical docs root: [docs.slack.dev](https://docs.slack.dev/) (the older
`api.slack.com/*` URLs 302 here).

---

## 1. The three (four) APIs

Slack splits responsibilities across distinct surfaces. The adapter touches
three; the fourth is dead and named here only so it isn't mistakenly used.

| API | Direction | Transport | Use |
|-----|-----------|-----------|-----|
| [Web API](https://docs.slack.dev/apis/web-api/) | outbound | HTTPS POST, JSON or form-encoded | send / edit / delete / lookup / file uploads / `auth.test` |
| [Events API](https://docs.slack.dev/apis/events-api/) | inbound | HTTPS webhook | receive events when a public endpoint is available |
| [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode) | inbound | WebSocket (Slack-side dispatched URL) | receive events when *no* public endpoint is available — i.e. our daemon |
| RTM API (legacy) | both | WebSocket | **deprecated**, do not use ([Slack docs](https://docs.slack.dev/apis/)) |

**Decision for `SlackAdapter`:** Web API for outbound, Socket Mode for
inbound. Events API is the wrong choice for a per-user daemon behind NAT
because it requires a reachable HTTPS endpoint plus URL-verification
plumbing.

This is analogous to Telegram's polling-vs-webhook split, but inverted:
Telegram's polling is over the same `/bot.../getUpdates` REST surface;
Slack's "long-lived inbound" uses a *different* transport (WS) from its
outbound (HTTPS).

---

## 2. Authentication & token zoo

Slack issues several token kinds, distinguished by prefix
([Slack: token types](https://docs.slack.dev/authentication/tokens)):

| Prefix | Kind | What signs requests as |
|--------|------|------------------------|
| `xoxb-` | **Bot token** | the app's bot user in one workspace |
| `xoxp-` | User token | a real user (acts as them) |
| `xapp-` | **App-level token** | the app *across* workspaces — required to open Socket Mode |
| `xoxa-`, `xoxr-` | Configuration / refresh tokens | app management surfaces, not runtime |

All tokens are passed as `Authorization: Bearer <token>` on Web API calls.

```bash
curl -X POST https://slack.com/api/chat.postMessage \
  -H 'Authorization: Bearer xoxb-...' \
  -H 'Content-Type: application/json' \
  -d '{"channel":"C0123ABCDEF","text":"hi"}'
```

**Two tokens per app**: the adapter needs both an `xoxb-` token (for
`chat.postMessage`, `auth.test`, etc.) *and* an `xapp-` token (for
`apps.connections.open`). They are obtained from the same app config page
but cannot substitute for each other.

### Scopes

Bot scopes the adapter needs at minimum
([Slack: scopes reference](https://docs.slack.dev/reference/scopes)):

- `chat:write` — `chat.postMessage`, `chat.update`, `chat.delete`
- `chat:write.public` — post to channels the bot isn't a member of
- `channels:history` — read public-channel `message` events
- `groups:history` — same, private channels
- `im:history` — DMs
- `mpim:history` — multi-party DMs
- `app_mentions:read` — `app_mention` events
- `files:read` / `files:write` — receive `file_share` payloads and upload
- `reactions:read` / `reactions:write` — reactions hooks

App-level token scopes for Socket Mode: `connections:write`.

---

## 3. App vs bot user

Modern Slack apps own a bot user. The flow is:

1. Create an app at <https://api.slack.com/apps> (yes, this host still
   resolves — it's the app config console, not the docs).
2. Define a manifest (or use the UI) declaring scopes, event
   subscriptions, and bot user enablement.
3. Install to a workspace → receive the `xoxb-` token.
4. Generate an app-level token (`xapp-`) for Socket Mode if enabling it.

Legacy custom bot users (separate user tokens, no app) reach end of life
March 31, 2025 ([Slack legacy bot users](https://docs.slack.dev/legacy/legacy-bot-users/)).
The adapter must target the modern app model only.

---

## 4. Events API (webhook mode) — for reference, not used

Documented because users with public endpoints may eventually want it.

**URL verification handshake** runs once on first install. Slack POSTs:

```json
{
  "type": "url_verification",
  "token": "<legacy verification token>",
  "challenge": "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P"
}
```

The endpoint must echo `challenge` in the response body within 3 s
([Slack: Events API](https://docs.slack.dev/apis/events-api/)).

**Event envelope** (same shape Socket Mode wraps in its `payload`):

```json
{
  "type": "event_callback",
  "team_id": "T123ABC456",
  "api_app_id": "A123ABC456",
  "event_id": "Ev123ABC456",
  "event_time": 1234567890,
  "authorizations": [{"team_id":"T123ABC456","user_id":"U999","is_bot":true,"is_enterprise_install":false}],
  "event": {
    "type": "message",
    "channel": "C123",
    "user": "U456",
    "text": "hello",
    "ts": "1355517523.000005"
  }
}
```

**Retry behavior**: must return HTTP 2xx within 3 s; up to 3 retries
(immediate, +1 min, +5 min) with `x-slack-retry-num` / `x-slack-retry-reason`
headers. 95% delivery acknowledgement is enforced over rolling 60 min
windows; apps that miss can be temporarily suspended
([Slack: Events API](https://docs.slack.dev/apis/events-api/)).

For our daemon: this requires a publicly reachable HTTPS endpoint with
TLS — much harder than Telegram's poll-vs-webhook choice because Telegram
also offers `getUpdates` long-polling on the same REST API. Slack's only
"no public endpoint" path is Socket Mode.

---

## 5. Socket Mode — what the adapter uses

Open the WS by calling `apps.connections.open` with the **app-level**
token:

```bash
curl -X POST https://slack.com/api/apps.connections.open \
  -H 'Authorization: Bearer xapp-1-A...'
```

Response:

```json
{ "ok": true, "url": "wss://wss.slack.com/link/?ticket=...&app_id=..." }
```

Connect the WebSocket. Slack sends `hello`:

```json
{
  "type": "hello",
  "num_connections": 1,
  "debug_info": { "host": "applink-...", "approximate_connection_time": 18060 }
}
```

Then events arrive in this envelope ([Slack: Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode)):

```json
{
  "envelope_id": "57d6a792-4d35-4d0b-b6aa-3361493e1caf",
  "type": "events_api",
  "accepts_response_payload": false,
  "payload": {
    "type": "event_callback",
    "team_id": "T123ABC456",
    "api_app_id": "A123ABC456",
    "event_id": "Ev123",
    "event_time": 1747500000,
    "event": { "type": "message", "channel": "C123", "user": "U456", "text": "hi", "ts": "1747500000.000100" }
  }
}
```

**Ack within 3 s** by sending back over the same WS:

```json
{ "envelope_id": "57d6a792-4d35-4d0b-b6aa-3361493e1caf" }
```

`type` values for the envelope include `events_api`, `interactive`,
`slash_commands`, `disconnect`. The `disconnect` type signals a planned
reconnect — open a new WS via `apps.connections.open` and drop the old
one.

**Single-ownership implication** (bus invariant *one comm owner per
(comm, account)*): each `xapp-` token can hold up to 10 simultaneous WS
connections for load balancing, but for our daemon a single connection
per registration is the right model. Socket Mode delivers each event
exactly once to *one* of the open connections — concurrent listeners on
the same app token race for events. The adapter must not allow two
processes to open WS against the same `xapp-` token; the
`account_registrations` row keyed on `(comm='slack', bot_user_id=U...)`
is exactly the lock that enforces this. Compare Events API: webhooks
have no contention because there is no persistent connection.

---

## 6. Identity probe — `auth.test`

Slack's analogue to Telegram `getMe()` ([Slack: auth.test](https://docs.slack.dev/reference/methods/auth.test)):

```bash
curl -X POST https://slack.com/api/auth.test \
  -H 'Authorization: Bearer xoxb-...'
```

```json
{
  "ok": true,
  "url": "https://acme.slack.com/",
  "team": "Acme",
  "user": "my_bot",
  "team_id": "T123ABC456",
  "user_id": "U0BOTUSER0",
  "bot_id": "B0BOTAPPID0",
  "is_bot": true
}
```

Two distinct ids come back:

- `user_id` (`U...`) — the bot user's id, used as `user` in inbound
  message events when the bot itself posts, and as the `channel` target
  for `chat.postMessage` when DMing the bot.
- `bot_id` (`B...`) — the internal Slack bot id, used as `bot_id` on
  `bot_message`-subtype events.

**Routing key choice:** `user_id` is the right `bot_user_id` for
`account_registrations` because that's what appears on inbound messages
the bot posts, and what other bots will see in `bot_message.user`-equivalent
slots. `bot_id` is also stored (it's the only id present on some legacy
shapes) but `user_id` is canonical.

---

## 7. Receiving messages

The `message` event ([Slack: message event](https://docs.slack.dev/reference/events/message/))
has many subtypes. The ones the adapter must handle:

### Normal user message

```json
{
  "type": "message",
  "channel": "C123ABC456",
  "user": "U987654321",
  "text": "hello world",
  "ts": "1747500000.000100",
  "team": "T123ABC456",
  "blocks": [ /* rich_text */ ],
  "client_msg_id": "..."
}
```

`ts` is both the platform message id *and* a unix timestamp (seconds
with microsecond fraction, as a string). The adapter must keep it
verbatim — float parsing loses precedence ordering.

### Threaded reply

```json
{
  "type": "message",
  "channel": "C123ABC456",
  "user": "U987",
  "text": "in thread",
  "ts": "1747500050.000200",
  "thread_ts": "1747500000.000100",
  "parent_user_id": "U987654321"
}
```

`thread_ts` is the parent message's `ts`. Top-level messages omit it (or
some clients echo it equal to their own `ts`).

### `bot_message` subtype

Delivered when another bot posts in a channel the receiving bot can read.
This is the agent-to-agent path:

```json
{
  "type": "message",
  "subtype": "bot_message",
  "channel": "C123ABC456",
  "text": "deploy finished",
  "ts": "1747500100.000300",
  "bot_id": "B0OTHERBOT",
  "app_id": "A0OTHERAPP",
  "username": "deploy-bot",
  "bot_profile": {
    "id": "B0OTHERBOT",
    "app_id": "A0OTHERAPP",
    "name": "deploy-bot",
    "team_id": "T123ABC456",
    "icons": { "image_36": "...", "image_48": "...", "image_72": "..." },
    "updated": 1747400000
  }
}
```

**Confirmed**: when bot A posts via `chat.postMessage` in channel C, bot
B (also a member of C) receives a `message` event with
`subtype: "bot_message"`, populated `bot_id`, and `bot_profile`. There is
no `user` field on this subtype — the sender identity lives entirely in
`bot_id` / `bot_profile.app_id` ([Slack: bot_message](https://docs.slack.dev/reference/events/message/bot_message/)).

This is fundamentally different from Telegram, where bots cannot read
each other's messages at all. The `SlackAdapter` must **not** filter
`subtype: bot_message` out — it's exactly what enables the agent-to-agent
fanout the bus is designed for. The foreign-bot policy invariant
(invariants.md → *fanout discipline*) is what decides whether to act on
those messages, not whether to receive them.

### `message_changed` (edit)

The envelope is *nested*: the outer `event` carries `subtype:
message_changed`, and the new/old message bodies live under
`event.message` and `event.previous_message`:

```json
{
  "type": "message",
  "subtype": "message_changed",
  "channel": "C123ABC456",
  "ts": "1747500200.000400",
  "hidden": true,
  "message": {
    "type": "message",
    "user": "U987",
    "text": "hello world (edited)",
    "ts": "1747500000.000100",
    "edited": { "user": "U987", "ts": "1747500200.000400" }
  },
  "previous_message": {
    "type": "message",
    "user": "U987",
    "text": "hello world",
    "ts": "1747500000.000100"
  }
}
```

The id of the edited message is `event.message.ts`, **not**
`event.ts` (that's the edit-event id). The adapter's edit hook must use
the inner `message.ts` when computing the platform message id to update
the bus transcript.

### `message_deleted`

```json
{
  "type": "message",
  "subtype": "message_deleted",
  "channel": "C123ABC456",
  "ts": "1747500300.000500",
  "deleted_ts": "1747500000.000100",
  "hidden": true,
  "previous_message": { "type": "message", "user": "U987", "text": "hello world", "ts": "1747500000.000100" }
}
```

`deleted_ts` is the id of the message that went away.

### `file_share`

Sent automatically when a file is uploaded with `channel_id` set on
`files.completeUploadExternal`. Carries `files: [...]` with file metadata.

### Other subtypes the adapter should ignore (or pass through as
"system" events): `channel_join`, `channel_leave`, `channel_topic`,
`channel_purpose`, `pinned_item`, `unpinned_item`, `thread_broadcast`
(treat as normal threaded message with `reply_broadcast`).

---

## 8. Sending messages — `chat.postMessage`

[Slack: chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)

```bash
curl -X POST https://slack.com/api/chat.postMessage \
  -H 'Authorization: Bearer xoxb-...' \
  -H 'Content-Type: application/json' \
  -d '{
    "channel": "C123ABC456",
    "text": "hello",
    "thread_ts": "1747500000.000100"
  }'
```

```json
{
  "ok": true,
  "channel": "C123ABC456",
  "ts": "1747500400.000600",
  "message": {
    "type": "message",
    "user": "U0BOTUSER0",
    "text": "hello",
    "ts": "1747500400.000600",
    "thread_ts": "1747500000.000100",
    "bot_id": "B0BOTAPPID0"
  }
}
```

Parameters relevant to the adapter:

- `channel` — channel id (`C...`), DM id (`D...`), MPIM (`G...` or
  `C...`), *or* a user id (`U...`) to open a DM implicitly.
- `text` — fallback string. Required if `blocks` is omitted.
- `blocks` — Block Kit array for rich content.
- `thread_ts` — parent `ts` to reply in a thread.
- `reply_broadcast` — boolean; when `true` plus `thread_ts`, also posts a
  reference into the channel root. Maps to "reply in channel".
- `unfurl_links` / `unfurl_media` — link preview controls.

### Edit / delete

```bash
# edit
curl -X POST https://slack.com/api/chat.update \
  -H 'Authorization: Bearer xoxb-...' \
  -d 'channel=C123ABC456&ts=1747500400.000600&text=hello%20(edited)'

# delete
curl -X POST https://slack.com/api/chat.delete \
  -H 'Authorization: Bearer xoxb-...' \
  -d 'channel=C123ABC456&ts=1747500400.000600'
```

Bot tokens can only edit/delete messages they themselves sent
([Slack: chat.delete](https://docs.slack.dev/reference/methods/chat.delete/)).

---

## 9. Channel / chat model

Conversation IDs the adapter must accept ([Slack Connect](https://docs.slack.dev/apis/slack-connect/),
[Conversations API](https://docs.slack.dev/apis/web-api/using-the-conversations-api/)):

| Prefix | Kind |
|--------|------|
| `C...` | Public channel — and increasingly *private* channels too, after a Slack Connect share migration |
| `G...` | Legacy private channel; legacy MPIM. New private channels are `C...` |
| `D...` | 1:1 DM |
| `G...` | Multi-party DM (MPIM) — sometimes also `C...` post-migration |

**ID stability gotcha**: when a private channel (`G...`) is first
shared via Slack Connect, Slack rewrites its id to a `C...`. The
`channel_id_changed` event delivers the (`old_channel_id`,
`new_channel_id`) pair. The adapter must subscribe to it and remap
`conversations.external_chat_id` accordingly; treating channel ids as
immutable is wrong.

Slack Connect channels also carry the gotchas that the bot may not be
installed in every participating workspace (use `authorizations` from
the event envelope), and that external members' profile data is
restricted.

---

## 10. Threads

Slack threads are *not* separate channels — they're a `thread_ts`
linkage within the same channel ([Slack: threading](https://docs.slack.dev/messaging/sending-and-scheduling-messages/)):

- Reply: post with `thread_ts = <parent ts>`.
- Top-level message: omit `thread_ts`.
- Reply-of-a-reply: not allowed. Slack flattens — `thread_ts` always
  points to the *root* of the thread, not the immediate parent.
- Optional `reply_broadcast: true` echoes the reply into the channel
  root.

Compare:

- Telegram `reply_to_message_id` — message-level pointer, doesn't form a
  persistent thread.
- Discord — threads are first-class channels with their own ids.
- Slack — same channel, `thread_ts` group key. Cheapest of the three to
  model; a `ThreadRef` is just `(channel_id, thread_ts)`.

---

## 11. Files / attachments

Old method `files.upload` is **retired November 12, 2025** ([Slack
changelog: deadline extension](https://docs.slack.dev/changelog/2025/03/17/files-upload-extension/)).
As of May 16, 2024 newly-created apps cannot call it. Use the three-step
external upload flow ([Slack: working with files](https://docs.slack.dev/messaging/working-with-files)).

```bash
# 1) Get a signed upload URL
curl -X POST https://slack.com/api/files.getUploadURLExternal \
  -H 'Authorization: Bearer xoxb-...' \
  --form 'filename=screenshot.png' \
  --form 'length=53072'
# -> {"ok":true,"upload_url":"https://files.slack.com/upload/v1/abc...","file_id":"F0ABC1234"}

# 2) Upload bytes directly to the returned URL (S3-style)
curl -X POST "$UPLOAD_URL" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary '@screenshot.png'

# 3) Finalize and (optionally) share into a channel
curl -X POST https://slack.com/api/files.completeUploadExternal \
  -H 'Authorization: Bearer xoxb-...' \
  --form 'files=[{"id":"F0ABC1234","title":"screenshot"}]' \
  --form 'channel_id=C123ABC456' \
  --form 'thread_ts=1747500000.000100' \
  --form 'initial_comment=here is the screenshot'
```

Without step 3 the file is discarded; without `channel_id` the file is
private. Sharing a file into a channel auto-emits a `message` event with
`subtype: file_share` carrying `files: [...]` metadata.

Files have their own ids (`F...`), independent URLs, and an
asynchronous malware-scan step — large files may have a delay between
`completeUploadExternal` returning and the `file_share` event firing.

For the bus: attachments map to the content-addressed blob store
described in [storage-layout.md](../architecture/storage-layout.md). The
adapter SHA-256s the downloaded bytes and stores Slack's `id` /
`permalink` in the message row as opaque metadata for re-share, but the
canonical reference is the blob hash.

---

## 12. Replies vs threads

Slack has no message-level reply primitive outside threads. There is no
"reply to message X without starting a thread" — every reply attaches
either as a top-level channel message or via `thread_ts`. The adapter's
`ThreadRef` therefore unifies both Slack thread membership *and* what
Telegram calls `reply_to_message`. Code on the Telegram side picks one;
code on the Slack side always emits a `thread_ts`.

---

## 13. Reactions

Web API: `reactions.add`, `reactions.remove` ([Slack: scopes](https://docs.slack.dev/reference/scopes)
covers `reactions:write`).

```bash
curl -X POST https://slack.com/api/reactions.add \
  -H 'Authorization: Bearer xoxb-...' \
  -d 'channel=C123ABC456&timestamp=1747500000.000100&name=thumbsup'
```

Inbound event ([Slack: reaction_added](https://docs.slack.dev/reference/events/reaction_added/)):

```json
{
  "type": "reaction_added",
  "user": "U987",
  "reaction": "thumbsup",
  "item_user": "U0BOTUSER0",
  "item": { "type": "message", "channel": "C123ABC456", "ts": "1747500000.000100" },
  "event_ts": "1747500500.000700"
}
```

`reaction_removed` has the same shape. The reaction target is identified
by `(item.channel, item.ts)` — the same pair the adapter uses for
edit/delete.

---

## 14. Bot-to-bot delivery (revisited)

This is the load-bearing fact for the bus. Confirmed:

- Bot B's Socket Mode connection delivers a `message` event with
  `subtype: "bot_message"`, full `bot_id`/`bot_profile`, and `app_id`
  whenever bot A posts in a channel B has `*_history` scope for.
- The Slack-side rule is "any bot with the relevant `history` scope on
  the channel sees all messages, regardless of who posted them" —
  history scopes do not filter by author.
- `bot_message` events lack the top-level `user` field. The sender is
  in `bot_id` / `bot_profile.app_id` only. Code that destructures
  `event.user` unconditionally will crash on these.
- For the fanout-discipline invariant: the *foreign-bot policy* gate
  fires on `subtype === 'bot_message'`. Default-deny is the right
  default; allow-listing is per `bot_id` or `app_id`.

There is no `from_user_id`-style synthesized field — the adapter has to
build a synthetic `SenderRef` from `bot_id` (or `bot_profile.app_id` if
present) so the bus has a consistent identity to log and gate on.

---

## 15. Rate limits

Per-method, per-workspace, per-app. Tiers ([Slack: rate limits](https://docs.slack.dev/apis/web-api/rate-limits)):

| Tier | Approx ceiling | Examples |
|------|---------------|----------|
| 1 | ~1 / min | `admin.*` |
| 2 | ~20 / min | `conversations.history`, `users.list` |
| 3 | ~50 / min | `conversations.replies`, `chat.delete` |
| 4 | ~100 / min | `files.getUploadURLExternal`, `auth.test` |
| Special | ~1 / sec per channel | `chat.postMessage`, `chat.update` |

`chat.postMessage` is on the special tier — short bursts to the same
channel are tolerated, but sustained > 1 msg/s/channel will hit 429.
429 responses carry `Retry-After: <seconds>`. The adapter must respect
that header (vs. exponential backoff guessed locally — Slack
specifically asks apps to honor `Retry-After`).

Implication for the bus: a per-channel send queue is the right shape.
Sends to *different* channels do not contend; sends to the same channel
serialize at ~1/s.

---

## 16. Self-hosting

No. Slack is a closed SaaS. There is no on-prem Slack and no third-party
Slack-compatible server. (Mattermost / Zulip implement their own APIs,
not Slack's.) The adapter cannot be pointed at an alternative host.

This contrasts with Matrix (self-hostable Synapse) and constrains the
deployment model: every Slack-using bus user is hitting `slack.com`.

---

## 17. Node.js / TypeScript libraries

The official `@slack/*` family ([Slack tools index](https://docs.slack.dev/tools/)):

| Package | Layer | Use |
|---------|-------|-----|
| [`@slack/bolt`](https://docs.slack.dev/tools/bolt-js/) | high — framework | event routing, middleware, both Events API and Socket Mode |
| [`@slack/web-api`](https://www.npmjs.com/package/@slack/web-api) | low — REST only | typed wrapper over Web API methods; needed for `chat.postMessage`, `files.*`, `auth.test` |
| [`@slack/socket-mode`](https://www.npmjs.com/package/@slack/socket-mode) | low — WS only | `SocketModeClient` that handles `apps.connections.open`, reconnect on `disconnect`, ack helpers |
| [`@slack/oauth`](https://www.npmjs.com/package/@slack/oauth) | OAuth flows | only if the adapter exposes a multi-tenant install URL |

**Recommendation for `SlackAdapter`:** `@slack/web-api` +
`@slack/socket-mode`, *not* Bolt.

Reasons:

- Bolt's strengths (declarative `app.message('foo', ...)` matchers,
  middleware chains, built-in command/action dispatch) are orthogonal
  to what a `CommAdapter` does — the adapter has exactly one inbound
  handler (push to bus) and one outbound handler (pull from bus).
- Bolt owns the process lifecycle and the event loop; we want the bus
  to own those.
- Bolt bundles assumptions about state storage (installation stores,
  conversation stores) that fight with the bus's SQLite-on-disk model.
- The low-level pair gives full control over reconnect, ack timing, and
  the WS error-stream — exactly what's needed for the single-owner
  invariant and the durable-enqueue-before-wake invariant.

Bolt remains the right choice if a Slack-specific app is being built
*on top of* the bus, but not for the adapter itself.

---

## 18. Failure modes / gotchas

- **Two tokens, not one.** `xoxb-` and `xapp-` are both required for
  Socket Mode. Forgetting `xapp-` produces opaque "missing scope"
  errors from `apps.connections.open`.
- **URL-verification stalls plugin install** if Events API is enabled
  but the endpoint isn't live. Pick one transport mode at app config
  time.
- **Socket Mode `disconnect` envelope** — Slack sends this every ~hour
  (or on its own load-balancing schedule). The adapter must open a
  fresh WS *before* closing the old one; otherwise events in flight are
  lost.
- **`message_changed` is nested.** The id of the edited message is at
  `event.message.ts`, not `event.ts`. Easy to get wrong; produces
  ghost edits to the wrong transcript row.
- **Files API migration.** `files.upload` is dead Nov 2025; new apps
  already cannot call it. Implement only the three-step flow.
- **Rate-limit silence in dev workspaces.** Test workspaces with many
  test bots burn through `chat.postMessage` quota fast; symptoms are
  delayed sends, not errors, because Slack-side queuing absorbs short
  bursts. Always read `Retry-After`.
- **Slack Connect ID rewrites.** Private channels lose their `G...` id
  the first time they're shared externally. Handle `channel_id_changed`
  or routing breaks silently.
- **`bot_message` lacks `user`.** Code paths assuming `event.user` is
  always present will crash on legit bot traffic.
- **`ts` is precision-sensitive.** It's a string like
  `"1747500000.000100"`; rounding to a JS `number` collides with other
  messages in the same second.
- **`chat.update` cannot un-send.** It edits in place; the original
  text is recoverable from `previous_message` in the resulting
  `message_changed` event only.
- **Socket Mode races.** Two processes opening WS against the same
  `xapp-` token will each get a fraction of events. The bus's
  `account_registrations` unique constraint must be enforced *before*
  the WS is opened, not after.

---

## 19. Mapping to core CommAdapter types

| Slack concept | Telegram concept | Core type |
|---------------|------------------|-----------|
| channel id (`C...`) / DM id (`D...`) / MPIM id (`G...`) | `chat.id` | `ChatRef.external_chat_id` |
| `thread_ts` | `reply_to_message.message_id` | `ThreadRef` (carried inside `ChatRef`) |
| `ts` (e.g. `"1747500000.000100"`) | `message.message_id` (int) | `MessageId` (opaque string) |
| `user` field on inbound | `from.id` | `SenderRef.user_id` |
| `bot_id` + `bot_profile` on `bot_message` | (n/a — bots can't see bots) | `SenderRef` with `is_bot=true` |
| `user_id` from `auth.test` | `id` from `getMe()` | `account_registrations.bot_user_id` |
| `team_id` | (no analogue — one bot per Telegram token) | `account_registrations.workspace_id` |
| `xoxb-` bot token | `<bot-token>` from BotFather | `account_registrations.credential` (outbound) |
| `xapp-` app-level token | (n/a — Telegram uses the bot token) | `account_registrations.credential_socket` (inbound) |
| `files.getUploadURLExternal` → S3 → `completeUploadExternal` | `sendPhoto` / `sendDocument` multipart | `Attachment` + content-addressed blob store |
| file id (`F...`) | `file_id` | `Attachment.platform_file_id` |
| `reaction_added` event | (Bot API reactions, separate feature) | `ReactionEvent` |
| `message_changed` (inner `message.ts`) | `edited_message.message_id` | `EditEvent` keyed on `MessageId` |
| `message_deleted` (`deleted_ts`) | (n/a in standard Bot API) | `DeleteEvent` keyed on `MessageId` |
| Socket Mode WS connection | long-poll `getUpdates` loop | inbound transport (singleton per registration) |
| `apps.connections.open` | (n/a — no per-poll handshake) | adapter `connect()` hook |
| `disconnect` envelope | HTTP timeout on `getUpdates` | adapter `onDisconnect()` → reopen |
| 429 + `Retry-After` | 429 + `retry_after` in body | shared backpressure hook |
