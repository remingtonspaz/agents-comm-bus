# Discord adapter bus-contract touchpoints

Date: 2026-06-06
Task: `t_b0bdede9`
Scope: repository analysis only. This document identifies where a Discord comm adapter would plug into the current `agents-comm-bus` architecture and what responsibilities it must satisfy. It complements the platform-level research in `docs/research/discord-api.md`.

## Executive summary

The current bus is already comm-neutral enough for Discord. A Discord implementation should be a first-party comm adapter package that exports `createCommAdapterFactory()` and provides:

1. A `CommAdapterFactory` with `commId = "discord"`, credential resolution from `account_registrations.credentials_ref`, optional identity probe, adapter construction, and an optional Discord-specific IPC/MCP surface.
2. A `CommAdapter` implementation that normalizes Discord Gateway `MESSAGE_CREATE` events into core `Message` envelopes, sends outbound text/files through Discord REST, handles Gateway lifecycle/reconnect/rate limits, and exposes callback-like interaction events only if Discord components are adopted.
3. Packaging/staging integration so the daemon can dynamically load the bundled adapter from the central adapters directory, the same way Telegram is loaded today.

The most important current-contract detail: `ChatRef` is not a rich tagged union. It is `{ comm, account, chat_native_id, thread_native_id? }`. For Discord V1, use `chat_native_id = channel_id`; Discord threads are first-class channels, so they likely also fit as `chat_native_id = thread_id` with no `thread_native_id`. If we need guild/parent-channel metadata, preserve it in `Attachment.platform_metadata`, conversation metadata extensions, or a future ChatRef/schema change rather than smuggling it into the routing key.

## Relevant modules/files reviewed

### Core contracts

- `packages/core-contracts/src/contracts/comm-adapter.ts`
  - Defines the `CommAdapter` runtime contract: identity, lifecycle, inbound/callback handlers, optional filter-drop observability, idempotent send, pressure reporting, and failure classification.
  - Defines `OutboundPayload`, `InlineKeyboardButton`, `CallbackEvent`, `FilterDropEvent`, `SendResult`, and `FailureClassification`.
- `packages/core-contracts/src/messages.ts`
  - Defines the normalized inbound `Message`: schema version, `message_id`, `chat`, `sender`, `origin`, text, attachments, reply pointer, platform id, hop count, and receive timestamp.
- `packages/core-contracts/src/types.ts`
  - Defines branded IDs and the current `ChatRef`, `Attachment`, `Origin`, and `Sender` primitives.
- `packages/core-contracts/src/records/account-registrations.ts`
  - Defines durable account registration rows. Credentials are references only; `bot_user_id` is the concrete platform account id and is unique per `(comm, bot_user_id)`.
- `packages/core-contracts/src/queries.ts`
  - Defines query kinds and resolution records used by agent bridges when permission/choice/freetext prompts are answered via text replies or callbacks.

### Bus and daemon runtime

- `core-daemon/bus.ts`
  - `MessageBus.registerComm()` wires adapter inbound, connection-state, and filter-drop handlers.
  - `receiveInbound()` enforces origin, recently-seen dedupe, foreign-bot policy, account-registration lookup, conversation upsert, transcript/audit writes, text-query resolution, and dispatch enqueue.
  - `send()` resolves session/default target or explicit `ChatRef`, finds the adapter by `(comm, bot_user_id)`, calls `adapter.send()`, then writes transcript/audit records.
  - `resolveQueryFromCallback()` is the adapter-agnostic bridge from button/callback values into query resolution.
- `core-daemon/runtime/comm-factory.ts`
  - Defines `CommAdapterFactory`: credential resolution, optional identity probe, adapter construction, and optional comm-specific IPC method contribution.
- `core-daemon/runtime/comm-adapter-loader.ts`
  - Dynamic adapter loader. It imports `.js` modules or `*/factory.js` under the adapters directory and requires an exported `createCommAdapterFactory()` that returns a valid factory.
- `core-daemon/daemon.ts`
  - `runDaemon()` composes storage, audit/transcripts/blobs, `MessageBus`, agent bridges, IPC methods, lazy comm startup, reloads, and leases.
  - `ensureCommsForSession()` lazily starts only the comm adapters needed by the registering `(project, agent)` session.
  - `addAdapterForRegistration()` is the hot-add sequence: create adapter, `bus.registerComm()`, `bridge.attachComm()`, start adapter, rollback on failure.
  - `reloadAdapters()` reconciles live adapters with account registrations and refreshes allowlists/credentials.
  - `drain_pending_inbound` scopes pending inbound by owned comm accounts so one agent cannot drain another agent's queue.
- `core-daemon/serve.ts`
  - Composition root. Agent bridges are compiled in; comm adapter factories are dynamically loaded from `AGENTS_COMM_BUS_ADAPTERS_DIR`, `$AGENTS_COMM_BUS_BIN/../adapters`, or the state-root adapters folder.
- `core-daemon/runtime/agent-bridge.ts`
  - Defines the agent-side expectations. Comm adapters do not wake agents directly; inbound dispatch goes through the bus and then bridges' `onInboundConversation()` hooks.

### Existing Telegram reference implementation

- `adapters/telegram/factory.ts`
  - Reference `CommAdapterFactory`. It resolves credentials from `file:` refs, merges env/file/DB allowlists, probes identity with `getMe`, constructs `TelegramCommAdapter`, and exposes Telegram-specific IPC methods (`telegram_send`, `telegram_send_image`, `telegram_check_messages`).
- `adapters/telegram/adapter.ts`
  - Reference `CommAdapter`. It starts/stops a platform connection, normalizes Telegram messages and callbacks, filters allowed senders, downloads attachments into the blob store, sends text/documents, supports callback ack/edit, exposes exclusive-resource leasing, and classifies platform failures.
- `tests/architecture/telegram-comm-adapter.test.ts`, `allowlist-factory.test.ts`, `inbound-filter-drop.test.ts`, `telegram-send-target.test.ts`, `comm-adapter-loader.test.ts`, `reload-allowlist-refresh.test.ts`
  - Useful patterns for Discord tests: normalization, allowlist merging, filter-drop audit behavior, send target resolution, loader shape, and runtime allowlist refresh.

### Existing Discord/platform docs

- `docs/research/discord-api.md`
  - Platform constraints: Gateway for inbound, REST for outbound, bot-token auth, Gateway lifecycle, intents, channel/thread mapping, attachments/CDN expiry, rate limits, bot-to-bot delivery, and recommended SDK split (`@discordjs/core` + `@discordjs/ws` + `@discordjs/rest`).
- `docs/architecture/invariants.md`
  - Core invariants the Discord adapter must preserve: one owner per comm account, durable enqueue before wake, deterministic routing by registration, conversations as inventory not routing rules, explicit reply targets, no implicit cross-agent delivery, query semantics, content-addressed attachments, and loop prevention.
- `docs/architecture/proposals/2026-05-18-adapter-modularization.md`
  - Historical proposal; current code has evolved into dynamic comm adapter loading via adapter factory bundles rather than the exact manifest design in the proposal.

## Inferred Discord adapter responsibilities

### Factory responsibilities

A new `adapters/discord/factory.ts` should mirror Telegram's structure but with Discord-specific credentials and identity:

- Export `createCommAdapterFactory(): CommAdapterFactory`.
- Return a factory with `commId = "discord"`.
- `resolveCredentials(registration, env, context)`:
  - Read `registration.credentials_ref` rather than inline secrets.
  - Prefer the existing `file:` credential pattern. A likely JSON shape is `{ "botToken": "...", "allowedUserIds": ["..."] }`, but the CLI/storage format must be decided before implementation.
  - Merge allowlist sources analogous to Telegram if Discord should support env/file/DB allowlists. DB allowlist methods are comm-generic, so rows can be keyed by `comm="discord"`.
- `probeIdentity(credentials)`:
  - Call Discord REST `GET /users/@me` with `Authorization: Bot <token>` and a valid `User-Agent`.
  - Return `accountId = user.id` and a display username/global name.
- `create(credentials, accountId, context)`:
  - Instantiate `DiscordCommAdapter` with token, concrete bot user id, allowlist, blob store, state root, and injectable clock/fetch/WebSocket/REST clients for tests.
- `ipcMethods(deps)`:
  - Optional. The bus already exposes generic `comm_send_message`/`comm_check_messages` through the MCP shim path, but Telegram still contributes legacy `telegram_send` methods. Discord can either provide `discord_send`/`discord_send_file` for parity or stay generic if product requirements do not need comm-specific tools.

### Adapter responsibilities

A `DiscordCommAdapter` must satisfy every required `CommAdapter` method:

- Identity:
  - `id = "discord"`.
  - `accountId = bot_user_id` from `GET /users/@me`/Gateway `READY`.
  - Optional `allowedSenderIds` plus `updateAllowedSenderIds()` for hot allowlist reload.
- Lifecycle:
  - `start()` opens the Discord Gateway connection, identifies/resumes, records bot identity, subscribes to message events, starts heartbeats, and emits `connecting`/`connected`/`degraded` states.
  - `stop()` closes Gateway/REST resources and emits `disconnected`.
  - `exclusiveResource()` should return `{ resourceId: String(accountId) }`: Discord Gateway is also single-owner-ish for a bot token, and the daemon's comm lease prevents two checkouts from contending for one bot identity.
- Inbound normalization:
  - Convert `MESSAGE_CREATE` into core `Message`.
  - Drop unsupported/non-message events in V1 (`MESSAGE_UPDATE`, deletes, reactions, interactions) unless a future contract extension adds them.
  - Enforce sender allowlist before calling `inboundHandler`; emit `FilterDropEvent` on drops.
  - Do not silently discard bot-authored messages solely because `author.bot` is true. Set `sender.isBot` and `sender.isForeignBot`; let the bus foreign-bot gate and allowlist policy decide.
- Outbound send:
  - Implement idempotency keyed by `idempotencyKey` at adapter level, at least with an in-memory `Map` like Telegram.
  - Use Discord REST `POST /channels/{channel_id}/messages` for text and multipart upload for attachments.
  - Map `OutboundPayload.reply_to` into `message_reference` when possible.
  - Disable accidental pings by default via `allowed_mentions: { parse: [], replied_user: false }`, unless future payload schema allows overrides.
  - `editMessage()` can map to `PATCH /channels/{channel_id}/messages/{message_id}` if callbacks/components are implemented.
- Attachments:
  - For inbound Discord attachments, download CDN URLs promptly and store them through `BlobStore`; URLs expire and are not durable references.
  - For outbound `Attachment.local_path`, upload as multipart.
- Backpressure/failures:
  - `reportPressure()` should reflect REST bucket pressure and Gateway connectivity, not always zero once implemented.
  - `classifyFailure()` should map Discord 401/403/404 and Gateway 4004/4013/4014 as permanent; REST 429/Gateway 4008 as rate-limited; network/5xx/resumable close codes as transient.

## Expected inbound data flow

1. An agent bridge registers or touches a session.
2. The bridge calls `ensureCommsForSession(project, agent)` through daemon context.
3. The daemon reads `account_registrations` for that project/agent and finds rows with `comm="discord"`.
4. The Discord factory resolves credentials and constructs the adapter.
5. The daemon registers and starts the adapter:
   - `bus.registerComm(adapter)` wires `onInbound`, `onConnectionState`, and `onFilterDrop`.
   - agent bridges receive `attachComm(adapter)` so they can wire callback/button handling if needed.
   - `adapter.start()` establishes the Discord Gateway connection.
6. Discord emits `MESSAGE_CREATE` over Gateway.
7. Adapter allowlist checks run first. Drops call `onFilterDrop()` with `sender_not_allowed`/`missing_sender_id`; accepted messages are normalized to core `Message`.
8. Adapter calls the bus inbound handler.
9. `MessageBus.receiveInbound()`:
   - asserts origin,
   - dedupes by `${comm}:${account}:${message_id}`,
   - applies foreign-bot policy,
   - resolves the concrete account registration by `(comm, bot_user_id)`,
   - upserts conversation inventory by project/agent/registration/chat/thread,
   - appends inbound transcript and audit rows,
   - attempts to resolve any matching open query via reply text,
   - enqueues the message in `pendingInbound` and invokes bridge wake hooks if it is normal inbound.
10. The agent-side bridge drains pending inbound with session/account scoping and injects the message into the agent harness.

Suggested Discord `Message` mapping under current types:

| Core field | Discord source / value |
|---|---|
| `schema_version` | `1` |
| `message_id` | `discord:${message.id}` |
| `platform_message_id` | `message.id` |
| `chat.comm` | `"discord"` |
| `chat.account` | concrete bot user id (`accountId`) |
| `chat.chat_native_id` | `channel_id`; for a Discord thread, this is the thread channel id |
| `chat.thread_native_id` | likely `undefined` for V1 because Discord threads are channels, not sub-ids |
| `sender.id` | `author.id` |
| `sender.display_name` | `author.global_name ?? member.nick ?? author.username` |
| `sender.isBot` | `author.bot === true` |
| `sender.isForeignBot` | `author.bot === true && author.id !== bot_user_id` |
| `origin` | `{ comm: "discord" }` |
| `text` | `content`, if non-empty |
| `attachments` | normalized Discord attachments, with local blob path/hash when downloaded |
| `reply_to` | `discord:${referenced_message.id}` or `message_reference.message_id`, if present |
| `hop_count` | `0` |
| `received_at` | `Date.parse(timestamp)` or adapter clock on receipt; choose and test consistently |

## Expected outbound data flow

1. Agent calls generic MCP/IPC send, or an optional Discord-specific IPC method, with `session`, `comm="discord"`, `payload`, optional explicit target, and optional idempotency key.
2. `MessageBus.send()` resolves the target:
   - If no explicit target, it uses the session's most-recent inbound conversation.
   - If explicit, `target.account` must be the concrete Discord bot user id, not a label.
3. Bus looks up `account_registrations` by `(comm="discord", bot_user_id)` and finds the live adapter by `(comm, accountId)`.
4. Bus calls `adapter.send(target, payload, idempotencyKey)`.
5. Adapter sends via Discord REST:
   - `POST /channels/{target.chat_native_id}/messages` for text.
   - Multipart upload for `attachments`.
   - `message_reference` for reply-to if applicable.
   - `allowed_mentions` default safe.
6. Adapter returns `{ platform_message_id: discordMessage.id, sent_at }`.
7. Bus creates `message_id = discord:${platform_message_id}`, appends outbound transcript, touches conversation outbound timestamp, and writes `outbound_sent` audit with resolved account/chat details.

## Callback / inline-interaction considerations

The core contract's callback model is intentionally Telegram-shaped but generic enough for button-like Discord interactions if the project wants them:

- `OutboundPayload.inline_keyboard` is text + opaque `callback_data` rows.
- Adapter `send()` could map this to Discord message components (buttons) if callback data length/encoding is valid for Discord custom ids.
- Discord interactions arrive as `INTERACTION_CREATE`, not `MESSAGE_CREATE`; the adapter would call `onCallback()` with a normalized `CallbackEvent`.
- `answerCallback()` maps to an interaction acknowledgement. Discord's 3-second ACK/defer requirement is stricter than Telegram's spinner semantics and probably needs adapter-local timeout handling.
- `editMessage()` maps cleanly to Discord REST message edit, but interaction-originated ephemeral messages have different rules and should be treated as out-of-scope for V1.

Recommendation: implement plain inbound/outbound messages first. Add component callbacks only after the adapter can pass text-reply query resolution, because bus-level text reply already handles `approval`, `choice`, and `freetext` query kinds.

## Config and packaging touchpoints

- Account setup should reuse the existing account registration model:
  - `project`, `agent`, `comm="discord"`, `account_label`, `bot_user_id`, `credentials_ref`, optional username metadata.
  - The existing CLI may be generic enough for `account-add`; if Telegram-specific assumptions exist, extend the generic path rather than adding a separate Discord-only registration table.
- Credential files should live under the daemon state root, not plugin installs, consistent with current `file:` references and state isolation invariants.
- Adapter bundle must be staged into the central adapters directory as `discord.js` or `discord/factory.js` shape accepted by `comm-adapter-loader.ts`.
- Development mode can use `AGENTS_COMM_BUS_ADAPTERS_DIR` to point the daemon at a source/build adapters directory.
- Plugin artifact/staging scripts currently know about Telegram adapter bundles/version metadata. A Discord plugin or multi-comm plugin will need analogous staging/version files.

## Error handling, concurrency, and retry expectations

- Startup should be best-effort per account. If one Discord registration has broken credentials, `ensureCommsForSession()` expects a skipped adapter, not a daemon crash.
- Adapter start failures must be safe to rollback. `addAdapterForRegistration()` will call `adapter.stop()`, unregister the bus entry, and detach bridges after a thrown start; Discord `stop()` must tolerate partial startup.
- Lazy startup and reload can race. The daemon already guards with an `inFlight` set keyed by `(comm, account)`, but the adapter must still keep `start()`/`stop()` idempotent enough for tests and rollback.
- Cross-checkout single-consumer leasing is generic through `exclusiveResource()`. Discord should opt in with account id as resource id.
- Gateway reconnect loops must respect Discord's IDENTIFY budget and should prefer resume with cached session id/sequence/resume URL before fresh identify.
- REST rate limit handling should keep enough bucket state for `reportPressure()` and `classifyFailure()` to be meaningful; this is more important for Discord than Telegram because route buckets are first-class.
- Inbound filter drops must be observable via `onFilterDrop()`; live debugging should have a trace option similar to `AGENTS_COMM_BUS_FILTER_TRACE`.

## Concrete integration considerations / unknowns

1. ChatRef vs Discord guild metadata
   - Current `ChatRef` has no `guild_id` or channel kind. For V1 routing, channel id is sufficient. Unknown: whether downstream UX needs guild/channel display names or permission checks that require storing `guild_id`/parent channel id durably.
2. Discord thread representation
   - Because threads are channels, `chat_native_id = thread_id` is simplest. Unknown: whether parent-channel context is needed for replies/audit or only for display.
3. Message content intent
   - Without `MESSAGE_CONTENT`, many messages arrive with empty `content`/attachments. The adapter should surface this as a clear degraded/misconfigured state rather than silently dropping every empty message.
4. Callback/component support
   - Discord buttons can fit the core callback model, but interaction ACK deadlines and custom-id limits need a small design pass before implementation.
5. Attachments and CDN expiry
   - Inbound download must happen promptly through `BlobStore`. Unknown: max download size policy and whether to skip large files, stream them, or surface a retrieval error in metadata.
6. SDK choice
   - Existing research recommends `@discordjs/core` + `@discordjs/ws` + `@discordjs/rest`, not full `discord.js`, to avoid duplicate caches. That should be validated with a spike before committing dependency weight to the plugin artifact.
7. IPC/MCP surface
   - Telegram still contributes legacy named methods. Unknown: whether Discord needs `discord_send` for compatibility/user ergonomics, or whether generic `comm_send_message` is the desired public surface going forward.
8. Test fixtures
   - Telegram tests provide a good shape, but Discord will need fake Gateway and fake REST seams to exercise reconnect/rate-limit behavior without network access.

## Suggested initial implementation file set

- `adapters/discord/version.ts`
- `adapters/discord/factory.ts`
- `adapters/discord/adapter.ts`
- `tests/architecture/discord-comm-adapter.test.ts`
- `tests/architecture/discord-factory.test.ts`
- `tests/architecture/discord-send-target.test.ts` if a Discord-specific send IPC method is added
- staging/version updates in `scripts/stage-plugins.js` and artifact-tree tests once packaging is in scope

## Bottom line

The Discord adapter should plug in at the existing comm side only: a dynamically loaded `CommAdapterFactory` creates a `CommAdapter`, the daemon lazily starts it for matching account registrations, and the bus remains the sole owner of routing, persistence, query resolution, audit, and agent wake dispatch. Discord-specific complexity belongs inside the adapter: Gateway lifecycle, REST buckets, signed CDN downloads, intents, component callbacks, and platform error classification.
