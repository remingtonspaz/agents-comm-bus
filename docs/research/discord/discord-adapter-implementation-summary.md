# Discord adapter implementation summary

Date: 2026-06-06
Primary sources:

- [Bus contract touchpoints](./bus-contract-touchpoints.md) — repository analysis of the existing comm adapter contract, daemon integration points, Telegram reference implementation, and core bus invariants.
- [Discord platform reference](./structured/discord-adapter-reference.md) — structured notes from official Discord API docs, with raw docs cached in [raw-notes](./raw-notes/INDEX.md).
- [Discord library comparison](./discordjs_comparison.md) and [comparison matrix](./comparison_matrix.json) — library selection research for discord.js, Oceanic, Detritus, and Eris.
- Existing cross-platform background: [../discord-api.md](../discord-api.md) and [../README.md](../README.md).

## Recommendation

Build a first-party `discord` comm adapter as a dynamically loaded `CommAdapterFactory` plus `CommAdapter`, mirroring the Telegram adapter packaging shape while keeping Discord-specific complexity inside the adapter. The core `MessageBus` does not need a Discord-specific routing model for V1: use the existing `ChatRef` shape with `chat_native_id = Discord channel id`. For Discord threads, treat the thread id as the channel id because Discord threads are first-class channels.

Use the Discord.js monorepo packages, not necessarily the full `discord.js` client, as the default implementation path:

- `@discordjs/rest` for REST send, edit, upload, and identity probe calls.
- `@discordjs/ws` for Gateway lifecycle, heartbeats, resume, and sharding support.
- `@discordjs/core` and possibly `@discordjs/builders` for typed API objects and optional button/component support.

This gives the project the maturity, docs, and production track record of Discord.js while avoiding a heavyweight cache-first `Client` when the bus only needs normalized messages, REST sends, and optional components.

Oceanic is a credible fallback if dependency size becomes a hard constraint. Detritus should not be selected for new work because its npm releases are stale. Eris is serviceable but weaker for this TypeScript-first adapter because it relies on community types and has sparse releases.

## How the adapter interfaces with the existing core bus contract

The adapter belongs only on the comm side of the bus. It should not wake agents directly, choose target sessions directly, or own query semantics. Those responsibilities remain in `MessageBus` and the agent bridges.

Expected integration points from [bus-contract-touchpoints.md](./bus-contract-touchpoints.md):

1. Add `adapters/discord/factory.ts` exporting `createCommAdapterFactory()`.
2. Return a `CommAdapterFactory` with `commId = "discord"`.
3. Resolve credentials from `account_registrations.credentials_ref`, preferably the existing `file:` credential pattern.
4. Probe identity with Discord REST `GET /users/@me` using `Authorization: Bot ...`; store the returned Discord user id as `bot_user_id`.
5. Construct a `DiscordCommAdapter` with token, bot user id, allowlist data, blob store, clock and network seams for tests, and any Gateway/REST clients.
6. Let `runDaemon()` lazily instantiate the adapter when a session has a Discord account registration.
7. Let `bus.registerComm(adapter)` wire inbound, connection state, and filter-drop callbacks.
8. Let `MessageBus.receiveInbound()` handle dedupe, foreign-bot policy, account lookup, conversation upsert, transcript and audit writes, text-query resolution, pending inbound enqueue, and agent wake dispatch.
9. Let `MessageBus.send()` resolve default or explicit targets and call `adapter.send()`.

The current `ChatRef` is sufficient for V1:

| Core field | Discord mapping |
|---|---|
| `chat.comm` | `"discord"` |
| `chat.account` | concrete bot user id from `GET /users/@me` or Gateway `READY` |
| `chat.chat_native_id` | Discord `channel_id`; for thread messages, the thread channel id |
| `chat.thread_native_id` | omit for V1 unless a future schema explicitly stores parent-channel/thread pairs |
| `message_id` | `discord:${message.id}` |
| `platform_message_id` | raw Discord message id |
| `sender.id` | `author.id` |
| `sender.display_name` | `author.global_name`, then member nickname, then username |
| `sender.isBot` | `author.bot === true` |
| `sender.isForeignBot` | bot author and author id is not this adapter's bot user id |
| `text` | Discord `content`, when available |
| `attachments` | Discord attachments downloaded into the bus blob store |
| `reply_to` | referenced message id when present |

Do not smuggle `guild_id`, parent channel id, channel name, or thread metadata into `ChatRef`. If implementation needs those for display or permission diagnostics, store them in conversation metadata or attachment/platform metadata, or propose a schema extension after V1.

## Likely adapter architecture and responsibilities

A practical implementation should split into a factory, adapter, Gateway client wrapper, REST client wrapper, normalizer, and test fakes.

Suggested file set:

- `adapters/discord/version.ts`
- `adapters/discord/factory.ts`
- `adapters/discord/adapter.ts`
- `adapters/discord/gateway.ts` or a thin wrapper around `@discordjs/ws`
- `adapters/discord/rest.ts` or a thin wrapper around `@discordjs/rest`
- `adapters/discord/normalize.ts`
- `tests/architecture/discord-comm-adapter.test.ts`
- `tests/architecture/discord-factory.test.ts`
- optional `tests/architecture/discord-send-target.test.ts` if a Discord-specific IPC send method is added

Factory responsibilities:

- Define `commId = "discord"`.
- Resolve bot token and allowlist settings from `credentials_ref` and daemon context.
- Keep secrets out of account rows; rows should reference secrets, not contain them.
- Probe identity with `GET /users/@me` and return the concrete Discord bot user id.
- Create adapters with injectable clock, fetch, WebSocket, REST, blob store, state root, and logger seams.
- Optionally contribute Discord-specific IPC methods such as `discord_send` or `discord_send_file`, but prefer the generic `comm_send_message` surface unless product ergonomics require named compatibility methods.

Adapter responsibilities:

- `start()` opens the Gateway connection, identifies or resumes, starts heartbeats, subscribes to `MESSAGE_CREATE`, tracks connection state, and emits bus-visible state changes.
- `stop()` closes Gateway/REST resources and must be safe even after partial startup failure.
- `exclusiveResource()` should return the concrete bot account id so the daemon lease prevents two live owners for the same token.
- Inbound path should normalize `MESSAGE_CREATE` to core `Message`, enforce adapter-level sender allowlists, emit `FilterDropEvent` for drops, and pass accepted messages to the bus inbound handler.
- Outbound path should implement idempotent `send()` and call `POST /channels/{channel_id}/messages` for text, replies, and multipart attachments.
- Attachment handling should eagerly download inbound Discord CDN URLs into the bus `BlobStore`; signed Discord CDN URLs are not durable.
- Failure classification should map Discord REST and Gateway failures into permanent, transient, and rate-limited categories for daemon observability.
- `reportPressure()` should reflect REST bucket pressure and Gateway health once those metrics exist.

## Inbound and outbound flows

Inbound flow:

1. Agent bridge registers or touches a session.
2. The daemon ensures comms for that session and finds `comm = "discord"` account registrations.
3. The factory resolves credentials and creates the adapter.
4. The daemon registers and starts the adapter.
5. Discord Gateway dispatches `MESSAGE_CREATE`.
6. The adapter applies allowlist filtering and normalizes the event to a core `Message`.
7. The bus dedupes by `comm`, `account`, and `message_id`; applies foreign-bot policy; upserts the conversation; writes transcript and audit rows; resolves matching text replies to open queries; enqueues normal inbound; and invokes the relevant bridge wake path.
8. The agent bridge drains pending inbound with session/account scoping.

Outbound flow:

1. Agent uses generic MCP/IPC send, or an optional Discord-specific IPC method.
2. The bus resolves the target from the most recent session conversation or an explicit `ChatRef`.
3. The target account must be the concrete Discord bot user id, not a human label.
4. The bus finds the live `(comm="discord", accountId)` adapter and calls `adapter.send(target, payload, idempotencyKey)`.
5. Adapter posts to Discord REST using `target.chat_native_id` as the channel id.
6. Adapter returns Discord's message id and timestamp.
7. Bus writes outbound transcript/audit records and updates conversation inventory.

## Discord API and platform constraints that matter

From [structured/discord-adapter-reference.md](./structured/discord-adapter-reference.md):

- Inbound is Gateway-based. REST is for CRUD and outbound sends; it does not deliver spontaneous messages.
- Gateway connections must heartbeat and track the last sequence number for resume.
- Use `RESUME` before fresh `IDENTIFY` whenever possible. Discord has a hard identify budget, and bad reconnect loops can burn it.
- `GET /gateway/bot` returns recommended shard count and session start limits.
- Sharding becomes mandatory at 2,500 guilds; DMs are routed to shard 0.
- Gateway close codes 4004, 4013, and 4014 are permanent until credentials/intents are fixed. Close code 4008 is rate-limited and needs backoff.
- `MESSAGE_CONTENT` is privileged and is effectively required for a message-forwarding bus. Without it, message `content`, `embeds`, `attachments`, `components`, and polls are empty or omitted.
- Privileged intents must be enabled in the Developer Portal and need approval for verified apps in 100 or more guilds.
- Discord HTTP rate limits are per route plus global. The adapter must parse rate-limit headers and `Retry-After`; do not hardcode limits.
- Interactions and components require an acknowledgement or defer within 3 seconds; deferred responses can be edited later.
- Bots cannot proactively DM users who have not interacted with them.
- Threads are channels with separate membership and archive behavior; sending into an archived thread can unarchive it.
- Gateway payloads have a 4096-byte limit.
- Discord developer policy and ToS prohibit abusive automation and self-botting.

## Library evaluation summary

From [discordjs_comparison.md](./discordjs_comparison.md) and [comparison_matrix.json](./comparison_matrix.json):

| Library | Recommendation | Why |
|---|---|---|
| discord.js | Primary | Best documentation, largest ecosystem, active maintenance, full Gateway and REST coverage, strong TypeScript definitions, component builders, and modular packages for lighter adapter builds. |
| Oceanic | Secondary | Lightweight, TypeScript-native, low dependency count, and active enough; smaller community and fatal unhandled `error` event behavior add operational risk. |
| Eris | Tertiary | Minimal and lower-level with full Gateway/REST coverage; weaker TypeScript story and sparse release cadence. |
| Detritus | Avoid | No npm release since 2021 despite GitHub activity; relying on it would create dependency-management risk. |

Implementation choice should start with the modular Discord.js packages. A small spike should validate that `@discordjs/ws` plus `@discordjs/rest` can satisfy message receive/send, reconnect/resume, rate-limit observation, and testability without pulling in the full cached client.

## Pitfalls and caveats

- Message content intent is the top product risk. If unavailable, plain message forwarding cannot work. Consider an interactions-only mode only as a separate product mode, not as a replacement for the adapter's message path.
- Do not filter all `author.bot` messages at the adapter boundary. The bus has foreign-bot policy, dedupe, and hop-count invariants specifically to support multi-agent rooms without loops.
- Disable accidental pings by default on outbound sends with `allowed_mentions: { parse: [], replied_user: false }` unless the payload schema later makes mention behavior explicit.
- Download inbound attachments immediately. Discord CDN links expire and should never be treated as durable transcript references.
- Gateway reconnect code must prefer resume and must avoid identify storms. Treat identify budget as an operational SLO.
- Interaction buttons are plausible but should be V2. The 3-second ACK deadline and custom id encoding limits need design and tests before mapping bus callbacks to Discord components.
- Adapter startup failure should skip that account and leave the daemon alive. `stop()` must tolerate partial startup during rollback.
- `start()` and `stop()` must be idempotent enough for lazy startup, reload, and rollback races.
- Discord REST route buckets should feed `reportPressure()`, especially under bulk sends or attachment uploads.
- Node version matters. Full `discord.js` currently requires Node `>=22.12.0`; subpackages and project runtime constraints should be checked during the implementation spike.
- Avoid raw user-token or self-bot flows. Bot token auth is the only in-scope credential model.

## Open questions for implementation planning

1. Credential shape: should Discord credentials mirror Telegram with a simple JSON file, and exactly which allowlist keys should be supported?
2. Public IPC surface: should Discord expose only generic `comm_send_message`, or also compatibility helpers like `discord_send` and `discord_send_file`?
3. Thread metadata: is `chat_native_id = thread_id` sufficient for all UX/audit cases, or do we need durable parent channel and guild display metadata?
4. Message content fallback: should startup hard-fail, degrade, or warn when `MESSAGE_CONTENT` is missing?
5. Components and callbacks: when should Discord buttons be implemented, and how should callback data be encoded within Discord custom id limits?
6. Attachment policy: what max inbound download size should the adapter enforce, and should oversized downloads produce metadata-only attachments or filter drops?
7. Sharding boundary: is V1 single-shard only with an explicit error at the Discord-recommended shard count greater than 1, or should sharding be implemented from day one?
8. Dependency spike: can modular Discord.js packages provide the required Gateway/REST behavior without pulling in the full cached `Client`?
9. Packaging: which staging/version metadata files need updates so `comm-adapter-loader.ts` can load `discord/factory.js` in installed plugin artifacts?

## Proposed first implementation milestone

For V1, implement plain message receive/send only:

- Factory, identity probe, credential resolution, and loader tests.
- Gateway `MESSAGE_CREATE` handling for guild text channels, DMs, group DMs, and thread channels.
- REST send with safe mentions disabled, reply support, text payloads, and attachment upload.
- Inbound attachment eager download to `BlobStore`.
- Allowlist filtering and `FilterDropEvent` parity with Telegram.
- Error classification for auth, permission, missing intent, rate limit, network, and resumable Gateway close cases.
- Fake Gateway and fake REST test fixtures.

Defer slash commands, HTTP interactions endpoint, Discord components/buttons, message edits/deletes, reactions, voice, advanced sharding, and proactive DM creation until V2 or later.
