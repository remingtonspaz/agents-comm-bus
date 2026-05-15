# Storage layout

All persistent daemon state lives under a single root directory, by
default `~/.agents-comm-bus/`. This root is **never** placed inside a
plugin install path — see the corresponding entry in
[invariants](./invariants.md) and the rationale in
[daemon bootstrap](./sequence-daemon-bootstrap.md).

This separation gives three properties at once:

- **Survives plugin reinstall.** Wiping the plugin install directory
  does not wipe conversation history.
- **One daemon per user.** All sessions for a given OS user share one
  database, one port, one audit stream.
- **Trivial backup.** The entire root is portable; `tar`ing it produces
  a complete snapshot of bus state.

## Filesystem tree

```
~/.agents-comm-bus/
  agents-comm-bus.db          # SQLite (WAL mode, JSON1 extension assumed)
  agents-comm-bus.db-wal      # SQLite WAL file
  agents-comm-bus.db-shm      # SQLite shared-memory file
  daemon.pid                  # PID of the running daemon (or stale, see bootstrap doc)
  port                        # WebSocket port the daemon is listening on
  .spawn.lock                 # O_EXCL lock used during concurrent daemon spawn
  audit/
    audit-YYYY-MM-DD.jsonl    # daily-rotated append-only audit log
  chats/
    <conversation-id>/
      transcript.jsonl        # append-only message transcript
      attachments/
        <sha256>              # content-addressed binary attachments
```

## Three storage tiers

The system uses three different storage technologies on purpose, each for
the property it provides:

| Tier            | Used for                                  | Why                                                                |
|-----------------|-------------------------------------------|--------------------------------------------------------------------|
| SQLite + JSON1  | structured queryable state                | indexed lookups by `(comm, bot_user_id)`, by `session_id`, etc.   |
| JSONL files     | append-only history (transcripts, audit)  | crash-safe append, no schema migration cost, trivial to tail/grep |
| Filesystem blobs| binary attachments                        | OS-level dedup via content addressing, no SQLite blob bloat       |

Database rows **reference** blob hashes; they never duplicate blob payloads.
A 4 MB screenshot lives in `chats/<conv>/attachments/<sha256>` once, and
any message referencing it stores just the 64-character hash.

## Tables

All tables use `PRAGMA user_version` for migration management. Every
persistent record family also carries a per-row `schema_version` integer
to permit lazy / mixed-version reads during multi-step migrations. See the
corresponding invariant entries in [invariants](./invariants.md).

### `account_registrations`

The routing table. Maps an external comm identity to an internal account
and agent target.

- **Primary key:** `account_id` (synthetic).
- **Unique constraint:** `(comm, bot_user_id)`. This enforces the
  *one comm owner per `(comm, account)` registration* invariant — the same
  bot cannot be claimed by two accounts.
- **Schema version:** stored both in `PRAGMA user_version` (table-level)
  and in a per-row `schema_version` column.

Routing for an inbound message is `SELECT account_id, agent, session_id
FROM account_registrations WHERE comm = ? AND bot_user_id = ?` — a single
indexed lookup. No fallback heuristics.

### `conversations`

Inventory of known conversations (chat threads). One row per
`(comm, chat_id)` pair the daemon has ever observed.

- **Primary key:** `conversation_id` (synthetic).
- **Unique constraint:** `(comm, external_chat_id)`.
- **Schema version:** per-row column.

This table is **inventory, not routing**. The presence of a conversation
row does not authorize delivery; that decision is made by the
`account_registrations` lookup. See the invariant
*conversations are inventory, not routing rules*.

### `queries`

Open and historical query records (approval / choice / freetext).

- **Primary key:** `query_id` (synthetic).
- **Partial unique index:** `(session_id) WHERE status = 'open'`. This
  is the *at-most-one-open-per-session* enforcement, checked by the DB
  rather than by application code.
- **Other columns of interest:** `kind`, `status` (`open` /
  `resolved` / `expired` / `cancelled`), `origin_chat_ref`, `ttl_ms`,
  `created_at`, `resolved_at`, `resolution` (JSON).
- **Schema version:** per-row column.

See the full lifecycle in [query roundtrip](./sequence-query-roundtrip.md).

### `sessions`

Active and historical agent sessions.

- **Primary key:** `session_id` (synthetic).
- **Other columns:** `agent` (`claude` / `codex` / ...), `capabilities`
  (JSON), `mid_turn_policy`, `lease_connection_id`, `started_at`,
  `ended_at`.
- **Schema version:** per-row column.

A session is `active` iff its `lease_connection_id` points to a still-open
control connection. Connection close = session ended. There is no
application-level heartbeat; see invariant *session/query leases bound to
IPC connection lifetime*.

## Audit log

`audit/audit-YYYY-MM-DD.jsonl` is append-only and rotated daily. One JSON
object per line. Records every authorization decision, every routing
lookup, every query open/resolve/expire, and every cross-agent delivery
attempt (allowed or denied). This stream is the source of truth for
"what did the daemon decide to do?" — distinct from `transcript.jsonl`
which records "what did the user and the agent say to each other?"

## Per-conversation transcripts

`chats/<conversation-id>/transcript.jsonl` is the append-only message
history for one conversation. Used by the audit invariants and by debug
tooling. The structured `messages` data lives in SQLite for indexed query;
the transcript file is the human-greppable mirror.
