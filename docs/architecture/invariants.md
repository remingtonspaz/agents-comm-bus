# Architectural invariants

The properties listed here are the testable contracts that distinguish the
v4 design from the v3 plugin. Every entry below is paired with the test
file(s) that will enforce it. Phase 0 tests live under
`tests/architecture/`; later phases add coverage under `tests/migration/`.

The siblings of this doc walk through the flows these invariants govern:

- [Telegram → Claude](./sequence-telegram-to-claude.md)
- [Telegram → Codex](./sequence-telegram-to-codex.md)
- [Query roundtrip](./sequence-query-roundtrip.md)
- [Daemon bootstrap](./sequence-daemon-bootstrap.md)
- [Storage layout](./storage-layout.md)

## Invariants

- **One comm owner per `(comm, account)` registration.**
  An external bot identity belongs to exactly one account at a time. The
  `account_registrations` table enforces this via a `UNIQUE(comm,
  bot_user_id)` constraint.
  *Tests:* `tests/architecture/registration-uniqueness.spec.ts`,
  `tests/migration/v3-to-v4-registration.spec.ts` (Phase 1+).

- **Durable enqueue before wake / dispatch.**
  Every inbound message is persisted to SQLite **and** appended to the
  conversation transcript before any wake signal is emitted to an agent
  adapter. If the daemon crashes after persist but before dispatch, the
  message survives and is delivered on next start.
  *Tests:* `tests/architecture/durable-before-wake.spec.ts`.

- **Deterministic inbound routing.**
  Inbound routing is exclusively `SELECT … WHERE comm=? AND bot_user_id=?`
  against `account_registrations`. No last-active heuristics. No
  parent-process-tree walk. No `last-chat.json`-style fallback.
  *Tests:* `tests/architecture/routing-determinism.spec.ts`.

- **Conversations are inventory, not routing rules.**
  The `conversations` table tracks every chat thread the daemon has seen,
  but presence in that table does not authorize delivery. Authorization is
  always via `account_registrations`.
  *Tests:* `tests/architecture/conversation-not-routing.spec.ts`.

- **Agent chooses reply target from inbound `ChatRef`.**
  The reply target for a response to an inbound message is the `ChatRef`
  carried in that message's envelope. The agent is in charge of which chat
  it replies to. For proactive sends with no explicit target, the bus
  falls back to most-recent-inbound — and only then.
  *Tests:* `tests/architecture/reply-target-selection.spec.ts`.

- **No implicit cross-agent delivery.**
  By default a message from comm A bound for agent X is never delivered to
  agent Y. Cross-agent fanout requires an explicit opt-in subscription
  rule. Default deny, opt-in allow.
  *Tests:* `tests/architecture/cross-agent-default-deny.spec.ts`.

- **Query semantics: at-most-one-open per session.**
  A session may have at most one open query at a time. Enforced at the DB
  level via a partial unique index on `queries(session_id) WHERE status =
  'open'`.
  *Tests:* `tests/architecture/query-at-most-one-open.spec.ts`.

- **Query semantics: resolved-once.**
  Once a query transitions out of `open`, no further reply can change its
  resolution. Late replies receive an informational "already answered"
  notice.
  *Tests:* `tests/architecture/query-resolved-once.spec.ts`.

- **Query semantics: TTL fail-closed.**
  When a query's TTL elapses without resolution, the daemon marks the
  query `expired` and returns the safe-default resolution to the agent
  (deny for permissions, cancel for choices).
  *Tests:* `tests/architecture/query-ttl-fail-closed.spec.ts`.

- **Query semantics: same-chat-match enforced.**
  A reply resolves a query only if it arrives on the same `ChatRef` the
  query prompt was sent to. Replies from other chats are rejected (the
  query stays open).
  *Tests:* `tests/architecture/query-same-chat-match.spec.ts`.

- **Session and query leases bound to IPC connection lifetime.**
  A session is active iff its control connection is open. A query is open
  iff its requesting connection is open. Closing the connection — for any
  reason — terminates the lease. There is no application-level heartbeat
  in V1; the socket half-close is the liveness signal.
  *Tests:* `tests/architecture/lease-on-connection-close.spec.ts`.

- **Attachments stored as content-addressed filesystem blobs.**
  Binary payloads (images, files) live at
  `~/.agents-comm-bus/chats/<conv>/attachments/<sha256>`. DB rows reference
  the hash; they never embed the bytes. Two messages referencing the same
  payload share one blob on disk.
  *Tests:* `tests/architecture/attachment-content-addressing.spec.ts`.

- **`PRAGMA user_version` migrations + per-record `schema_version`.**
  Schema evolution uses `PRAGMA user_version` for the database-level
  version. Every persistent record family also carries a per-row
  `schema_version` integer to permit mixed-version reads during multi-step
  migrations.
  *Tests:* `tests/architecture/schema-versioning.spec.ts`,
  `tests/migration/user-version-bumps.spec.ts` (Phase 1+).

- **Daemon state never lives under plugin install paths.**
  The daemon root is `~/.agents-comm-bus/` (or an `$XDG_STATE_HOME`
  equivalent), never `<plugin-install>/...`. Survives plugin reinstall,
  uninstall, and version upgrade.
  *Tests:* `tests/architecture/state-path-isolation.spec.ts`.

- **Fanout discipline: hop counting + recently-seen dedupe + foreign-bot
  policy.**
  Every fanout decision is gated by (a) a hop counter to prevent loops,
  (b) a recently-seen message-id cache to prevent duplicate delivery, and
  (c) a foreign-bot policy that controls how messages from unknown bot
  identities are handled (default: drop with audit entry).
  *Tests:* `tests/architecture/fanout-hop-limit.spec.ts`,
  `tests/architecture/fanout-recently-seen.spec.ts`,
  `tests/architecture/foreign-bot-policy.spec.ts`.
