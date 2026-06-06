# Matrix adapter research package

Date: 2026-06-06
Status: actionable research handoff for implementing an `agents-comm-bus` Matrix comm adapter.

## Bottom line

A Matrix adapter fits the current `agents-comm-bus` comm adapter contract without bus changes if V1 is intentionally narrow:

- implement `comm = "matrix"` as a dynamically loaded comm adapter factory under `adapters/matrix/`;
- use the Matrix Client-Server API as a normal bot/user account, not Application Service or Server-Server APIs;
- map Matrix rooms to core conversations with `chat_native_id = room_id`;
- use Matrix event ids as platform message ids and Matrix `txnId` values as outbound idempotency keys;
- rely on plain text/reply-based query resolution first;
- decline or no-op encrypted rooms in V1; and
- choose `matrix-bot-sdk` for the first implementation, with `matrix-js-sdk` reserved as a fallback if deep client/E2EE coverage becomes mandatory.

The hard parts are adapter-local, not core-local: `/sync` lifecycle, durable sync-token storage, token/identity probing, invite handling, event-shape validation, media upload/download, rate-limit/backoff, and defensive handling of malformed/federated events.

## Research artifacts

- `adapter-contract-integration-notes.md` — maps the existing core/daemon/Telegram adapter contract to Matrix implementation requirements.
- `matrix-api.md` — protocol-level API notes for Matrix Client-Server API v1.18, including auth, `/sync`, message send/receive, media, threads, E2EE, rate limits, and failure modes.
- `matrix-sdk-comparison.md` — SDK/library comparison and recommendation.
- `matrix-sdk-candidates.json` — structured SDK candidate facts.
- `matrix-implementation-risks.md` — Matrix implementation pitfalls and community-reported issues with priority levels.
- `cited-issues.json` — structured GitHub issue references behind the pitfalls document.
- `matrix-setup-guide.md` — operator setup guide for homeserver/account/token/room verification.
- `implementation-checklist.md` — recommended implementation sequence, acceptance checks, and first test list.

## Concept mapping to `agents-comm-bus`

| Matrix concept | Core contract concept | V1 decision |
|---|---|---|
| Matrix comm channel | `CommId` | `"matrix"` |
| Bot/user MXID, e.g. `@bot:example.org` | adapter `accountId`, `ChatRef.account`, `account_registrations.bot_user_id` | use full MXID as concrete account id |
| Homeserver URL | credential/config field | required in credential file |
| Access token | credential secret | store behind `credentials_ref`, preferably `file:` under daemon state root; never inline in DB rows |
| Room id, e.g. `!room:example.org` | `ChatRef.chat_native_id` | primary conversation routing key |
| Room alias, e.g. `#ops:example.org` | human convenience only | resolve to room id before routing; do not store alias as routing key |
| Matrix event id, e.g. `$event:example.org` | `platform_message_id`; normalized `message_id` | `platform_message_id = event_id`, `message_id = matrix:${event_id}` |
| `m.thread` root event id | `ChatRef.thread_native_id` | defer thread-scoped routing unless product requires it; otherwise keep room-level routing |
| `m.in_reply_to` | `Message.reply_to` / query text-reply resolution | support in V1 |
| `m.room.message` with `msgtype = m.text`/`m.notice` | inbound/outbound text | support in V1 |
| Matrix media `mxc://...` | `Attachment` via `BlobStore` | support basic download/upload; preserve metadata/errors |
| `/sync` next_batch token | adapter state | persist under daemon state root, per comm/account/device |
| Matrix `txnId` on `PUT /send` | outbound idempotency key | derive from bus idempotency key/outbound record id; never from `Date.now()` |
| `M_LIMIT_EXCEEDED`, `M_USER_LIMIT_EXCEEDED`, HTTP 429 | rate-limited failure classification / pressure | classify as `rate_limited`; honor `Retry-After` header and body fallback |
| `M_UNKNOWN_TOKEN`, auth 401, wrong `whoami` | permanent failure | refuse adapter start or mark degraded/permanent with loud diagnostics |
| Encrypted room state `m.room.encryption` | unsupported V1 feature | decline encrypted invites or remain no-op with audit/error; do not attempt partial E2EE |
| Matrix bot identity | `Sender.isBot` / `isForeignBot` | Matrix has no protocol bot bit; default false unless configured/known, let bus foreign-bot policy handle routing |

## Relevant API expectations

### Auth and identity

- Probe token identity with `GET /_matrix/client/v3/account/whoami`.
- Register/refuse startup based on exact full MXID match against `bot_user_id`.
- Treat `is_guest = true` as unsupported.
- Prefer a long-lived access token or OAuth/device-auth setup output stored as a secret file.
- Preserve `device_id` when possible to avoid zombie devices and future E2EE identity breakage.

Recommended credential-file shape for V1:

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

### Inbound receive

- Use `/sync` long polling, preferably through the selected SDK, with a tight bot filter.
- Persist `next_batch` before/after successful processing according to the SDK semantics so restart does not replay the world.
- Ignore initial historical messages unless explicitly configured; the bus needs new inbound, not account history.
- Normalize only supported event types into core `Message`; unknown/unsupported events should be logged/dropped explicitly, not silently swallowed.
- Apply allowlists before calling the bus inbound handler and emit `FilterDropEvent` on drops.
- Deduplicate by event id; edits/replacements must not masquerade as new independent user messages unless the core gets an explicit edit envelope later.
- Use sync timeline order, not `origin_server_ts`, for sequencing decisions.

### Outbound send

- Text: `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`.
- `txnId` is Matrix-native idempotency. Use the bus idempotency key or durable outbound record id.
- For HTML payloads, send Matrix `format: "org.matrix.custom.html"` plus plain `body`, after sanitizing to Matrix's allowed HTML subset.
- For replies, set `m.relates_to.m.in_reply_to.event_id`.
- For thread sends, set `m.relates_to.rel_type = "m.thread"` only if thread routing is promoted to V1 scope.
- For attachments, upload raw bytes to the content repository, then send an `m.room.message` with `url: "mxc://..."` and relevant `info`.

### Query/callback behavior

- V1 should not invent Matrix-specific query state.
- Text replies in the same conversation already flow through `MessageBus.receiveInbound()` and `tryResolveOpenQuery()`.
- Matrix button/callback UX is optional and should be a separate design pass; plain prompt text plus numbered choices is enough for V1.

## SDK recommendation

Primary: `matrix-bot-sdk`.

Why:

- TypeScript/Node-oriented and bot-shaped.
- Provides `MatrixClient`, `AutojoinRoomsMixin`, and storage providers.
- Less full-client baggage than `matrix-js-sdk`.
- Compatible with project runtime expectation: Node.js >=22, TypeScript/ESM.
- Has an opt-in path to Rust-backed crypto later, although V1 should not enable E2EE.

Caveats to design around:

- It inherits deprecated `request`/`request-promise` dependencies; bundling and runtime compatibility need a focused smoke test.
- Release cadence/spec coverage may lag the official SDK.
- Some reported sync-loop failures leave bots alive but not receiving; wrap/monitor sync health.
- E2EE remains operationally complex even when the SDK has crypto support.

Fallback: `matrix-js-sdk` if full-client semantics, Element parity, or deeper official spec coverage become more valuable than bot ergonomics and dependency weight.

Rejected for direct V1 integration:

- `matrix-rust-sdk`: valuable as crypto substrate, not a direct TypeScript daemon dependency.
- `matrix-nio`: wrong runtime; only use if the architecture accepts a Python sidecar, which it currently should not.

## Notable pitfalls to handle before calling V1 production-ready

P0/P1 items from the risk research:

1. Sync loop stuck/crashed on malformed events: validate event shapes, add sync health monitoring, and reconnect/restart the loop on repeated failures.
2. E2EE/device-store failure: do not support encrypted rooms in V1; detect and decline/no-op loudly.
3. Duplicate events and duplicate join handlers: maintain idempotent event and room-join paths.
4. Incorrect ordering: never sort Matrix events by `origin_server_ts`; process in sync timeline order.
5. Deprecated HTTP dependency risk in `matrix-bot-sdk`: verify in project build/runtime and pin or patch if needed.
6. Rate limits: handle both `M_LIMIT_EXCEEDED` and `M_USER_LIMIT_EXCEEDED`, plus `Retry-After` header/body fallback.
7. Initial sync size and stale sync tokens: use filters, persist sync state, and recover from invalid/stale tokens without daemon crash.
8. Federation partial state and malicious/malformed events: assume incomplete state and validate untrusted event payloads defensively.
9. Media size/auth changes: use authenticated media download endpoints and enforce configured size limits.
10. Token revocation by side channel: surface 401/`M_UNKNOWN_TOKEN` as a clear operator action, not a transient network blip.

## Recommended implementation path

1. Add `adapters/matrix/factory.ts` and `adapters/matrix/adapter.ts` skeletons mirroring Telegram's factory/adapter shape.
2. Implement credential loading for `file:` refs, allowlist merging, and `probeIdentity()` via `/account/whoami`.
3. Build a thin injectable Matrix client seam around the SDK so architecture tests can use fakes and never need a live homeserver.
4. Implement lifecycle: `start()`, `stop()`, connection-state events, sync loop startup, and safe rollback after partial startup failure.
5. Implement inbound text normalization for `m.room.message` (`m.text`, `m.notice`) with room id, sender id, event id, reply id, and timestamp mapping.
6. Implement allowlist filtering and `FilterDropEvent` emission.
7. Implement idempotent outbound text send using Matrix `txnId`.
8. Add basic media upload/download through `BlobStore` with size limits and metadata on failures.
9. Add failure classification and pressure reporting for auth/permanent, transient, and rate-limited states.
10. Wire packaging/staging so the dynamic loader discovers `matrix.js` or `matrix/factory.js` in the adapters directory.
11. Add focused architecture tests before any live integration test.
12. Run an optional live smoke test only after a Matrix homeserver/account/token/room exists.

## First tests to write

- `tests/architecture/matrix-factory.test.ts`
  - resolves `file:` credential refs;
  - refuses missing/invalid credentials without crashing daemon startup;
  - merges file/env/DB allowlists scoped to `comm = "matrix"`;
  - probes `/account/whoami` and rejects mismatched MXIDs;
  - creates adapter with daemon state root and blob store dependencies.

- `tests/architecture/matrix-comm-adapter.test.ts`
  - emits `connecting` then `connected` on fake sync start;
  - tolerates partial startup failure and `stop()` rollback;
  - normalizes Matrix text/notice events into core `Message` fields;
  - maps `m.in_reply_to` into `reply_to`;
  - applies allowlist drops and emits `FilterDropEvent`;
  - deduplicates repeated event ids;
  - sends text with stable idempotency and returns identical result on repeated key;
  - classifies auth, forbidden, 429, 5xx, and network errors.

- Packaging/loader test
  - verifies the compiled Matrix factory is discoverable through `comm-adapter-loader` and broken Matrix adapter load failures do not prevent daemon startup.

## Remaining unknowns

- Should `bot_user_id` always be the full Matrix MXID, or should registration support homeserver-scoped aliases? Recommendation: use full MXID.
- Exact final credential-file schema and account CLI UX for multi-field credentials.
- Whether Matrix adapters should declare `exclusiveResource()` per MXID/token. Recommendation: yes for safety, even though Matrix permits multiple sync clients.
- Whether Matrix threads become `thread_native_id` routing keys in V1. Recommendation: no; keep room-level routing first.
- Bot detection policy. Recommendation: default `isBot = false` unless configured, because Matrix has no universal bot bit.
- Max inbound/outbound media size defaults and how retrieval failures appear to users.
- Whether HTML output should be enabled in V1 or treated as plain text until sanitizer behavior is tested.
- Whether generic `comm_send_message` is enough or Matrix-specific IPC compatibility methods are needed. Recommendation: generic only unless a concrete compatibility requirement appears.
- Live homeserver target for smoke tests: `matrix.org`, community server, or self-hosted Synapse/Conduit.

## Go/no-go recommendation

Go for a V1 Matrix adapter if scope is limited to unencrypted rooms, text/replies, basic media, allowlists, and idempotent outbound. Do not include encrypted-room support, callback buttons, appservice mode, federation administration, or full room-state modeling in V1. Those are separate feature designs.
