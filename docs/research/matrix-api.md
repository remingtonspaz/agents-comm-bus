> Researched 2026-05-18. References target [Matrix CS API v1.12](https://spec.matrix.org/v1.12/client-server-api/) (current stable as of writing).

# Matrix API research for `MatrixAdapter`

This is the protocol-level research backing the design of a `CommAdapter`
for Matrix in `agents-comm-bus`. Topics map to the
[`CommAdapter` invariants](../architecture/invariants.md) — single ownership
per `(comm, bot_user_id)`, identity probe at startup, routable inbound
envelopes, idempotent outbound, etc.

The end-user setup walkthrough is in
[matrix-setup-guide.md](./matrix-setup-guide.md).

## 1. Protocol overview

Matrix has three distinct APIs. The adapter uses exactly one.

| API | Spec | Used by | Suitable for adapter? |
|---|---|---|---|
| Client-Server (CS) | [v1.12](https://spec.matrix.org/v1.12/client-server-api/) | All clients, bots | **Yes** |
| Application Service (AS) | [v1.12](https://spec.matrix.org/v1.12/application-service-api/) | Bridges, namespace owners | No — requires homeserver-side registration |
| Server-Server (S2S) | [v1.12](https://spec.matrix.org/v1.12/server-server-api/) | Federation between homeservers | No — homeserver internals |

The adapter is a **CS API client** authenticated with an access token, no
different from any human user's chat client. Matrix has no separate "bot"
account class — a bot is a regular user with a bearer token (see §12).

## 2. Authentication

Login: [`POST /_matrix/client/v3/login`](https://spec.matrix.org/v1.12/client-server-api/#post_matrixclientv3login).

Request (`m.login.password`):
```json
{
  "type": "m.login.password",
  "identifier": { "type": "m.id.user", "user": "agents-comm-bot" },
  "password": "...",
  "initial_device_display_name": "agents-comm-bus"
}
```

Response:
```json
{
  "access_token": "syt_...",
  "device_id": "GHTYAJCE",
  "expires_in_ms": 60000,
  "refresh_token": "def456",
  "user_id": "@agents-comm-bot:matrix.org",
  "well_known": { "m.homeserver": { "base_url": "https://matrix.org" } }
}
```

**Token lifetime.** The spec deliberately
[treats access tokens as opaque](https://spec.matrix.org/v1.12/client-server-api/#using-access-tokens)
and "does not mandate a particular format." `expires_in_ms` is optional;
homeservers may issue non-expiring tokens (Synapse default) or short-lived
tokens with refresh (recommended by spec). Adapter must handle both: cache
`expires_in_ms` if present, refresh proactively, fall back to re-login on
failure.

**Refresh.** [`POST /_matrix/client/v3/refresh`](https://spec.matrix.org/v1.12/client-server-api/#post_matrixclientv3refresh)
with `{ "refresh_token": "..." }` returns a new `access_token` and may
return a new `refresh_token` (the old one is then invalidated).

**Revocation.** No revocation endpoint exists from the client side beyond
logout. `POST /_matrix/client/v3/logout` invalidates the current device's
token; `POST /_matrix/client/v3/logout/all` invalidates every device.
Admins on the homeserver can revoke server-side. **Implication:** if the
human operator logs the bot account out of any session, the daemon's token
dies — see [failure modes](#17-failure-modes--gotchas).

**Device ID.** Every token is bound to a device. The homeserver
auto-generates one if omitted at login. Pinning a stable `device_id` at
login keeps the same E2EE identity across daemon restarts; otherwise each
relogin spawns a new device row, leaving zombies on the account.

## 3. Homeservers and identity

User IDs are [`@localpart:server.tld`](https://spec.matrix.org/v1.12/appendices/#user-identifiers).
The server suffix is the user's *homeserver*; the homeserver is the
authoritative store of the account's events and the federation endpoint
other servers contact to talk to them.

A bot account `@agents-comm-bot:example.org` is bound to `example.org`. To
talk to a user `@alice:matrix.org`, federation between `example.org` and
`matrix.org` must succeed. Federation can be partial — some homeservers
block specific others — and is invisible to the client beyond an event
simply not arriving.

**Self-hosting vs `matrix.org`.** For the adapter, both work. `matrix.org`
is free and zero-ops but rate-limited and shared. Self-hosting (Synapse,
Dendrite, Conduit; see §15) gives full control and no rate-limit fights but
adds ops burden.

## 4. Connection model: `/sync`

Inbound delivery is via [`GET /_matrix/client/v3/sync`](https://spec.matrix.org/v1.12/client-server-api/#get_matrixclientv3sync),
a long-poll that returns when new events arrive or `timeout` expires.

```
GET /_matrix/client/v3/sync?since=<next_batch>&timeout=30000&filter=<filter_id>
Authorization: Bearer <token>
```

Response (abridged):
```json
{
  "next_batch": "s72595_4483_1934",
  "rooms": {
    "join": {
      "!abc:matrix.org": {
        "timeline": {
          "events": [ /* m.room.message etc. */ ],
          "limited": false,
          "prev_batch": "s72594_4483_1934"
        },
        "state": { "events": [] },
        "ephemeral": { "events": [] }
      }
    },
    "invite": { "!xyz:matrix.org": { "invite_state": { "events": [] } } },
    "leave": {}
  },
  "presence": { "events": [] },
  "account_data": { "events": [] }
}
```

The loop is: first call with no `since` returns the initial snapshot, every
subsequent call passes the previous `next_batch` as `since`. The initial
sync can be **enormous** for a long-lived account in many rooms — use a
filter (see below) and/or `full_state=false`.

**Filters.** [`POST /_matrix/client/v3/user/{userId}/filter`](https://spec.matrix.org/v1.12/client-server-api/#post_matrixclientv3useruseridfilter)
creates a server-side filter, returns a `filter_id`, used as the `filter`
query param on `/sync`. A bot-shaped filter trims presence, typing, and
old state to reduce sync payload size.

**Comparison to Telegram `getUpdates`.** Both are long-poll. Crucial
difference: Telegram only permits **one** active poller per bot token (a
second one gets [`409 Conflict`](https://core.telegram.org/bots/faq#why-am-i-getting-409-conflict)
when using `getUpdates`). Matrix `/sync` has no such constraint — multiple
devices on the same account sync independently and each gets every event.
The `since` token is per-call, not per-device.

**Single-ownership implication.** Multiple `/sync` clients on the same
account do *not* steal events from each other (unlike Telegram). However,
the adapter still needs the
[*one comm owner per `(comm, bot_user_id)`*](../architecture/invariants.md)
invariant for routing reasons — two daemons running against the same
account would double-process every inbound event and race on outbound
deduping. Enforcement is at the registration table, not at the protocol.

## 5. Identity probe: `/account/whoami`

[`GET /_matrix/client/v3/account/whoami`](https://spec.matrix.org/v1.12/client-server-api/#get_matrixclientv3accountwhoami)
is the `getMe` analog. Returns:

```json
{
  "user_id": "@agents-comm-bot:matrix.org",
  "device_id": "GHTYAJCE",
  "is_guest": false
}
```

- `device_id` was added in [MSC2033](https://github.com/matrix-org/matrix-spec-proposals/pull/2033)
  and serves double duty as a token-validity check.
- `is_guest` ([MSC3069](https://github.com/matrix-org/matrix-spec-proposals/pull/3069))
  flags guest accounts; the daemon should refuse to register one.

The canonical `bot_user_id` in `account_registrations` is the full MXID
(`@agents-comm-bot:matrix.org`). The adapter probes whoami at connect time
and refuses to start if the response doesn't match the registered MXID
(token rotation / wrong account).

## 6. Receiving messages

The interesting event type is `m.room.message`, surfaced inside
`rooms.join.{room_id}.timeline.events`:

```json
{
  "type": "m.room.message",
  "event_id": "$abc:matrix.org",
  "sender": "@alice:matrix.org",
  "origin_server_ts": 1717000000000,
  "room_id": "!room:matrix.org",
  "content": {
    "msgtype": "m.text",
    "body": "hello bot"
  }
}
```

`msgtype` values ([CS API §11.2.1.7](https://spec.matrix.org/v1.12/client-server-api/#mroommessage-msgtypes)):
`m.text`, `m.emote`, `m.notice`, `m.image`, `m.file`, `m.audio`, `m.video`,
`m.location`, `m.key.verification.request`.

### Edits — `m.replace`

A message edit is a new event whose `m.relates_to` carries
`rel_type: "m.replace"`:

```json
{
  "type": "m.room.message",
  "content": {
    "msgtype": "m.text",
    "body": "* edited body",
    "m.new_content": { "msgtype": "m.text", "body": "edited body" },
    "m.relates_to": { "rel_type": "m.replace", "event_id": "$original" }
  }
}
```

The top-level `body` is a fallback for unthreaded/legacy clients; the real
new content is `m.new_content`. The adapter should map this to its core
"edit" envelope keyed on the *original* `event_id`.

### Deletes — redactions

[`PUT /_matrix/client/v3/rooms/{roomId}/redact/{eventId}/{txnId}`](https://spec.matrix.org/v1.12/client-server-api/#put_matrixclientv3roomsroomidredacteventidtxnid)
with optional `{ "reason": "..." }`. The redaction itself is an event of
type `m.room.redaction`; receiving clients see it in `/sync` and should
treat the redacted event's content as removed.

## 7. Sending messages

[`PUT /_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}`](https://spec.matrix.org/v1.12/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid)

```
PUT /_matrix/client/v3/rooms/!room:matrix.org/send/m.room.message/agents-comm-bus-7
Authorization: Bearer <token>
Content-Type: application/json

{ "msgtype": "m.text", "body": "hello" }
```

Response: `{ "event_id": "$abc:matrix.org" }`.

**Idempotency.** `txnId` is the client's idempotency key. The spec
guarantees that a retry with the same `(path, txnId)` does not double-send.
This is well-suited to the bus's "exactly-once outbound" requirement —
the adapter picks `txnId = <outbound-record-id>` and can retry freely.

**Markdown / HTML.** Native body is plain text. Rich text uses two
parallel fields, per [CS API §11.2.1.6](https://spec.matrix.org/v1.12/client-server-api/#mroommessage-msgtypes):

```json
{
  "msgtype": "m.text",
  "body": "**hello**",
  "format": "org.matrix.custom.html",
  "formatted_body": "<strong>hello</strong>"
}
```

Only a [restricted HTML subset](https://spec.matrix.org/v1.12/client-server-api/#mroommessage-msgtypes)
is allowed. The adapter must sanitize before sending.

## 8. Chat model: rooms

Everything is a room. There is no DM type at the protocol level — a "DM"
is a 2-member room flagged via `m.direct` account_data on each side. From
the adapter's standpoint, every conversation is a `(room_id)` pair.

| Concept | Form |
|---|---|
| Room ID (internal, stable) | `!opaqueId:server.tld` |
| Room alias (human, mutable) | `#name:server.tld` |
| User ID | `@localpart:server.tld` |

[`m.room.member`](https://spec.matrix.org/v1.12/client-server-api/#mroommember)
events carry membership transitions: `invite`, `join`, `leave`, `ban`,
`knock`. The adapter must observe `invite` events to accept (or reject) bot
invitations: [`POST /_matrix/client/v3/rooms/{roomId}/join`](https://spec.matrix.org/v1.12/client-server-api/#post_matrixclientv3roomsroomidjoin).

Encrypted rooms have a `m.room.encryption` state event. **The adapter
detects this at room-join time and either declines or downgrades to
"opaque event" mode** (see §11).

## 9. Threads

The [`m.thread`](https://spec.matrix.org/v1.12/client-server-api/#threading)
relation:

```json
"m.relates_to": {
  "rel_type": "m.thread",
  "event_id": "$thread-root-event-id",
  "is_falling_back": true,
  "m.in_reply_to": { "event_id": "$last-event-in-thread" }
}
```

`is_falling_back: true` tells thread-aware clients to *ignore* the
embedded `m.in_reply_to` as a real reply — it exists only so non-threaded
clients still render the event as a reply to the latest in-thread message.

Comparable to Slack threads: a root event plus relations pointing to it.
**Inbound envelope mapping:** the adapter exposes a `ThreadRef` carrying
the thread-root `event_id`; replies set `m.relates_to.rel_type =
"m.thread"` automatically. Root-level messages have no `m.relates_to`.

## 10. Attachments / media

[Content repository](https://spec.matrix.org/v1.12/client-server-api/#content-repository)
endpoints, version `v3` for upload, `v1` for the authenticated download
endpoints introduced in v1.11.

Upload: [`POST /_matrix/media/v3/upload`](https://spec.matrix.org/v1.12/client-server-api/#post_matrixmediav3upload)
with raw bytes as body, `Content-Type` set to the file's actual mimetype.
Response: `{ "content_uri": "mxc://example.org/abc123" }`.

The returned `mxc://server/mediaId` URI is then embedded in an
`m.room.message` event:

```json
{
  "msgtype": "m.image",
  "body": "screenshot.png",
  "url": "mxc://example.org/abc123",
  "info": { "mimetype": "image/png", "size": 102400, "w": 1920, "h": 1080 }
}
```

Download (authenticated, v1.11+):
[`GET /_matrix/client/v1/media/download/{serverName}/{mediaId}`](https://spec.matrix.org/v1.12/client-server-api/#get_matrixclientv1mediadownloadservernamemediaid).
The older unauthenticated `/_matrix/media/v3/download/...` is deprecated as
of [v1.11](https://spec.matrix.org/v1.12/changelog/#authenticated-media).
Thumbnails: [`GET /_matrix/client/v1/media/thumbnail/...`](https://spec.matrix.org/v1.12/client-server-api/#get_matrixclientv1mediathumbnailservernamemediaid).

Per-server size limits: returned by [`GET /_matrix/client/v1/media/config`](https://spec.matrix.org/v1.12/client-server-api/#get_matrixclientv1mediaconfig).
`matrix.org` is typically 50 MiB.

## 11. End-to-end encryption

This is the genuinely hard part of the adapter.

[E2EE](https://spec.matrix.org/v1.12/client-server-api/#end-to-end-encryption)
is optional at the protocol level but is enabled by default in Element for
new private rooms. Two algorithms:

- **Olm** (`m.olm.v1.curve25519-aes-sha2`) — 1:1 device-to-device.
- **Megolm** (`m.megolm.v1.aes-sha2`) — group ratchet, per-room.

To participate in an encrypted room, a client must: upload identity +
one-time keys, fetch other members' device keys, decrypt Megolm session
keys delivered via Olm in `to_device` messages, persist key state across
restarts, and ideally implement cross-signing for trust. Missing any of
this means the bot sees `m.room.encrypted` events it cannot decrypt.

**V1 adapter decision.** Do **not** implement E2EE in V1. The adapter
will:

1. Inspect the `m.room.encryption` state event when joining a room.
2. If encryption is enabled, log an audit entry and either decline the
   invite or remain in the room as a no-op (configurable).
3. Surface a clear error to the operator if they invite the bot to an
   encrypted room.

When E2EE eventually lands, the cleanest path is to back the adapter with
[`matrix-bot-sdk`](https://github.com/turt2live/matrix-bot-sdk) using its
[`RustSdkCryptoStorageProvider`](https://turt2live.github.io/matrix-bot-sdk/tutorial-encryption.html),
which delegates Megolm/Olm to the Rust [`matrix-sdk-crypto`](https://crates.io/crates/matrix-sdk-crypto)
crate via FFI. Rolling our own is not justified.

## 12. Bot-to-bot delivery

Confirmed: **Matrix has no protocol-level concept of "bot user"**. Every
account is a `@user:server` MXID with one or more access tokens. Two bot
accounts in the same room each receive each other's `m.room.message`
events through their own `/sync` loops. No `bot_message` discriminator
exists at the spec level; the only marker is whatever the sender chose to
put in `msgtype` (`m.notice` is *conventionally* used for bot-generated
content but is not enforced).

Contrast with the prior comm-platform investigation:

- **Telegram** — bots can now receive each other's messages as of
  [2026-05-19](https://core.telegram.org/bots/features#bot-to-bot-communication),
  **opt-in via BotFather** ("Bot-to-Bot Communication Mode" toggle
  must be enabled on both the sender and receiver). DMs via
  `sendMessage` with `@username`; group via `/cmd@OtherBot` mentions
  or replies. Telegram does NOT enforce loop prevention — that's the
  developer's responsibility. Inbound envelope marker for
  bot-authored messages [TBD pending test, likely `from.is_bot`].
  Updated 2026-05-19 — was a hard restriction prior to this date.
- **Discord** — bots filter other bots by convention in the SDK; the
  gateway delivers the events regardless.
- **Slack** — `bot_message` event type fires for bot-originated messages.
- **Matrix** — no distinction. `sender` is just an MXID.

**Adapter implication.** Matrix natively supports the multi-agent fanout
the bus is built for. The `foreign-bot-policy` invariant
(see [invariants](../architecture/invariants.md)) is enforced entirely on
the bus side — Matrix delivers everything, the bus decides whether to
route it.

## 13. Reactions

`m.reaction` events with an `m.annotation` relation:

```json
{
  "type": "m.reaction",
  "content": {
    "m.relates_to": {
      "rel_type": "m.annotation",
      "event_id": "$target",
      "key": "👍"
    }
  }
}
```

Aggregated server-side. Inbound only in V1 — the adapter surfaces incoming
reactions as a separate envelope type but does not send reactions itself.

## 14. Rate limits

429 with [`M_LIMIT_EXCEEDED`](https://spec.matrix.org/v1.12/client-server-api/#rate-limiting):

```json
{
  "errcode": "M_LIMIT_EXCEEDED",
  "error": "Too many requests",
  "retry_after_ms": 2000
}
```

`retry_after_ms` was deprecated in v1.10 in favor of the `Retry-After`
HTTP header. The adapter should honor *both* (header first, body fallback)
for compatibility with older homeservers.

Limits are per-homeserver and not configurable by clients. `matrix.org`
enforces conservative limits aimed at humans; self-hosted Synapse defaults
are much higher and tunable in `homeserver.yaml` under
[`rc_message`](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#ratelimiting).

The adapter should implement a token-bucket pre-emptive limiter and a
retry-with-backoff path on 429.

## 15. Self-hosting

Three production homeserver implementations:

| Server | Language | Maintainer | Status |
|---|---|---|---|
| [Synapse](https://github.com/element-hq/synapse) | Python | Element | Reference, feature-complete |
| [Dendrite](https://github.com/element-hq/dendrite) | Go | Element | Beta, lighter weight |
| [Conduit](https://gitlab.com/famedly/conduit) / [conduwuit](https://github.com/girlbossceo/conduwuit) | Rust | Community | Single-binary, minimal ops |

Notable: Matrix.org Foundation [transferred Synapse to Element](https://matrix.org/blog/2023/11/06/the-future-of-synapse-dendrite/)
in late 2023 and archived the original repo in April 2024. Current canonical
location is [`element-hq/synapse`](https://github.com/element-hq/synapse).
Install docs: [element-hq.github.io/synapse/latest/setup/installation.html](https://element-hq.github.io/synapse/latest/setup/installation.html).

For the daemon use case, a single-user Synapse via Docker on the same host
is plausible and removes the `matrix.org` rate-limit problem entirely.
Conduit is also attractive for the same use case due to its single-binary
deployment.

## 16. Library choice (Node.js / TypeScript)

Two candidates:

| | [`matrix-bot-sdk`](https://github.com/turt2live/matrix-bot-sdk) | [`matrix-js-sdk`](https://github.com/matrix-org/matrix-js-sdk) |
|---|---|---|
| Maintainer | turt2live (community, Element-adjacent) | Element (official) |
| Target | Node.js bots | Element Web + general clients |
| Latest | v0.8.0, Jan 2026 | Actively maintained |
| Size | ~3 MB | ~10 MB (browser-oriented) |
| E2EE | Optional, via Rust crypto FFI | Built-in |
| API shape | Imperative, bot-shaped (`on('room.message')`) | Object model (Rooms, Members, Timelines) |
| License | MIT | Apache-2.0 |

**Pick: `matrix-bot-sdk`.** Its surface area matches the adapter's needs
(connect, sync loop, send, react to events) and its E2EE story is opt-in
rather than baked in. `matrix-js-sdk` is correct but heavier and assumes
a richer client model than the adapter wants.

Minimal shape:

```javascript
import { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin } from "matrix-bot-sdk";

const storage = new SimpleFsStorageProvider("./storage");
const client = new MatrixClient("https://matrix.org", "syt_...", storage);
AutojoinRoomsMixin.setupOnClient(client);
client.on("room.message", (roomId, event) => { /* envelope-ify */ });
await client.start();
```

`SimpleFsStorageProvider` persists the `next_batch` sync token across
restarts — the equivalent of a Telegram `offset`. This goes under the
daemon's per-comm state directory, not under any plugin install path
([state-path-isolation invariant](../architecture/invariants.md)).

## 17. Failure modes / gotchas

- **Token revocation by side channel.** Logging out the bot account from
  Element web — easy to do accidentally if the operator used Element to
  grab the token — invalidates the token. Adapter must distinguish a 401
  from a network error and surface it loudly.
- **Homeserver downtime.** `/sync` hangs forever, then times out, then
  returns 5xx. Adapter needs exponential backoff and never re-runs the
  initial-sync path if it has a valid `next_batch` cached.
- **Lagging sync.** A burst of activity can make `/sync` `timeline.limited
  = true`, meaning events were dropped from the response. Adapter must
  follow `prev_batch` via [`/rooms/{roomId}/messages`](https://spec.matrix.org/v1.12/client-server-api/#get_matrixclientv3roomsroomidmessages)
  to backfill or accept the loss.
- **Initial sync size.** For a bot account in many rooms, the very first
  `/sync` response is huge. Use a `limit: 1` timeline filter at first
  start; the bus only cares about *new* messages, not history.
- **Encrypted room invites.** If a user invites the bot to an encrypted
  room, the adapter sees the invite via `/sync` rooms.invite. V1 logs and
  declines.
- **Sync filter design.** A minimal bot filter excludes presence, typing,
  receipts, account_data, and old state. See
  [CS API §6.2](https://spec.matrix.org/v1.12/client-server-api/#filtering).
- **`txnId` reuse across restarts.** `txnId` must be stable for true
  idempotency. Generate from a persistent counter (outbound record ID), not
  from `Date.now()`. After a crash, the same `txnId` retried produces no
  duplicate event.
- **`m.notice` vs `m.text`.** Some bot ecosystems use `m.notice` for all
  bot output to suppress notification chimes. Adapter exposes both as a
  per-send option.
- **Federation drift.** A message from a federated user can take seconds
  to arrive on the bot's homeserver, and `origin_server_ts` reflects the
  *sender's* server clock. Don't use it for monotonicity; use sync order.

## 18. Concept mapping

Telegram concepts as a reference point; right column is the core
`CommAdapter` type the adapter outputs.

| Matrix | Telegram | Core `CommAdapter` type |
|---|---|---|
| `@user:server` (MXID) | `user.id` (int64) | `ParticipantRef` (string-identified) |
| `!room:server` (room ID) | `chat.id` (int64) | `ChatRef` |
| `#alias:server` (room alias) | (n/a — Telegram has no alias layer) | resolved to `ChatRef` |
| `m.thread` relation | `reply_to_message` (sort of) | `ThreadRef` |
| `event_id` (`$abc:server`) | `message_id` (int) | `PlatformMessageId` |
| `mxc://server/id` | `file_id` | `Attachment` |
| `m.room.encryption` state | (n/a) | encrypted-flag on `ChatRef`, V1: refuse |
| `m.room.message` `m.replace` | `editMessageText` event | `EditMarker` on inbound envelope |
| `m.room.redaction` | `deleteMessage` event | `DeleteMarker` |
| `m.reaction` / `m.annotation` | `MessageReactionUpdated` | `ReactionEvent` |
| `/_matrix/client/v3/sync` long-poll | `getUpdates` long-poll | adapter-internal |
| `txnId` on PUT send | `business_connection_id` (no real analog) | outbound idempotency key |
| Bearer access token | bot token | adapter credentials |
| `@bot:server` is a user account | bot has separate account class | adapter sees no special "bot" type |
| 429 `M_LIMIT_EXCEEDED` | 429 with `retry_after` | back-pressure signal |
