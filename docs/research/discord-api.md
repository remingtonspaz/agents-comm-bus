# Discord API research

> Researched 2026-05-18.

Scope: what a `DiscordAdapter` implementing `CommAdapter` needs to know.
Discord is referenced as canonical comm #2 alongside Telegram. Slack and
Matrix are tracked separately. See
[invariants](../architecture/invariants.md) and
[storage layout](../architecture/storage-layout.md) for the contracts this
adapter must honor.

Canonical docs live at `https://docs.discord.com/developers/...` (the
older `discord.com/developers/docs/...` paths now 301-redirect there).
Citations below use the new host.

## 1. Two-headed API

Unlike Telegram, where one HTTPS endpoint (`getUpdates` long-poll **or**
webhook) carries both inbound and outbound, Discord splits the API in
two:

- **Gateway** — a stateful WebSocket
  (`wss://gateway.discord.gg/?v=10&encoding=json`). All inbound events
  (messages, edits, deletes, reactions, presences, thread changes) arrive
  here. There is no REST poll equivalent. To receive *anything* you must
  hold an open Gateway connection.
- **REST** — `https://discord.com/api/v10/...`. Used to send / edit /
  delete messages, upload attachments, fetch users/channels/guilds,
  create webhooks. REST does *not* deliver events.

Implication for the adapter: a `DiscordAdapter` is **always** a
WebSocket-holding component, even when idle. There is no "send-only"
mode equivalent to a Telegram bot that only calls `sendMessage` and
never polls.

Sources: [Gateway](https://docs.discord.com/developers/topics/gateway),
[API Reference](https://docs.discord.com/developers/reference).

## 2. Authentication

Three token types exist; only one is in scope:

- **Bot token** — issued in the Developer Portal under Application →
  Bot. Header: `Authorization: Bot <token>`. This is what the adapter
  uses.
- **User token** — extracted from a logged-in client. Self-botting
  violates Discord ToS. Out of scope.
- **OAuth2 Bearer** — `Authorization: Bearer <token>` for delegated
  user actions (e.g. logging a user into a third-party app). Not used
  by bots for messaging.

Header example:

```
Authorization: Bot <bot_token>
User-Agent: DiscordBot (https://example.com/agents-comm-bus, 0.1.0)
```

`User-Agent` is mandatory; missing/invalid agents are filtered by
Cloudflare before the request reaches Discord.

Regenerating a token in the portal **immediately invalidates** the old
token and closes any live Gateway connection authenticated with it.
The adapter must surface "token rotated externally" as a recoverable
auth failure, not a crash.

Source: [API Reference](https://docs.discord.com/developers/reference).

## 3. Gateway connection lifecycle

`GET /gateway/bot` (bot-token authenticated) returns:

```json
{
  "url": "wss://gateway.discord.gg",
  "shards": 1,
  "session_start_limit": {
    "total": 1000,
    "remaining": 999,
    "reset_after": 14400000,
    "max_concurrency": 1
  }
}
```

`session_start_limit.remaining` is the IDENTIFY budget over a rolling
24 h window. Burning it through aggressive reconnect loops triggers a
forced token reset.

### Op codes

| Op | Name           | Direction      | Meaning                                                  |
|----|----------------|----------------|----------------------------------------------------------|
| 0  | Dispatch       | recv           | A named event (`t` field) — `MESSAGE_CREATE`, `READY`, etc. |
| 1  | Heartbeat      | send / recv    | Liveness ping; payload `d` = last sequence seen          |
| 2  | Identify       | send           | First authenticated frame                                |
| 6  | Resume         | send           | Resume a dropped session                                 |
| 7  | Reconnect      | recv           | Server asks us to reconnect and resume                   |
| 9  | Invalid Session| recv           | Resume failed; payload bool says whether to identify fresh |
| 10 | Hello          | recv           | First frame from server; carries `heartbeat_interval`    |
| 11 | Heartbeat ACK  | recv           | Acknowledges our op 1                                    |

Source: [Opcodes and Status Codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes).

### State diagram (fresh connect)

```
   ┌──────────────┐   GET /gateway/bot
   │  bootstrap   │ ─────────────────────────┐
   └──────┬───────┘                          ▼
          │                            url, session_start_limit
          ▼
   ┌──────────────┐   WSS connect to url?v=10&encoding=json
   │ ws-connect   │ ────────────────────────────────────────┐
   └──────┬───────┘                                          │
          │  recv op 10 HELLO (heartbeat_interval ms)        │
          ▼                                                  │
   ┌──────────────┐   start heartbeat timer (op 1 every N ms)│
   │ heartbeating │                                          │
   └──────┬───────┘                                          │
          │  send op 2 IDENTIFY { token, intents, properties }
          ▼                                                  │
   ┌──────────────┐   recv dispatch READY:                   │
   │  identified  │     { user, session_id, resume_gateway_url, ... }
   └──────┬───────┘                                          │
          │  cache session_id + resume_gateway_url           │
          ▼                                                  │
   ┌──────────────┐   recv op 0 dispatches: MESSAGE_CREATE,  │
   │  running     │   MESSAGE_UPDATE, MESSAGE_DELETE, ...    │
   └──────────────┘   update last_seq from each `s` field    │
```

Resume vs fresh identify after disconnect:

```
   socket closed (code ≠ 4004/4013/4014)
          │
          ▼
   reconnect to *resume_gateway_url* (NOT the bootstrap url)
          │
          │  send op 6 RESUME { token, session_id, seq: last_seq }
          ▼
   ┌─────────────────────────────┐
   │ wait                         │
   │   recv op 9 INVALID_SESSION │── d=true  → re-IDENTIFY fresh
   │   else replays missed       │── d=false → bail (no resume)
   │   dispatches then RESUMED   │
   └─────────────────────────────┘
```

Heartbeat: receive HELLO, schedule op 1 every `heartbeat_interval` ms
with the last seen sequence number as `d`. Server replies op 11. Two
missed ACKs ⇒ kill the socket and reconnect with resume.

Close codes that matter:

| Code | Reconnect? | Meaning                                            |
|------|------------|----------------------------------------------------|
| 4004 | no         | Authentication failed (bad token; do not retry)    |
| 4005 | yes (but don't) | "Already authenticated" — we sent op 2 twice  |
| 4008 | yes        | Gateway rate-limited (back off)                    |
| 4009 | yes        | Session timed out (fresh identify)                 |
| 4013 | no         | Invalid intent bits                                |
| 4014 | no         | Disallowed (privileged) intent not approved        |

Source: [Opcodes and Status Codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes).

### Single-connection-per-token

Confirmed. A second IDENTIFY for the same bot token does **not**
silently coexist with the first: the second connection itself is the
one that gets close-code **4005 "Already Authenticated"**. (Some
historic behavior reports also describe the original connection being
closed on a re-IDENTIFY; the documented modern behavior is 4005 on the
offending connection.) Either way, the daemon's invariant *one comm
owner per `(comm, bot_user_id)` registration* is enforced by the
platform as well as by `account_registrations` — the adapter cannot
hold two live Gateways for the same token even if the daemon's routing
layer somehow tried.

Source: [Opcodes and Status Codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes).

## 4. Gateway intents

`intents` is a bitfield on the IDENTIFY payload. Discord only dispatches
events whose intent bit is set. Relevant bits for a chat-relay adapter:

| Bit    | Value     | Name                    | Privileged | Gates                                       |
|--------|-----------|-------------------------|------------|---------------------------------------------|
| 1 << 0 | `1`       | `GUILDS`                | no         | guild create/update/delete, channel changes |
| 1 << 1 | `2`       | `GUILD_MEMBERS`         | **yes**    | member add/update/remove                    |
| 1 << 8 | `256`     | `GUILD_PRESENCES`       | **yes**    | presence updates                            |
| 1 << 9 | `512`     | `GUILD_MESSAGES`        | no         | `MESSAGE_CREATE/UPDATE/DELETE` in guilds    |
| 1 << 10| `1024`    | `GUILD_MESSAGE_REACTIONS`| no        | reaction add/remove in guilds               |
| 1 << 12| `4096`    | `DIRECT_MESSAGES`       | no         | message events in DMs                       |
| 1 << 13| `8192`    | `DIRECT_MESSAGE_REACTIONS`| no       | reaction events in DMs                      |
| 1 << 15| `32768`   | `MESSAGE_CONTENT`       | **yes**    | `content`, `attachments`, `embeds`, `components` fields on messages |

The three privileged intents (`GUILD_MEMBERS`, `GUILD_PRESENCES`,
`MESSAGE_CONTENT`) must be toggled on in the Developer Portal. Bots in
**more than 100 guilds** additionally need Discord-approved
verification to keep privileged intents enabled.

`MESSAGE_CONTENT` is the critical one for this project. Without it, the
adapter still receives `MESSAGE_CREATE` events but the `content`,
`attachments`, `embeds`, and `components` fields are **empty strings /
empty arrays** for messages that are not:

- DMs to the bot,
- messages that @-mention the bot, or
- the bot's own messages.

This is the "privileged intents misconfig" failure mode — the symptom
is silent empty `content`, not an error.

Recommended starter mask for the adapter:

```
GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS
  | DIRECT_MESSAGES | DIRECT_MESSAGE_REACTIONS
  | MESSAGE_CONTENT
= 1 | 512 | 1024 | 4096 | 8192 | 32768
= 46145
```

Source: [Gateway](https://docs.discord.com/developers/topics/gateway).

## 5. Identity probe

Two paths; the adapter uses both.

REST probe at startup:

```bash
curl -H "Authorization: Bot $TOKEN" \
     -H "User-Agent: DiscordBot (https://example.com, 0.1.0)" \
     https://discord.com/api/v10/users/@me
```

Response:

```json
{
  "id": "80351110224678912",
  "username": "Nelly",
  "global_name": null,
  "discriminator": "0",
  "avatar": "8342729096ea3675442027381ff50dfe",
  "bot": true,
  "verified": true,
  "flags": 64,
  "public_flags": 64
}
```

`id` is the canonical `bot_user_id` for `account_registrations`.
`discriminator` is legacy (`"0"` for migrated accounts under the
unique-username system); use `global_name` or `username` for display.

Gateway probe: the `READY` dispatch's `d.user` is the same user
object. Cheaper to read this than to issue an extra REST call, but the
adapter still wants REST at boot before IDENTIFY succeeds so a bad
token fails fast.

Sources: [User Resource](https://docs.discord.com/developers/resources/user),
[Gateway Events](https://docs.discord.com/developers/topics/gateway-events).

## 6. Sharding

Required at ≥ 2500 guilds: `(guild_id >> 22) % num_shards` selects
which shard handles a given guild. `GET /gateway/bot` returns the
recommended `shards` count and a `max_concurrency` for parallel
identify start-up.

For a per-user daemon owning user-installed bots, this is firmly out
of V1 scope — flag it in the adapter docs and assert `shards === 1`
on the bootstrap response, log a warning otherwise.

Source: [Gateway](https://docs.discord.com/developers/topics/gateway).

## 7. Receiving messages

`MESSAGE_CREATE` (op 0, `t = "MESSAGE_CREATE"`). The `d` payload is a
message object plus three Gateway-specific extras (`guild_id`,
`member`, populated `mentions`):

```json
{
  "op": 0,
  "s": 42,
  "t": "MESSAGE_CREATE",
  "d": {
    "id": "1234567890123456789",
    "channel_id": "987654321098765432",
    "guild_id": "111111111111111111",
    "author": {
      "id": "222222222222222222",
      "username": "alice",
      "global_name": "Alice",
      "discriminator": "0",
      "bot": false
    },
    "member": { "nick": null, "roles": ["..."], "joined_at": "..." },
    "content": "hello bot",
    "timestamp": "2026-05-18T12:34:56.789000+00:00",
    "edited_timestamp": null,
    "tts": false,
    "mention_everyone": false,
    "mentions": [],
    "mention_roles": [],
    "attachments": [],
    "embeds": [],
    "reactions": [],
    "pinned": false,
    "type": 0,
    "flags": 0,
    "referenced_message": null
  }
}
```

Notable fields for the adapter:

- `id` — message snowflake. Use as `platform_message_id`.
- `channel_id` — primary chat ref. For DMs this is a DM channel id;
  for threads it is the thread's own id; for normal guild channels
  it's the channel id.
- `guild_id` — absent for DMs.
- `author.bot` — true if author is a bot user. **Not filtered by the
  Gateway** (see §14).
- `content` — empty string if `MESSAGE_CONTENT` intent is missing and
  the message is not a DM/mention/own-message.
- `attachments[]` — array of attachment objects (`id`, `filename`,
  `size`, `url`, `proxy_url`, `content_type`, `width`, `height`).
- `referenced_message` — present for replies; the parent message
  object (or `null` if the parent was deleted).
- `type` — `0 = DEFAULT`, `19 = REPLY`, `21 = THREAD_STARTER_MESSAGE`,
  others.
- `flags` — bitfield (`1 = CROSSPOSTED`, `64 = EPHEMERAL`, ...).

Edits arrive as `MESSAGE_UPDATE` carrying the same shape (with `tts`
forced to false). Partial updates are possible; some fields may be
absent if Discord didn't change them.

Deletes:

```json
{ "op": 0, "t": "MESSAGE_DELETE",
  "d": { "id": "...", "channel_id": "...", "guild_id": "..." } }
```

```json
{ "op": 0, "t": "MESSAGE_DELETE_BULK",
  "d": { "ids": ["...", "..."], "channel_id": "...", "guild_id": "..." } }
```

Bulk delete arrives for moderator-issued `POST /channels/{id}/messages/bulk-delete`
calls.

Source: [Gateway Events](https://docs.discord.com/developers/topics/gateway-events).

## 8. Sending messages

Plain text:

```bash
curl -X POST \
  -H "Authorization: Bot $TOKEN" \
  -H "Content-Type: application/json" \
  -H "User-Agent: DiscordBot (https://example.com, 0.1.0)" \
  https://discord.com/api/v10/channels/$CHANNEL_ID/messages \
  -d '{
    "content": "hello from the adapter",
    "allowed_mentions": { "parse": [] }
  }'
```

Returns the created message object (same shape as in §7) — the adapter
captures `id` as the platform message id for tracking edits/replies.

Edit:

```
PATCH /channels/{channel.id}/messages/{message.id}
Body: { "content": "edited text" }
```

Delete:

```
DELETE /channels/{channel.id}/messages/{message.id}
```

Source: [Message Resource](https://docs.discord.com/developers/resources/message).

## 9. Channel / chat model

A "chat" in Discord is always a **channel id**. Channel types:

| Type | Const                    | Notes                                                  |
|------|--------------------------|--------------------------------------------------------|
| 0    | `GUILD_TEXT`             | server text channel                                    |
| 1    | `DM`                     | 1:1 DM with the bot                                    |
| 3    | `GROUP_DM`               | rare for bots; bots can't be added to most group DMs   |
| 5    | `GUILD_ANNOUNCEMENT`     | aka news channel                                       |
| 10   | `ANNOUNCEMENT_THREAD`    | thread under an announcement channel                   |
| 11   | `PUBLIC_THREAD`          | thread under a text/forum channel                      |
| 12   | `PRIVATE_THREAD`         | invite-only thread                                     |
| 15   | `GUILD_FORUM`            | forum; only contains threads, not direct messages      |
| 16   | `GUILD_MEDIA`            | media forum variant                                    |

All channel ids are global 64-bit snowflakes. For routing purposes the
adapter only needs `(guild_id, channel_id)` — `guild_id` is null for
DMs, which is itself a useful signal.

Source: [Channel Resource](https://docs.discord.com/developers/resources/channel).

## 10. Threads

Threads are channels. They have a non-null `parent_id` pointing at the
text/forum channel they live under, plus type 10/11/12. Lifecycle
events: `THREAD_CREATE`, `THREAD_UPDATE`, `THREAD_DELETE`,
`THREAD_LIST_SYNC`, `THREAD_MEMBERS_UPDATE`.

To **post into a thread**, send to the thread's own channel id —
`POST /channels/{thread_id}/messages`. No special routing parameter.

Mapping for the core `ChatRef` type:

| Discord                              | Core `ChatRef`                                  |
|--------------------------------------|-------------------------------------------------|
| DM channel (type 1)                  | `{ comm: 'discord', kind: 'dm', id: channel_id }` |
| Guild text channel (type 0/5)        | `{ comm: 'discord', kind: 'channel', id: channel_id, guild_id }` |
| Thread (type 10/11/12)               | `{ comm: 'discord', kind: 'thread', id: thread_id, parent_id, guild_id }` |

Contrast with Telegram `message_thread_id` (a sub-id under one chat)
and Matrix `m.thread` relations (a thread root id within a room) —
Discord *promotes* threads to full first-class channels with their own
ids, which is simpler from an addressing perspective.

Source: [Channel Resource](https://docs.discord.com/developers/resources/channel).

## 11. Attachments

Upload is multipart to the same `POST /channels/{id}/messages`
endpoint:

```
POST /channels/123/messages
Content-Type: multipart/form-data; boundary=----X

------X
Content-Disposition: form-data; name="payload_json"
Content-Type: application/json

{
  "content": "see attached",
  "attachments": [{ "id": 0, "filename": "screenshot.png" }],
  "allowed_mentions": { "parse": [] }
}
------X
Content-Disposition: form-data; name="files[0]"; filename="screenshot.png"
Content-Type: image/png

<binary bytes>
------X--
```

Default file size cap: **25 MB per file** across all channels.
Server-boost levels raise it (tier 2 → 50 MB, tier 3 → 100 MB);
recently Nitro/server-boost limits have shifted again — the adapter
should read 413 responses and surface the actual limit rather than
hardcode.

CDN URL expiry (introduced late 2023, in force since 2024):
attachment `url` and `proxy_url` fields now carry three query
parameters:

```
https://cdn.discordapp.com/attachments/{channel_id}/{message_id}/file.png
  ?ex=<expires_unix_hex>
  &is=<issued_unix_hex>
  &hm=<hmac_signature>
```

After `ex` passes, fetching the URL returns 404. Plain unsigned URLs
(no `ex/is/hm`) are also rejected. The adapter must **download
attachments promptly** if it intends to forward them — caching the
URL string is not enough.

This drops directly into the *attachments stored as content-addressed
filesystem blobs* invariant in
[invariants.md](../architecture/invariants.md): on inbound
`MESSAGE_CREATE` with non-empty `attachments[]`, the adapter fetches
each URL once and writes `chats/<conv>/attachments/<sha256>`.

Sources: [Message Resource](https://docs.discord.com/developers/resources/message),
[Bleeping Computer 2023 announcement](https://www.bleepingcomputer.com/news/security/discord-will-switch-to-temporary-file-links-to-block-malware-delivery/),
[useapi.net CDN proxy notes](https://useapi.net/docs/articles/discord-cdn-proxy).

## 12. Replies

Set `message_reference` on the outbound message:

```json
{
  "content": "answer to your question",
  "message_reference": {
    "message_id": "1234567890123456789",
    "channel_id": "987654321098765432"
  },
  "allowed_mentions": { "replied_user": false, "parse": [] }
}
```

`allowed_mentions.replied_user: false` is important — by default the
reply pings the parent author. The adapter sets it false for proactive
bus messages and lets the agent override per-send.

Cross-guild replies are not allowed for bots; both ids must be in the
same guild (or both null for a DM).

The `type` field on `message_reference` distinguishes `DEFAULT`
(traditional reply) from `FORWARD` (the 2024 forward-message feature).

Map for the core `ThreadRef` / reply pointer: a Discord
`message_reference` is the closest analogue to Telegram's
`reply_to_message` field and Matrix's `m.in_reply_to` relation.

Source: [Message Resource](https://docs.discord.com/developers/resources/message).

## 13. Reactions

Gateway events:

```json
{ "op": 0, "t": "MESSAGE_REACTION_ADD",
  "d": {
    "user_id": "...",
    "channel_id": "...",
    "message_id": "...",
    "guild_id": "...",
    "member": { ... },
    "emoji": { "id": null, "name": "👍" }
  } }
```

`MESSAGE_REACTION_REMOVE`, `MESSAGE_REACTION_REMOVE_ALL`, and
`MESSAGE_REACTION_REMOVE_EMOJI` round out the lifecycle.

To react from the bot:

```
PUT /channels/{channel.id}/messages/{message.id}/reactions/{emoji}/@me
```

Unicode emoji are URL-encoded directly (`👍` → `%F0%9F%91%8D`); custom
emoji use `{name}:{id}` format.

Gated by `GUILD_MESSAGE_REACTIONS` / `DIRECT_MESSAGE_REACTIONS`
intents.

Source: [Gateway Events](https://docs.discord.com/developers/topics/gateway-events).

## 14. Bot-to-bot delivery

The earlier project note is correct: **the Gateway delivers
`MESSAGE_CREATE` for bot-authored messages**. There is no
protocol-level filter. What filters them is **client convention**: the
canonical discord.js example handler starts with
`if (message.author.bot) return;` and almost every tutorial copies
that line. Hence the widespread folk belief that "bots can't see other
bots."

Concrete confirmations:

- discord.js itself does not strip bot-authored events; users must opt
  out by inspecting `message.author.bot`. The
  [discord.js guide on intents](https://discordjs.guide/legacy/popular-topics/intents)
  spells out what events `GUILD_MESSAGES` delivers and does not
  mention any author-type filter.
- The Gateway docs for `MESSAGE_CREATE` describe `author` as a user
  object whose `bot` field "indicates whether the user belongs to an
  OAuth2 application" — i.e. the field exists *because* bot authors
  are deliverable and clients want to distinguish them.

Caveats:

- The bot must have `MESSAGE_CONTENT` (or be mentioned, or be the
  recipient in a DM) to actually see the *content* of another bot's
  message — see §4.
- Discord has no separate "bot ignore" policy at the protocol layer.
  Community moderation policies are out-of-band.

For the `agents-comm-bus` use case (bridging two agents that may each
have their own bot identity), this is the load-bearing fact: the
adapter must implement the *recently-seen dedupe + hop counting +
foreign-bot policy* fanout discipline from
[invariants.md](../architecture/invariants.md), because the platform
will happily deliver bot-to-bot loops at line rate.

Sources: [discord.js guide: Intents](https://discordjs.guide/legacy/popular-topics/intents),
[Gateway Events](https://docs.discord.com/developers/topics/gateway-events).

## 15. Rate limits

REST: per-route bucket-based. Every response carries:

```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1747560000
X-RateLimit-Reset-After: 4.521
X-RateLimit-Bucket: abcd1234ef
X-RateLimit-Scope: user
```

On 429:

```json
{ "message": "You are being rate limited.", "retry_after": 64.57, "global": false }
```

`X-RateLimit-Global: true` on the response indicates the global ceiling
(default **50 req/s** per bot across all routes; *interaction* routes
are exempt) rather than a per-route bucket. `X-RateLimit-Scope` is
`user`, `global`, or `shared`.

Bucket keys include top-level resource ids — `channel_id`, `guild_id`,
`webhook_id` — so different channels have independent buckets.

Gateway: **120 commands per 60 seconds per connection**. "Commands"
means anything the bot sends (heartbeats included in some accountings,
though typical heartbeat cadence is well under 1/s). IDENTIFY itself
is additionally capped by `session_start_limit` (1000 / 24 h, with
`max_concurrency` for sharded boots).

Source: [Rate Limits](https://docs.discord.com/developers/topics/rate-limits),
[Gateway](https://docs.discord.com/developers/topics/gateway).

## 16. Webhooks (separate from bots)

A Discord webhook is a stateless POST URL bound to one channel. No
Gateway, no events, no replies. Create:

```
POST /channels/{channel.id}/webhooks
Body: { "name": "agents-comm-bus relay" }
```

Send:

```
POST /webhooks/{webhook.id}/{webhook.token}
Body: { "content": "...", "username": "Agent", "avatar_url": "..." }
```

Useful when you need an arbitrary `username` / `avatar_url` per
message (e.g. relaying multiple agent identities into one channel) and
don't need to *receive* anything. The adapter does **not** use
webhooks for the primary bot path: webhooks can't read, react, or DM.
Worth keeping in the toolkit for future "fan-out under bot's name with
varying display identities" features.

Source: [Webhook Resource](https://docs.discord.com/developers/resources/webhook).

## 17. Interaction model

Slash commands (`/foo arg`), buttons, select menus, modals, and
context menus are unified under the **interactions** subsystem.
Delivered as `INTERACTION_CREATE` Gateway events (or HTTP POSTs to a
public "interactions endpoint URL" if the bot registers one; the
Gateway path is the default for bots that already hold a connection).

Each interaction has a 3-second initial-response deadline, after which
the bot must call `POST /webhooks/{app.id}/{token}` to deliver a
deferred response.

V1 scope: ignore. The adapter only needs to subscribe to
`MESSAGE_CREATE`-style traffic. Future agent ergonomics
(e.g. `/ask <prompt>` slash command) would extend this. Document so
nobody re-discovers interactions and panics.

Source: [Application Commands](https://docs.discord.com/developers/interactions/application-commands).

## 18. Self-hosting

Discord is fully closed and proprietary. No on-prem option. Contrast
with Matrix (federated, self-hostable Synapse/Dendrite servers) and
Slack Enterprise (cloud-only but tenant-scoped). The adapter has no
"choose your homeserver" knob.

## 19. Library ecosystem (Node.js / TypeScript)

| Library             | Weekly d/l | Notes                                                                                 |
|---------------------|-----------:|---------------------------------------------------------------------------------------|
| `discord.js`        | ~580 k     | The default. Batteries-included. Caches everything by default (RAM-heavy at scale).   |
| `@discordjs/core`   | small      | Thin layer over REST + Gateway by the discord.js team. No managers, no caching. Designed for users who want explicit control. |
| `eris`              | ~3 k       | Lighter, lower-level. Maintenance has slowed; some large bots still prefer it for memory. |

Recommendation for this project: **`@discordjs/core`** plus
`@discordjs/ws` + `@discordjs/rest`. Reasons:

- The daemon already owns its own state — caching guild/channel/user
  trees in the library would duplicate `account_registrations` and
  `conversations` and risk drift.
- `@discordjs/core` does not auto-fetch, auto-cache, or auto-retry —
  it surfaces raw events and surfaces REST 429 / Gateway close codes
  for the adapter to handle in line with the invariants.
- TypeScript types come from `discord-api-types`, the same package
  everyone uses; ergonomics are good.

`discord.js` proper is fine for a quick spike but its `Client` /
`ClientUser` / `Guild` / `Channel` cache managers will fight the
daemon's *conversations are inventory, not routing rules* invariant
because they conflate "I have a cached `Channel` object" with "I know
how to route to this channel."

Sources: [@discordjs/core npm](https://www.npmjs.com/package/@discordjs/core),
[discord.js GitHub](https://github.com/discordjs/discord.js),
[eris GitHub](https://github.com/abalabahaha/eris).

## 20. Failure modes / gotchas

| Failure                                              | Surface                                       | Mitigation                                       |
|------------------------------------------------------|-----------------------------------------------|--------------------------------------------------|
| Second IDENTIFY for same token                       | Close code 4005 on the offending socket       | Bus invariant already enforces single owner; assert at adapter boot |
| `MESSAGE_CONTENT` not approved → empty `content`     | Silently empty `content` / `attachments`      | Probe: send self a test DM at boot; assert content non-empty |
| Resume sent to bootstrap URL instead of `resume_gateway_url` | Resume fails, fresh identify burns budget | Always cache `resume_gateway_url` from READY     |
| Missed heartbeat ACK                                 | Dead socket appears alive                     | Track ACKs; 2 misses → force close + resume      |
| CDN URL expired before forward                       | 404 when fetching attachment                  | Download eagerly on inbound; content-address by sha256 |
| Token regenerated externally                         | 4004 on next connect                          | Surface as auth error to bus; mark registration unusable |
| Bot in >100 guilds without verification              | Privileged intents revoked → 4014             | Out of V1 scope; document for future scaling     |
| Sharding required (>2500 guilds)                     | Bootstrap `shards > 1`                        | Out of V1 scope; assert == 1 with warning        |
| Bot-to-bot loops                                     | `MESSAGE_CREATE` for the bot's own bridged messages | Enforce hop count + recently-seen dedupe + foreign-bot policy from invariants |
| `bot` flag not set on application user               | 2FA / verification prompts on REST calls      | Always create application with Bot user enabled in portal |

## 21. Comparison: Discord → Telegram → core CommAdapter

| Concept                          | Discord                              | Telegram                             | Core `CommAdapter` type             |
|----------------------------------|--------------------------------------|--------------------------------------|-------------------------------------|
| Identity probe                   | `GET /users/@me` + READY.d.user      | `getMe`                              | `BotIdentity { bot_user_id, display_name }` |
| Auth header                      | `Authorization: Bot <token>`         | URL path `/bot<token>/...`           | adapter-private                     |
| Inbound transport                | WSS Gateway only                     | long-poll `getUpdates` or webhook    | adapter-private                     |
| 1:1 chat                         | DM channel (type 1)                  | private chat (`chat.type=private`)   | `ChatRef { kind: 'dm', id }`        |
| Group chat                       | Guild text channel (type 0)          | group / supergroup                   | `ChatRef { kind: 'channel', id, guild_id? }` |
| Sub-thread                       | Thread (types 10/11/12) — own channel id | `message_thread_id` under one chat | `ChatRef { kind: 'thread', id, parent_id }` |
| Platform message id              | snowflake (64-bit)                   | `message_id` (int, per chat)         | `platform_message_id: string`       |
| Reply                            | `message_reference.message_id`       | `reply_to_message.message_id`        | `ReplyRef { platform_message_id }`  |
| Attachment reference             | CDN URL with `?ex=&is=&hm=` (expires)| `file_id` (server-side blob ref)     | `Attachment { sha256, filename, mime }` (content-addressed locally) |
| Sender                           | `author { id, username, global_name, bot }` | `from { id, username, first_name }` | `SenderRef { external_user_id, display_name, is_bot }` |
| Edit event                       | `MESSAGE_UPDATE`                     | `edited_message` update              | `InboundMessage { edit_of }`        |
| Delete event                     | `MESSAGE_DELETE` / `_BULK`           | (not exposed for bots)               | `InboundDelete { platform_message_id }` |
| Reaction event                   | `MESSAGE_REACTION_ADD/REMOVE`        | `message_reaction` update            | `InboundReaction { emoji, user, message_id }` |
| Single-owner enforcement (platform side) | 4005 on second IDENTIFY      | 409 Conflict on second `getUpdates`  | `account_registrations UNIQUE(comm, bot_user_id)` |
| Rate limit surface               | per-route buckets + 50 req/s global  | global 30 msg/s, per-chat 1 msg/s    | `BackpressureSignal { retry_after_ms }` |

The shape lines up cleanly: Discord's *thread is a full channel*
choice means the adapter does **not** need a sub-id alongside
`ChatRef.id` for threads (unlike Telegram). The CDN-URL-expiry quirk
is the one place Discord is materially harder than Telegram —
Telegram's `file_id` is a permanent server-side handle, Discord's URL
is a signed, time-bounded blob link that has to be downloaded on
arrival.
