# Matrix adapter contract and integration notes

Date: 2026-06-06
Task: `t_1c7d73b6`
Scope: repository analysis only. This note summarizes the current `agents-comm-bus` comm-adapter/core contract and maps project concepts a Matrix adapter would need to implement. No production code was changed.

## Executive summary

The current architecture is comm-neutral at the daemon/bus boundary. A Matrix adapter should plug in as a dynamically loaded comm adapter factory plus a concrete `CommAdapter` implementation. The daemon and `MessageBus` retain ownership of routing, persistence, audit, transcripts, query resolution, pending-inbound queueing, and agent wake dispatch.

A Matrix implementation should therefore provide:

1. `adapters/matrix/factory.ts` exporting `createCommAdapterFactory()` with `commId = "matrix"`, credential resolution from `account_registrations.credentials_ref`, optional identity probing, adapter construction, and optional Matrix-specific IPC methods.
2. `adapters/matrix/adapter.ts` implementing `CommAdapter`: Matrix sync lifecycle, inbound event normalization, allowlist/filter-drop behavior, idempotent outbound send, attachment/media handling, connection-state reporting, pressure/failure classification, and optional callback/button support if Matrix interactive messages are adopted.
3. Packaging/staging integration so the compiled adapter bundle is discoverable as either `matrix.js` or `matrix/factory.js` under the daemon adapters directory.
4. Architecture tests mirroring the existing Telegram adapter tests with fake Matrix client/HTTP seams.

The most important constraint: routing keys are generic and intentionally small. `ChatRef` is `{ comm, account, chat_native_id, thread_native_id? }`. For Matrix V1, the likely mapping is `chat_native_id = room_id` and `thread_native_id = Matrix thread root event id` only if thread-specific routing is required; otherwise Matrix thread data should remain in metadata or reply fields until the product explicitly needs thread-scoped conversations.

## Key files inspected

### Core contracts

- `packages/core-contracts/src/contracts/comm-adapter.ts`
  - Defines `CommAdapter`, `OutboundPayload`, `InlineKeyboardButton`, `CallbackEvent`, `FilterDropEvent`, `SendResult`, `FailureClassification`, and `CommConnectionState`.
  - The required adapter surface is identity (`id`, `accountId`), lifecycle (`start`, `stop`), inbound handler registration, connection-state subscription, idempotent `send`, pressure reporting, and failure classification.
  - Optional surface includes allowlist state (`allowedSenderIds`, `updateAllowedSenderIds`), single-consumer lease identity (`exclusiveResource`), callback support (`onCallback`, `answerCallback`, `editMessage`), and filter-drop observability (`onFilterDrop`).
- `packages/core-contracts/src/messages.ts`
  - Defines normalized inbound `Message`: schema version, message id, chat ref, sender, origin, optional text/attachments/reply, platform message id, hop count, and receive timestamp.
- `packages/core-contracts/src/types.ts`
  - Defines branded ids plus `ChatRef`, `Attachment`, `Origin`, and `Sender`.
- `packages/core-contracts/src/records/account-registrations.ts`
  - Defines account registration rows. Credentials are opaque references only; `bot_user_id` is the concrete platform account id and is unique per comm account.
- `packages/core-contracts/src/records/conversations.ts`
  - Conversations are inventory, not routing state. They record observed chats/threads and activity timestamps; routing comes from `Message.chat` plus session/account resolution.
- `packages/core-contracts/src/records/queries.ts` and `packages/core-contracts/src/queries.ts`
  - Define durable query records and query resolution semantics used for approval/choice/freetext prompts.
- `packages/core-contracts/src/contracts/tool-registry.ts`
  - Minimal tool descriptor registry; not central to comm adapter startup, but relevant if future adapter-specific tools become user-facing.

### Daemon/runtime integration

- `core-daemon/runtime/comm-factory.ts`
  - Defines `CommAdapterFactory`: `commId`, `resolveCredentials`, optional `probeIdentity`, `create`, and optional `ipcMethods`.
  - `resolveCredentials` receives the registration, env map, and optional storage/state-root context for DB-backed config and credential migration.
  - `create` receives resolved credentials, concrete account id, and context containing blob store + state root.
- `core-daemon/runtime/comm-adapter-loader.ts`
  - Dynamically loads adapter factories from an adapters directory. Accepted shapes are direct `.js` modules or subdirectories with `factory.js`.
  - Each module must export `createCommAdapterFactory()`. Broken adapters are logged and skipped without preventing daemon startup.
- `core-daemon/serve.ts`
  - Composition root. Agent bridges are compiled in (`ClaudeBridgeFactory`, `CodexBridgeFactory`); comm adapter factories are dynamically loaded from `AGENTS_COMM_BUS_ADAPTERS_DIR`, `$AGENTS_COMM_BUS_BIN/../adapters`, or the state-root adapters directory.
- `core-daemon/daemon.ts`
  - `runDaemon()` creates storage/audit/transcript/blob stores, an initially empty bus, bridges, IPC dispatch, reload handling, and discovery files.
  - Comm adapters are lazy-started by session registration through `ensureCommsForSession(project, agent)` rather than eagerly started globally.
  - `addAdapterForRegistration()` is the hot-add sequence: resolve credentials, create adapter, optionally wrap with lease, register with the bus, attach bridge callbacks, start adapter, and roll back on failure.
  - `reloadAdapters()` reconciles live adapters with account registrations and can hot-update allowlists or force credential refresh.
  - The generic `drain_pending_inbound` method scopes queue draining to the caller session's owned bot accounts.
- `core-daemon/bus.ts`
  - `registerComm()` keys adapters by `(commId, accountId)`, wires `onInbound`, `onConnectionState`, and `onFilterDrop`.
  - `receiveInbound()` asserts origin, dedupes by `${comm}:${account}:${message_id}`, applies foreign-bot policy, resolves the concrete account registration, upserts conversation inventory, writes transcript/audit entries, tries text-query resolution, then enqueues/dispatches normal inbound messages.
  - `send()` resolves explicit targets or the session's most-recent inbound conversation, rejects account labels as routing targets, looks up the live adapter by `(comm, bot_user_id)`, calls `adapter.send()`, then writes transcript/audit entries.
  - `resolveQueryFromCallback()` provides the adapter-agnostic path for button/callback replies into query resolution.
- `core-daemon/runtime/agent-bridge.ts`
  - Agent bridges consume comm adapters indirectly. They can attach per-comm callback handlers, wake agents when inbound conversations arrive, drain scoped pending inbound, and respond to resolved queries.
- `core-daemon/ipc/protocol.ts`
  - IPC methods are simple named request/response calls after a client/daemon hello handshake. Comm factories can contribute method handlers through `ipcMethods()`.

### Existing Telegram reference adapter

- `adapters/telegram/factory.ts`
  - Reference `CommAdapterFactory` implementation.
  - Resolves `file:` credential refs and legacy `env:` refs, merges env/file/DB allowlists, probes bot identity via `getMe()`, constructs `TelegramCommAdapter`, and contributes legacy Telegram IPC methods.
- `adapters/telegram/adapter.ts`
  - Reference `CommAdapter` implementation.
  - Starts/stops a polling connection, emits connection states, normalizes inbound messages/callbacks, enforces allowlist before bus delivery, emits filter drops, retrieves inbound attachments into `BlobStore`, sends text/documents, supports callback ack/edit, declares an exclusive resource, caches idempotent sends, and classifies failures.

### Tests and conventions

- `package.json`
  - Tests use Node's built-in test runner with `tsx`.
  - Relevant scripts: `npm test`, `npm run test:adapter`, `npm run test:core`, `npm run test:daemon`, `npm run test:bridge`.
- `tests/architecture/comm-adapter-loader.test.ts`
  - Validates dynamic adapter loading and graceful failure isolation.
- `tests/architecture/allowlist-factory.test.ts`
  - Validates credential-file resolution, env/DB allowlist union, dedupe, and legacy credential migration.
- `tests/architecture/telegram-comm-adapter.test.ts`
  - Validates platform error diagnostics, failure classification, connection-state recovery, inbound attachment retrieval, and fake client seams.
- Other relevant adapter/bus tests identified by filename: `inbound-filter-drop.test.ts`, `reload-allowlist-refresh.test.ts`, `telegram-send-target.test.ts`, `drain-pending-inbound.test.ts`, `bus-invariants.test.ts`, `query-resolution.test.ts`, and `multi-open-queries.test.ts`.

## Current adapter/core contract

### 1. Adapter identity and routing

Required:

- `id`: comm id, e.g. `"matrix" as CommId`.
- `accountId`: concrete comm-native account id for this adapter instance.

Current bus behavior:

- Live adapters are keyed by `(commId, accountId)`, not just comm id.
- `Message.chat.account` must be the concrete platform account id seen by the receiving adapter.
- Outbound explicit targets must use concrete account ids. Account labels such as `main` are rejected by `MessageBus.registrationFor()` because labels are display metadata and can collide across agents.

Matrix mapping:

- `comm = "matrix"`.
- `accountId = bot/user Matrix identity`, likely the Matrix user id such as `@bot:example.org` unless product chooses a stable homeserver/account surrogate.
- `chat_native_id = room id` such as `!roomid:example.org`.
- `thread_native_id = event id of thread root` only if thread-specific routing is required. Otherwise leave undefined and include thread/relation metadata outside the routing key.

### 2. Factory contract

A Matrix factory must implement:

- `commId = "matrix"`.
- `resolveCredentials(registration, env, context)`:
  - Read only from `registration.credentials_ref` and configured external sources; do not store credentials inline in account registrations.
  - Support the existing `file:` pattern at minimum.
  - Optionally support legacy `env:` migration only if a prior Matrix-specific legacy config exists.
  - Use `context.storage` for DB-backed allowlist rows and `context.stateRoot` for daemon-owned credential migration files.
- `probeIdentity(credentials, env)`:
  - Return the concrete Matrix account id and optional display username/localpart.
  - Should validate credentials against the configured homeserver enough to prevent registering a row with the wrong account id.
- `create(credentials, accountId, context)`:
  - Construct `MatrixCommAdapter` with credentials, account id, allowlist, blob store, state root, clock, and injectable client/http/sync dependencies for tests.
- Optional `ipcMethods(deps)`:
  - Only add Matrix-specific methods if generic comm MCP surfaces are insufficient or compatibility requires `matrix_send`/`matrix_check_messages` style names.

Recommended credential file shape for discussion, not yet a contract:

```json
{
  "homeserverUrl": "https://matrix.example.org",
  "accessToken": "...",
  "userId": "@bot:example.org",
  "allowedUserIds": ["@satrio:example.org"]
}
```

Open design point: current Telegram credential files use `botToken` and `userId`; Matrix will likely need both `homeserverUrl` and `accessToken`, and may use `userId` as account identity. Decide naming before implementation so account CLI/help text stays comm-neutral.

### 3. Adapter lifecycle

A Matrix `CommAdapter` must implement:

- `start()`:
  - Emit `connecting` then `connected` once the Matrix client can sync/receive events.
  - Start a sync loop or event stream.
  - Establish or verify the adapter's account identity.
  - Install inbound message/callback handlers before events are delivered to avoid losing messages.
- `stop()`:
  - Stop sync/streaming, release network resources, and emit `disconnected`.
  - Tolerate partial startup because `addAdapterForRegistration()` calls `stop()` after a failed `start()`.
- `exclusiveResource()`:
  - Decide whether Matrix should return `{ resourceId: String(accountId) }`.
  - Telegram uses this for single-consumer polling. Matrix sync tokens are per access token/client and multiple syncers may be possible but undesirable because they duplicate delivery and can race state; the project should decide whether to lease per Matrix account/token for safety.
- `onConnectionState(handler)`:
  - Report `degraded` for sync loop failures, auth expiry, rate-limit stalls, or homeserver outages.
  - Return to `connected` after successful sync/send.

### 4. Inbound normalization

The adapter must call the registered `onInbound` handler with core `Message` objects only after platform-level filtering/normalization.

Suggested Matrix mapping:

| Core field | Matrix source / value |
|---|---|
| `schema_version` | `1` |
| `message_id` | `matrix:${event_id}` |
| `platform_message_id` | Matrix `event_id` |
| `chat.comm` | `"matrix"` |
| `chat.account` | concrete Matrix bot/user id for this adapter |
| `chat.chat_native_id` | Matrix `room_id` |
| `chat.thread_native_id` | thread root event id if using thread-scoped routing; otherwise undefined |
| `sender.id` | event `sender` Matrix user id |
| `sender.display_name` | room member displayname if available, otherwise sender user id/localpart |
| `sender.isBot` | best-effort; Matrix has no universal bot bit, so derive from configured known bot ids or default false |
| `sender.isForeignBot` | true only if `isBot` and sender differs from adapter account id |
| `origin` | `{ comm: "matrix" }` |
| `text` | `content.body` / plain-text fallback from `m.text`, `m.notice`, etc. |
| `attachments` | downloaded Matrix media objects with blob hash/local path when possible |
| `reply_to` | `matrix:${m.relates_to.m.in_reply_to.event_id}` if present |
| `hop_count` | `0` |
| `received_at` | Matrix event timestamp or adapter clock; choose consistently and test |

Behavioral requirements:

- Do not call `inboundHandler` for unsupported events unless they can be represented as core messages.
- Apply allowlist before bus delivery when configured.
- Emit `FilterDropEvent` on allowlist drops with `reason`, `update_kind`, sender id, room id, and event id.
- Do not silently drop messages from bots/bridges solely because they look automated. Set sender flags and let the bus foreign-bot gate decide. If Matrix cannot identify bots reliably, document that and default conservatively.
- Include enough platform metadata on attachments to debug media retrieval without making routing depend on metadata.

### 5. Outbound send

`send(target, payload, idempotencyKey)` must be idempotent.

Current bus expectations:

- The bus has already resolved the target and selected the adapter.
- `target.account` is a concrete Matrix adapter account id.
- The adapter sends to `target.chat_native_id` and optionally `target.thread_native_id`.
- The adapter returns `{ platform_message_id, sent_at }`; the bus converts this to `matrix:${platform_message_id}` for transcript/audit.

Matrix requirements:

- Implement in-memory idempotency cache at minimum, mirroring Telegram's `sentByKey` map.
- Send text payloads as Matrix room messages.
- Map `payload.reply_to` to Matrix reply relations when possible.
- Map `target.thread_native_id` to Matrix thread relation only if Matrix threads are in scope.
- Upload `Attachment.local_path` to Matrix media, then send a message event referencing the uploaded content URI.
- If `payload.format === "html"`, decide whether to emit Matrix formatted body (`format: org.matrix.custom.html`) and a plain fallback body. If unsupported, fall back to plain text per contract.
- If `payload.inline_keyboard` is present, either ignore it safely for V1 or map it to a deliberate Matrix interaction design. The current contract allows adapters without callback support to ignore inline keyboards and send text alone.

### 6. Query/callback expectations

Text replies already work without adapter-specific callbacks:

- Agent bridge opens a query through `bus.openQuery()`.
- Bridge sends a prompt via `bus.send()` with optional inline keyboard.
- User replies in the same conversation.
- `MessageBus.receiveInbound()` tries `tryResolveOpenQuery()` before normal inbound dispatch.

Callback support is optional:

- If Matrix interactive UI is implemented, adapter should expose `onCallback()`, `answerCallback()`, and optionally `editMessage()`.
- Callback payload should carry the existing bus callback data shape used by bridges (`query id` + selected value), not invent a Matrix-only query store.
- If Matrix cannot provide reliable button callbacks, skip callback support initially and rely on text reply resolution.

Recommendation: implement plain text and reply-based query resolution first. Treat Matrix interactive messages/buttons as a second design pass.

### 7. Auth, config, and account registration

Current durable model:

- `AccountRegistration` primary identity is `(project, comm, agent, account_label)`, with immutable `registration_id` and concrete `bot_user_id`.
- `credentials_ref` is an opaque pointer, usually `file:<path>`.
- `bot_user_id` is unique with `comm`.
- Account labels are not routing keys.

Matrix implementation expectations:

- Reuse the generic account registration table. Do not create a Matrix-only account table unless a schema gap is proven.
- Keep credential files under the daemon state root via the existing `file:` pattern.
- Probe identity during account-add/update so `bot_user_id` matches the Matrix user id associated with the token.
- Decide whether access-token rotation should use `reloadAdapters({ forceCredentialRefresh })` behavior similar to Telegram token update.
- Reuse DB allowlist tables by setting `comm="matrix"`; global and per-account allowlists should merge in the factory.

### 8. Error, retry, and pressure expectations

Adapter must implement `classifyFailure(error): "permanent" | "transient" | "rate_limited"`.

Suggested Matrix classification:

- `permanent`: invalid/expired access token, forbidden room, user not joined/invited, homeserver rejects account, unrecoverable event type/config mismatch.
- `rate_limited`: Matrix `M_LIMIT_EXCEEDED` / HTTP 429, ideally using retry-after metadata internally.
- `transient`: network failures, HTTP 5xx, homeserver temporarily unavailable, sync timeout/retryable connection errors.

`reportPressure()` should eventually reflect:

- outbound queue length,
- current rate-limit cooldown,
- sync health/degraded status.

For a first implementation, returning `{ backlog: 0, rateLimited: false }` is consistent with Telegram but less useful. A Matrix adapter should evolve toward meaningful pressure because homeserver rate limits can be visible and structured.

### 9. Event flow a Matrix adapter must fit

Inbound expected flow:

1. Agent bridge registers/touches a session.
2. Bridge calls `ensureCommsForSession(project, agent)`.
3. Daemon loads matching account registrations for that project/agent.
4. Matrix factory resolves credentials and constructs adapter.
5. Daemon `addAdapterForRegistration()`:
   - creates/wraps adapter,
   - calls `bus.registerComm(adapter)`,
   - calls each bridge's `attachComm(adapter)`,
   - calls `adapter.start()`,
   - rolls back on failure.
6. Matrix sync receives a message event.
7. Adapter applies allowlist/filtering and normalizes to core `Message`.
8. Adapter calls bus inbound handler.
9. `MessageBus.receiveInbound()` dedupes, loop-protects, resolves account/conversation, writes transcript/audit, resolves open query if applicable, then queues normal inbound.
10. Agent bridge wakes/drains based on project/agent/account scope.

Outbound expected flow:

1. Agent sends through generic comm tool/IPC or optional Matrix-specific IPC method.
2. `MessageBus.send()` resolves target from explicit `ChatRef` or session most-recent inbound conversation.
3. Bus validates the concrete Matrix account id and finds the live adapter.
4. Adapter sends to Matrix room/thread/media endpoint and returns platform message id.
5. Bus writes outbound transcript/audit and updates conversation outbound timestamp.

### 10. Testing conventions and suggested Matrix tests

Use Node's built-in test runner with `tsx` under `tests/architecture/`.

Suggested initial tests:

- `matrix-factory.test.ts`
  - Resolves `file:` credential refs.
  - Merges env/file/DB allowlists scoped to `comm="matrix"` and concrete Matrix account id.
  - Probes identity through an injectable fake Matrix HTTP client.
  - Leaves unresolved credentials undefined rather than throwing.
- `matrix-comm-adapter.test.ts`
  - Starts/stops fake sync client and emits connection-state transitions.
  - Normalizes Matrix text events into core `Message` fields.
  - Normalizes replies into `reply_to`.
  - Drops allowlist failures and emits `FilterDropEvent`.
  - Downloads Matrix media into `BlobStore` and preserves retrieval errors in metadata.
  - Sends text with idempotency, returns stable result on repeated idempotency key.
  - Classifies auth/forbidden/rate-limit/network failures.
- `matrix-send-target.test.ts` if adding Matrix-specific IPC methods.
- `matrix-callback.test.ts` only if callback/interactive messages are in scope.
- Reuse existing bus-level tests for routing/query behavior rather than duplicating bus internals in adapter tests.

Run focused tests with a script analogous to:

```bash
npm run test:adapter
```

If adding new Matrix tests, include them in the appropriate package script or a new focused script once implementation begins.

## Concrete Matrix adapter requirements

### Must implement for V1

- Dynamic adapter factory export: `createCommAdapterFactory()`.
- `commId = "matrix"` and concrete Matrix account identity.
- `file:` credential resolution with no inline secret storage.
- Identity probing against the Matrix homeserver.
- Adapter lifecycle with safe partial-start rollback.
- Matrix sync/event intake for room messages.
- Core `Message` normalization for text, replies, room ids, sender ids, and timestamps.
- Allowlist support and filter-drop observability.
- Idempotent outbound text send.
- Basic attachment/media handling through `BlobStore` or explicit metadata on retrieval failure.
- Failure classification for permanent/transient/rate-limited cases.
- Unit tests using fake Matrix clients; no live homeserver dependency in architecture tests.
- Packaging so the daemon's adapter loader can discover the compiled Matrix factory.

### Should implement soon after V1

- Meaningful `reportPressure()` using Matrix rate-limit/sync state.
- Thread-aware mapping if Matrix thread UX is required.
- HTML/formatted-body support for `OutboundPayload.format = "html"`.
- Credential rotation/reload tests.
- E2E test plan with a real Matrix homeserver/account once credentials exist.

### Optional / defer until product need

- Matrix interactive button/callback mapping.
- Matrix-specific IPC methods beyond the generic comm send/check surfaces.
- Rich room/guild/space metadata in conversation inventory.
- Multi-homeserver federation-specific policy handling.

## Open questions

1. Matrix identity key: should `bot_user_id` be the Matrix user id (`@bot:server`) exactly, or a homeserver-scoped account id if tokens can map aliases/puppets?
2. Credential shape: standardize on `{ homeserverUrl, accessToken, userId, allowedUserIds }`, or use different names to align with existing Telegram `botToken`/`userId` conventions?
3. Sync ownership: should Matrix adapters declare `exclusiveResource()` per Matrix account/token to prevent duplicate syncers across checkouts, even if Matrix technically permits multiple clients?
4. Thread routing: should Matrix threads create distinct `thread_native_id` conversations, or should all room messages route at room level with thread metadata only?
5. Bot detection: Matrix lacks a universal `is_bot` flag. Do we need a configured known-bot allow/deny list, or should `sender.isBot` default false and rely on allowlists?
6. Encryption: are encrypted Matrix rooms in scope? If yes, adapter requirements expand to device/session key management and probably need a separate design.
7. Media limits: what max inbound/outbound attachment size should the adapter accept before skipping or surfacing retrieval errors?
8. HTML formatting: should adapter emit Matrix formatted bodies for `format="html"`, and how should unsupported/unsafe tags be sanitized?
9. Generic vs Matrix-specific IPC: should the product expose only generic `comm_send_message`, or provide `matrix_send` parity with Telegram legacy methods?
10. Account CLI UX: does existing generic account-add/update-token flow already support Matrix's multiple credential fields, or does it need an adapter-provided credential bootstrap hook?

## Bottom line

A Matrix adapter can fit the current contract without changing the bus if V1 keeps routing to Matrix rooms and uses text/reply query resolution. Matrix-specific complexity belongs in the adapter: sync lifecycle, homeserver auth, media upload/download, optional encryption, optional thread semantics, rate limits, and any interactive-message callback layer. The core daemon should remain unchanged except for packaging/staging and any generic account CLI improvements needed to capture Matrix credential fields safely.
