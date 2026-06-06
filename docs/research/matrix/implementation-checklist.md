# Matrix adapter implementation checklist

Use this as the execution checklist for the first autonomous implementation worker.

## Scope guardrails

V1 includes:

- unencrypted Matrix rooms only;
- `matrix-bot-sdk`-backed Client-Server API bot account;
- room-level routing with optional reply metadata;
- text send/receive;
- basic attachment upload/download;
- allowlist filtering and filter-drop observability;
- idempotent outbound sends via Matrix `txnId`;
- durable sync cursor storage;
- architecture tests using fake Matrix client seams.

V1 excludes:

- E2EE/Olm/Megolm and encrypted rooms;
- Matrix Application Service mode;
- Matrix-specific callback buttons;
- full room-state inventory or moderation/admin tools;
- Python/Rust sidecars;
- live homeserver dependency in normal unit/architecture tests.

## Phase 0: inspect current patterns

Read these first:

- `packages/core-contracts/src/contracts/comm-adapter.ts`
- `packages/core-contracts/src/messages.ts`
- `packages/core-contracts/src/types.ts`
- `core-daemon/runtime/comm-factory.ts`
- `core-daemon/runtime/comm-adapter-loader.ts`
- `core-daemon/bus.ts`
- `adapters/telegram/factory.ts`
- `adapters/telegram/adapter.ts`
- `tests/architecture/telegram-comm-adapter.test.ts`
- `tests/architecture/allowlist-factory.test.ts`
- `tests/architecture/comm-adapter-loader.test.ts`

## Phase 1: dependency and adapter package

- Add `matrix-bot-sdk` as the initial SDK dependency.
- Confirm Node.js >=22 compatibility in the repo's current package setup.
- Create adapter files:
  - `adapters/matrix/factory.ts`
  - `adapters/matrix/adapter.ts`
  - optional `adapters/matrix/types.ts`
  - optional `adapters/matrix/matrix-client.ts` seam for test injection.
- Ensure the build emits a discoverable factory as either `matrix.js` or `matrix/factory.js` under the daemon adapters directory.

Verification:

- `npm test -- tests/architecture/comm-adapter-loader.test.ts` or the repo's equivalent focused script still passes.
- A loader test can discover the Matrix factory.

## Phase 2: factory and credentials

Implement `createCommAdapterFactory()` with:

- `commId = "matrix"`;
- `resolveCredentials(registration, env, context)`;
- `probeIdentity(credentials, env)` via `GET /_matrix/client/v3/account/whoami` or injectable client;
- `create(credentials, accountId, context)`.

Credential-file fields to support first:

```json
{
  "homeserverUrl": "https://matrix.example.org",
  "accessToken": "syt_...",
  "userId": "@agents-comm-bot:matrix.example.org",
  "deviceId": "GHTYAJCE",
  "allowedUserIds": ["@satrio:matrix.example.org"],
  "allowedRoomIds": ["!room:matrix.example.org"],
  "autoJoinInvites": true,
  "encryptedRoomPolicy": "decline"
}
```

Tests:

- resolves valid `file:` credentials;
- returns undefined or clean diagnostic for missing file/malformed JSON;
- refuses credentials with missing `homeserverUrl`, `accessToken`, or `userId`;
- probes identity and rejects MXID mismatch;
- rejects guest accounts;
- merges global/per-account allowlists consistently with Telegram factory conventions.

## Phase 3: adapter lifecycle and sync

Implement `MatrixCommAdapter` contract:

- `id = "matrix"`;
- `accountId = full MXID`;
- `start()` emits `connecting`, starts sync, then emits `connected`;
- `stop()` stops sync and emits `disconnected`;
- `onInbound(handler)`;
- `onConnectionState(handler)`;
- `onFilterDrop(handler)`;
- `allowedSenderIds()` / `updateAllowedSenderIds()` if matching Telegram's allowlist surface;
- `exclusiveResource()` returning a resource scoped to Matrix account/token unless project decides otherwise;
- `reportPressure()` with at least backlog/rate-limit placeholders.

Implementation notes:

- Store SDK sync state under daemon state root, not inside the adapter install directory.
- Use a filter that avoids presence/typing noise but retains enough room/member state to handle invites and display names.
- Install event handlers before starting the sync loop.
- Treat repeated sync failures as `degraded`; recover to `connected` after successful sync.

Tests:

- fake client start/stop is called exactly once;
- partial startup failure still allows `stop()` rollback;
- connection-state handlers receive expected transitions;
- duplicate starts/stops are safe or explicitly rejected.

## Phase 4: inbound normalization

For each supported Matrix event, produce one core `Message`.

Initial supported event types:

- `m.room.message` with `msgtype = m.text`;
- `m.room.message` with `msgtype = m.notice`;
- optional basic media message types once BlobStore is wired.

Mapping:

| Core field | Matrix source |
|---|---|
| `schema_version` | `1` |
| `message_id` | `matrix:${event.event_id}` |
| `platform_message_id` | `event.event_id` |
| `chat.comm` | `"matrix"` |
| `chat.account` | adapter account MXID |
| `chat.chat_native_id` | room id |
| `chat.thread_native_id` | thread root event id only if in scope; otherwise unset |
| `sender.id` | `event.sender` |
| `sender.display_name` | room member display name if available, fallback MXID |
| `sender.isBot` | configured known-bot result or false |
| `origin` | `{ comm: "matrix" }` |
| `text` | `content.body`, with `m.new_content.body` for edits only if edit support exists |
| `reply_to` | `matrix:${content.m.relates_to.m.in_reply_to.event_id}` |
| `received_at` | event timestamp or adapter clock; process order still follows sync order |

Drop/log:

- `m.room.encrypted` in V1;
- unknown event types;
- malformed events missing event id, sender, room id, or content;
- allowlist failures, with `FilterDropEvent`.

Tests:

- text and notice normalization;
- reply normalization;
- malformed event does not crash sync loop;
- unsupported event is logged/dropped;
- allowlisted sender/room passes;
- disallowed sender/room drops and emits `FilterDropEvent`;
- duplicate `event_id` does not emit twice.

## Phase 5: outbound send

Implement `send(target, payload, idempotencyKey)`.

Text path:

- validate `target.chat_native_id` is a Matrix room id;
- choose `txnId` from `idempotencyKey` after URL-safe normalization;
- call `sendMessage`/`sendEvent` to `m.room.message`;
- return `{ platform_message_id: event_id, sent_at }`;
- cache by idempotency key in memory for fast repeated calls in-process;
- rely on Matrix `txnId` for cross-restart idempotency.

Reply path:

- if `payload.reply_to` contains `matrix:$event`, emit `m.relates_to.m.in_reply_to.event_id`.

HTML path:

- either sanitize and emit Matrix formatted body, or deliberately downgrade to plain text and test the downgrade.

Tests:

- sends plain text;
- repeated idempotency key returns same result;
- Matrix SDK receives stable `txnId`;
- reply payload maps to Matrix reply relation;
- missing/invalid room id returns permanent failure;
- SDK 429 maps to rate-limited classification.

## Phase 6: media

Inbound:

- parse `mxc://server/mediaId` from image/file/audio/video messages;
- check configured size limit and/or `/media/config`;
- download through authenticated media endpoint;
- store bytes through daemon `BlobStore`;
- attach metadata sufficient to debug failed retrieval.

Outbound:

- upload `Attachment.local_path` through Matrix media upload;
- send an `m.room.message` referencing returned `mxc://...`;
- preserve filename/mimetype/size where available.

Tests:

- inbound media creates core attachment with blob ref/path;
- failed download does not crash and records metadata;
- outbound upload then send uses returned `mxc://` URI;
- oversized media is skipped or rejected according to configured policy.

## Phase 7: failure classification and pressure

Classify:

- `permanent`: 401/unknown token, whoami mismatch, forbidden room, not joined, guest account, encrypted-room unsupported if send attempted;
- `rate_limited`: HTTP 429, `M_LIMIT_EXCEEDED`, `M_USER_LIMIT_EXCEEDED`;
- `transient`: network errors, timeout, HTTP 5xx, temporary homeserver outage.

Pressure fields should eventually reflect:

- sync health/degraded state;
- outbound queue/backlog if any;
- current rate-limit cooldown.

Tests:

- auth failure permanent;
- forbidden room permanent;
- 429 rate-limited with retry-after preserved internally if possible;
- 5xx/network transient;
- degraded state after repeated sync failures.

## Phase 8: live smoke test, only after credentials exist

Prerequisites:

- unencrypted Matrix room;
- bot account invited/joined;
- credential file under daemon state root;
- account registration with `comm = "matrix"` and `bot_user_id = full MXID`.

Smoke checks:

1. `/account/whoami` returns expected MXID and device id.
2. Adapter starts and reaches `connected`.
3. Human sends text in room; daemon receives normalized message and wakes agent.
4. Agent sends text; message appears in Matrix room.
5. Re-send with same idempotency key does not duplicate.
6. Disallowed sender/room is dropped with audit/filter event.
7. Encrypted room invite is declined or no-oped with clear diagnostic.

## Definition of done

- Focused Matrix architecture tests pass.
- Existing Telegram/core adapter tests still pass.
- Matrix factory is dynamically discoverable.
- No bus/core contract changes unless explicitly justified.
- Secrets are never committed or stored inline in account registrations.
- README/research assumptions that changed during implementation are updated.
