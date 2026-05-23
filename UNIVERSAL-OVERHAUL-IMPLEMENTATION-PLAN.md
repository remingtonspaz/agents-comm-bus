# Universal Interface Overhaul — v4 Implementation Plan

> **For Hermes:** Execute this plan phase-by-phase and task-by-task. Do not reintroduce v3 concepts that v4 explicitly retired. Do not omit migration, lifecycle, query, storage, or security work described in issue #7.

**Source proposal:** GitHub issue #7, `Universal interface: perpendicular agent and comm adapters meeting at a thin core` — **v4** body plus its linked discussion context from 2026-05-14 → 2026-05-15.

**Goal:** Update the repository from the current Claude-only / Telegram-owned-per-process shape to the v4 `agents-comm-bus` architecture: a long-lived per-user daemon, explicit account registrations, conversation inventory, unified Query handling, WebSocket-over-localhost IPC, SQLite + JSON1 structured state, JSONL transcripts/audit, and thin agent/comm adapters.

**Architecture:** Build a shared package `agents-comm-bus-core/` for types / routing / storage contracts, a daemon package `agents-comm-bus/` for MessageBus + SQLite + comm ownership, and agent-specific adapter clients for Claude and Codex. Existing MCP servers and hooks remain install surfaces but become thin IPC shims into the daemon.

**Tech stack:** Node.js 22+, TypeScript/Node, `node:sqlite`, localhost WebSocket IPC, JSONL transcript/audit files, filesystem attachment blobs, Claude hooks, Codex hooks/app-server, existing plugin manifests and installer scripts.

---

## Proposal guardrails — v4 non-negotiables

These are direct requirements from issue #7 v4. The implementation plan must preserve them exactly.

1. **Use the v4 names and roots.**
   - Daemon name: `agents-comm-bus`
   - State root: `~/.agents-comm-bus/`
   - Structured DB: `~/.agents-comm-bus/agents-comm-bus.db`
   - IPC: WebSocket-over-localhost, port discoverable via `~/.agents-comm-bus/port`

2. **Do not resurrect the v3 bindings model.**
   - `bindings.json` is retired as the routing model.
   - No implicit binding creation.
   - No specificity-tier routing.
   - No parent-walking / inherited project lookup.
   - Routing is explicit account registration lookup by `(comm, bot_user_id)`.

3. **Use four primary durable record types.**
   - `account_registrations`
   - `conversations`
   - `queries`
   - `sessions`

4. **Conversations are inventory, not routing state.**
   - One row per `(project, comm, account_label, chat_native_id, thread_native_id)`.
   - Inbound routing is not chosen from last-active heuristics.
   - The agent decides reply target from inbound envelope `ChatRef`.
   - Proactive sends default to most-recent-inbound for the session only when explicit target is omitted.

5. **Unified `Query` record replaces the ad hoc prompt split.**
   - Kinds: `approval | choice | freetext`
   - Separate non-query domains: `TurnControl` and `SlashCommand`
   - Resolved-once semantics
   - TTL / fail-closed semantics
   - At most one open query per session via partial unique index

6. **AgentAdapter connection lifetime is load-bearing.**
   - Long-lived control connection = session lease
   - Per-query blocking connection = query lease
   - Connection close is authoritative cleanup for stale sessions / queries
   - No application-level heartbeat in V1

7. **Storage engine is decided in v4.**
   - SQLite + JSON1 for structured state
   - JSONL for transcripts and audit
   - filesystem content-addressed attachments
   - `Storage` interface present for engine-swap optionality
   - `PRAGMA user_version` migrations
   - Node 22+ baseline

8. **Lifecycle remains plugin-first and self-bootstrapping.**
   - Default lifecycle is session-triggered lazy `ensureDaemon()`
   - Optional service install is phase 5 only
   - Daemon state must never live under plugin install paths

9. **Security / loop-prevention rules are first-class.**
   - default-deny cross-agent delivery
   - origin labels on every message
   - hop counting
   - recently-seen dedupe
   - foreign-bot policy

10. **Migration is explicit, not hand-waved.**
   - old layouts readable in a transition release
   - new layout becomes authoritative for writes
   - transition-only fallback behavior must be temporary and documented as such

---

## 1. Current repository scaffolding this plan must build from

The codebase is not blank. The v4 plan must grow from the repo’s current install surfaces and runtime seams.

### Existing Claude-side surfaces on `main`
- `.claude-plugin/plugin.json`
- `hooks/hooks.json`
- `hooks/telegram-context.js`
- `hooks/permission-telegram.cjs`
- `hooks/session-start.js`
- `mcp-server/server.js`
- `scripts/enter-watcher.ps1`
- `install.js`
- `install.sh`
- `INSTALL.bat`
- `README.md`
- `skills/telegram/SKILL.md`

### Existing Codex-side surfaces on `origin/codex`
- `.codex-plugin/plugin.json`
- `hooks/codex/user-prompt-submit.js`
- `hooks/codex/permission-request.js`
- `mcp-server/codex-app-server.js`
- `install-codex.js`
- Codex-specific README/install notes on that branch

### Existing behavior that must be retired or rehomed
- `mcp-server/server.js` currently owns Telegram polling itself.
- Session state is split under `~/.claude-telegram/` and `~/.codex-telegram/`.
- Queue / pending-permission / last-chat state is file-based and process-local.
- `last-chat.json` is acting as both “recent conversation memory” and “where should I reply?” heuristic.
- Permission / question flows are pragmatically implemented but not durably normalized.

### Why this matters
The implementation must preserve user-facing install / hook surfaces while moving ownership of:
- comm polling
- durable state
- query resolution
- cross-session correctness

into `agents-comm-bus`.

---

## 2. Target repository shape

Land the new architecture alongside the old entrypoints first. Only flip runtime ownership after tests and migration readers exist.

### New top-level packages / directories
- `agents-comm-bus-core/`
- `agents-comm-bus/`
- `core-daemon/adapters/agent/`
- `core-daemon/adapters/comm/`
- `core-daemon/bootstrap/`
- `core-daemon/ipc/`
- `core-daemon/storage/`
- `core-daemon/queries/`
- `core-daemon/migrations/`
- `core-daemon/cli/`
- `docs/architecture/`
- `tests/architecture/`
- `tests/migration/`

### Existing paths that become thin clients or agent-specific wrappers
- `mcp-server/server.js`
- `mcp-server/dist/server.js`
- `hooks/telegram-context.js`
- `hooks/permission-telegram.cjs`
- `hooks/session-start.js`
- `hooks/codex/*.js`
- `mcp-server/codex-app-server.js`
- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`
- install scripts and README/install docs

---

## 3. Phase 0 — Define the v4 core (no behavior change)

**Objective:** Freeze the exact v4 vocabulary and invariants in code and docs before any runtime ownership changes.

### Task 0.1 — Create `agents-comm-bus-core/` package skeleton

**Objective:** Establish the shared package used by the daemon and agent-side shims.

**Files:**
- Create: `agents-comm-bus-core/package.json`
- Create: `agents-comm-bus-core/tsconfig.json`
- Create: `agents-comm-bus-core/src/index.ts`

**Steps:**
1. Create the package with build / typecheck scripts.
2. Make import paths stable for both daemon and shim code.
3. Add package exports now so later tasks do not invent ad hoc import topology.

**Verify:**
- Package type-checks.
- A scratch import from `agents-comm-bus/` works.

### Task 0.2 — Define stable IDs and domain types

**Objective:** Encode issue #7 v4’s contract types exactly.

**Files:**
- Create: `agents-comm-bus-core/src/types.ts`
- Create: `agents-comm-bus-core/src/messages.ts`
- Create: `agents-comm-bus-core/src/queries.ts`

**Required types:**
- `AgentId`, `CommId`, `AccountId`, `SessionId`, `RequestId`, `MessageId`
- `ChatRef`
- `Attachment`
- `Message`
- `Query`
- `ResolvedDecision`
- `TurnControl`
- `SlashCommand`

**Steps:**
1. Copy the issue body’s field set exactly.
2. Preserve `ChatRef.account` from day one.
3. Preserve platform message IDs and reply references.
4. Keep `Attachment` as a value object, not path-only helper arguments.
5. Add schema-version support for every persistent record family.

**Verify:**
- All fields named in v4 are represented explicitly.
- No later phase must retrofit identity/routing/message metadata.

### Task 0.3 — Define the `account_registrations`, `conversations`, `queries`, and `sessions` record shapes

**Objective:** Make the data model concrete before any DB implementation.

**Files:**
- Create: `agents-comm-bus-core/src/records/account-registrations.ts`
- Create: `agents-comm-bus-core/src/records/conversations.ts`
- Create: `agents-comm-bus-core/src/records/queries.ts`
- Create: `agents-comm-bus-core/src/records/sessions.ts`
- Create: `agents-comm-bus-core/src/records/index.ts`

**Steps:**
1. Encode the durable field sets from the issue.
2. Preserve the conversation PK shape including `account_label` and `thread_native_id`.
3. Preserve the `origin_chat_id`, `source_message_id`, `ttl_seconds`, and `resolution` fields on `queries`.
4. Encode the session/lease metadata required by the connection-lifetime model.

**Verify:**
- Record definitions line up one-to-one with the issue body’s tables.

### Task 0.4 — Define adapter contracts and capability surfaces

**Objective:** Prevent agent/comm differences from turning into untyped daemon conditionals.

**Files:**
- Create: `agents-comm-bus-core/src/contracts/agent-adapter.ts`
- Create: `agents-comm-bus-core/src/contracts/comm-adapter.ts`
- Create: `agents-comm-bus-core/src/contracts/tool-registry.ts`
- Create: `agents-comm-bus-core/src/capabilities.ts`

**Steps:**
1. Encode the `AgentAdapter` and `CommAdapter` interfaces from the issue body.
2. Include `canWake`, `canSteer`, `canInterrupt`, `midTurnPolicy`, and supported query kinds.
3. Include connection-state hooks, pressure reporting, and idempotent send semantics for comm adapters.

**Verify:**
- Claude and Codex can be represented without special-casing the bus interface.
- Telegram and Matrix can be represented without bending the type system later.

### Task 0.5 — Define storage contracts and invariants

**Objective:** Lock in the v4 storage split before picking individual table migrations.

**Files:**
- Create: `agents-comm-bus-core/src/storage/storage.ts`
- Create: `agents-comm-bus-core/src/storage/migrations.ts`
- Create: `agents-comm-bus-core/src/storage/transcript-store.ts`
- Create: `agents-comm-bus-core/src/storage/audit-store.ts`
- Create: `agents-comm-bus-core/src/storage/blob-store.ts`

**Steps:**
1. Define a `Storage` interface that hides SQLite access.
2. Separate responsibilities:
   - SQLite + JSON1 for structured state
   - JSONL transcript / audit appenders
   - filesystem blob references for attachments
3. Include migration/version entrypoints using `PRAGMA user_version`.

**Verify:**
- No caller reaches around storage abstractions directly.
- The interface is narrow enough that alternative engines remain possible.

### Task 0.6 — Define query resolution rules and lease semantics

**Objective:** Replace legacy pending-file behavior with formal semantics.

**Files:**
- Create: `agents-comm-bus-core/src/query-semantics.ts`
- Create: `tests/architecture/query-resolution.test.ts`
- Create: `tests/architecture/session-lease.test.ts`

**Rules to encode:**
- at most one open query per session
- resolved-once semantics
- TTL fail-closed behavior
- same-chat match / other-chat queue behavior
- connection close clears stale query/session ownership

**Verify:**
- Tests prove the v4 semantics before daemon implementation starts.

### Task 0.7 — Define security and loop-prevention helpers

**Objective:** Codify the cross-agent safety model before transcript subscriptions or message fanout exist.

**Files:**
- Create: `agents-comm-bus-core/src/security.ts`
- Create: `tests/architecture/security-loop-prevention.test.ts`

**Rules to encode:**
- default-deny cross-agent delivery
- origin labels on every message
- hop count increment + drop threshold
- recently-seen dedupe window
- foreign-bot tagging/policy

**Verify:**
- The bus will have reusable helpers for these checks rather than ad hoc later patches.

### Task 0.8 — Write architecture docs and sequence diagrams

**Objective:** Make the v4 design executable by contributors without requiring rereading the issue thread.

**Files:**
- Create: `docs/architecture/sequence-telegram-to-claude.md`
- Create: `docs/architecture/sequence-telegram-to-codex.md`
- Create: `docs/architecture/sequence-query-roundtrip.md`
- Create: `docs/architecture/sequence-daemon-bootstrap.md`
- Create: `docs/architecture/storage-layout.md`
- Create: `docs/architecture/invariants.md`

**Must document:**
- Telegram inbound → Claude
- Telegram inbound → Codex via app-server wake
- Query approval with stale / incorrect replies rejected
- daemon bootstrap: probe → lock → spawn → reconnect
- state layout under `~/.agents-comm-bus/`

**Phase 0 exit criteria**
- v4 terms are represented in code and docs.
- tests exist for storage/query/security/routing invariants.
- no runtime ownership has changed yet.

---

## 4. Phase 1 — Daemon spike + Telegram-only + SQLite foundation

**Objective:** Make `agents-comm-bus` the only owner of Telegram polling and durable state while preserving plugin self-bootstrap UX.

### Task 1.1 — Create daemon package and canonical state path helpers

**Files:**
- Create: `agents-comm-bus/package.json`
- Create: `core-daemon/daemon.ts`
- Create: `core-daemon/paths.ts`
- Create: `core-daemon/config.ts`

**Steps:**
1. Define the daemon entrypoint.
2. Define canonical locations for:
   - `~/.agents-comm-bus/agents-comm-bus.db`
   - `~/.agents-comm-bus/agents-comm-bus.db-wal`
   - `~/.agents-comm-bus/agents-comm-bus.db-shm`
   - `~/.agents-comm-bus/audit/`
   - `~/.agents-comm-bus/chats/<conversation-id>/transcript.jsonl`
   - `~/.agents-comm-bus/chats/<conversation-id>/attachments/`
   - `~/.agents-comm-bus/daemon.pid`
   - `~/.agents-comm-bus/port`
   - `~/.agents-comm-bus/.spawn.lock`
3. Ensure no durable state path is derived from plugin install roots.

**Verify:**
- The daemon can print its resolved path layout deterministically.

### Task 1.2 — Implement `ensureDaemon()` bootstrap protocol

**Files:**
- Create: `core-daemon/bootstrap/ensure-daemon.ts`
- Create: `core-daemon/bootstrap/spawn-lock.ts`
- Create: `core-daemon/bootstrap/handshake.ts`
- Create: `tests/architecture/bootstrap-race.test.ts`

**Steps:**
1. Probe `ws://127.0.0.1:<port>` when `port` exists.
2. On failure, acquire `~/.agents-comm-bus/.spawn.lock` with `O_EXCL`.
3. Spawn daemon detached from the calling plugin install.
4. Wait for daemon to write `daemon.pid` and `port`, then re-probe.
5. Non-lock-holders spin/retry briefly rather than spawning duplicates.
6. If `daemon.pid` is stale, clean dead pid/port files and retry.

**Verify:**
- Two concurrent session starts converge on one daemon.
- Crash recovery is deterministic.

### Task 1.3 — Implement WebSocket IPC and protocol/version handshake

**Files:**
- Create: `core-daemon/ipc/server.ts`
- Create: `core-daemon/ipc/client.ts`
- Create: `core-daemon/ipc/protocol.ts`
- Create: `tests/architecture/ipc-versioning.test.ts`

**Handshake must include:**
- protocol version
- daemon version
- client/shim version
- plugin instance or equivalent diagnostic metadata

**Verify:**
- Compatible versions connect.
- Incompatible versions fail loudly with actionable messaging.

### Task 1.4 — Implement SQLite schema and migrations

**Files:**
- Create: `core-daemon/storage/sqlite.ts`
- Create: `core-daemon/storage/schema/001_initial.sql`
- Create: `core-daemon/storage/schema/runner.ts`
- Create: `tests/architecture/sqlite-schema.test.ts`

**Tables / constraints to land in the initial schema:**
- `account_registrations`
  - PK `(project, comm, agent, account_label)`
  - unique `(comm, bot_user_id)`
- `conversations`
  - PK `(project, comm, account_label, chat_native_id, thread_native_id)`
- `queries`
  - partial unique index on `(session_id) WHERE resolved_at IS NULL`
- `sessions`
- any support tables needed for idempotency keys / metadata / indexes

**Verify:**
- Schema enforces the v4 uniqueness and open-query invariants directly.

### Task 1.5 — Implement transcript, audit, and attachment stores

**Files:**
- Create: `core-daemon/storage/transcripts.ts`
- Create: `core-daemon/storage/audit.ts`
- Create: `core-daemon/storage/blobs.ts`
- Create: `tests/architecture/jsonl-and-blobs.test.ts`

**Steps:**
1. Append per-conversation transcript JSONL.
2. Append daily audit JSONL.
3. Store attachment blobs content-addressed on disk.
4. Make DB rows reference `conversation_id` and blob hashes rather than duplicating payloads.

**Verify:**
- Transcript and audit are append-only.
- Attachments can be referenced from both DB rows and transcript lines.

### Task 1.6 — Implement `MessageBus`

**Files:**
- Create: `core-daemon/bus.ts`
- Create: `tests/architecture/bus-invariants.test.ts`

**Responsibilities:**
- receive normalized inbound from comm adapters
- durably record before wake/dispatch
- resolve `(comm, bot_user_id)` to an account registration
- update conversation inventory timestamps / metadata
- create and resolve queries
- respect query wake suppression
- manage session leases from control connections
- classify and audit failures

**Verify:**
- Durable enqueue happens before wake.
- Query suppression works.
- Routing is registration-based, not old last-chat heuristics.

### Task 1.7 — Implement `TelegramCommAdapter` for V1

**Files:**
- Create: `core-daemon/adapters/comm/telegram.ts`
- Create: `tests/architecture/telegram-comm-adapter.test.ts`

**V1 scope:**
- one active account per `(project, agent, account_label)` registration
- inbound normalization with `bot_user_id` lookup key
- outbound text + attachment sends
- connection state hooks
- idempotency keys
- permanent vs transient failure classification
- durable-ack-before-cursor-advance behavior

**Verify:**
- Telegram polling exists only inside the daemon.
- A 403/blocked path is classified as permanent failure.

### Task 1.8 — Add registration CLI for v4’s explicit model

**Files:**
- Create: `core-daemon/cli/account-add.ts`
- Create: `core-daemon/cli/account-list.ts`
- Create: `core-daemon/cli/account-remove.ts`
- Create: `core-daemon/cli/index.ts`
- Create: `tests/architecture/account-registration-cli.test.ts`

**Steps:**
1. Add explicit account registration commands.
2. Gather/store credentials and metadata into `account_registrations`.
3. Resolve/store `bot_user_id` via adapter identity probe.
4. Refuse duplicate ownership on `(comm, bot_user_id)`.

**Verify:**
- Registration is explicit.
- No inbound path creates registrations implicitly.

### Task 1.9 — Convert `mcp-server/server.js` into a thin IPC shim

**Files:**
- Modify: `mcp-server/server.js`
- Modify: `mcp-server/dist/server.js` build output path/process
- Modify: `mcp-server/package.json`

**Steps:**
1. Remove direct Telegram polling ownership from the MCP server.
2. Keep existing tool surface but route to daemon IPC:
   - `telegram_send(message, [chat_id], [message_thread_id])`
   - `telegram_send_image(path, [caption], [chat_id], [message_thread_id])`
   - `telegram_check_messages()`
3. Add `list_conversations([comm], [limit])`.
4. Make omitted target behavior follow the v4 “most-recent-inbound for session or error” rule.

**Verify:**
- Starting many MCP shims does not create many Telegram pollers.
- New tool exists and is populated from `conversations` inventory.

### Task 1.10 — Ship daemon binary in plugin installs

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.codex-plugin/plugin.json` where phase-1 distribution support is needed
- Modify: `install.js`
- Modify: `install.sh`
- Modify: `INSTALL.bat`
- Modify: `README.md`

**Steps:**
1. Bundle the daemon code with plugin installs.
2. Document code-vs-state split clearly.
3. Document lazy spawn, restart, and upgrade behavior.
4. Keep `/plugin install` as the only required user-facing distribution step.

**Verify:**
- Plugin install path is still the default UX.
- No service install is required.

### Task 1.11 — Add transition migration readers

**Files:**
- Create: `core-daemon/migrations/legacy-readers.ts`
- Create: `core-daemon/migrations/import-last-chat.ts`
- Create: `core-daemon/migrations/import-pending-permission.ts`
- Create: `tests/migration/transition-readers.test.ts`

**Legacy inputs to support:**
- `<project>/.claude/telegram.json`
- `<project>/.codex/telegram.json`
- `~/.claude-telegram/<basename>-<hash>/`
- `~/.codex-telegram/<basename>-<hash>/`
- `last-chat.json`
- `pending-permission.json`

**Important rule:**
- transition-only fallback logic, if retained for one release, must be explicitly marked temporary and removed on the next cleanup pass.

**Phase 1 exit criteria**
- one daemon owns Telegram polling
- one SQLite DB owns structured state
- one MCP shim surface talks to the daemon
- explicit account registrations exist
- conversations inventory exists
- queries are durable records, not pending files
- plugin bootstrap UX still works

---

## 5. Phase 2 — Wrap Claude as `ClaudeAgentAdapter`

**Objective:** Move Claude-specific behavior behind the v4 agent contract without losing current hook UX.

### Task 2.1 — Create `ClaudeAgentAdapter`

**Files:**
- Create: `core-daemon/adapters/agent/claude.ts`
- Create: `tests/architecture/claude-agent-adapter.test.ts`

**Steps:**
1. Map Claude hook payloads to core message/query types.
2. Express Claude capabilities explicitly.
3. Keep terminal/watcher-specific wake behavior inside the adapter boundary.

**Verify:**
- Claude behavior is modelled as an adapter, not bus exceptions.

### Task 2.2 — Re-home Claude hook entrypoints

**Files:**
- Create: `hooks/claude/user-prompt-submit.js`
- Create: `hooks/claude/permission-request.js`
- Modify: `hooks/hooks.json`
- Retain wrappers or deprecation stubs for:
  - `hooks/telegram-context.js`
  - `hooks/permission-telegram.cjs`

**Steps:**
1. Move Claude-specific logic into Claude-named paths.
2. Make hook entrypoints call `ensureDaemon()` first.
3. Keep old paths only as compatibility wrappers if needed.

**Verify:**
- Hook wiring now points at Claude-specific adapter shims.

### Task 2.3 — Replace queue draining with daemon-backed inbound delivery

**Files:**
- Modify: `hooks/claude/user-prompt-submit.js`
- Modify: `core-daemon/adapters/agent/claude.ts`

**Steps:**
1. Remove direct queue-file reads.
2. Pull pending inbound from the daemon/session queue.
3. Inject inbound into Claude prompt context using the existing harness conventions.
4. Preserve chat envelope info so Claude can choose reply target explicitly.

**Verify:**
- Claude no longer owns inbound state files.

### Task 2.4 — Replace pending-permission flow with `Query`

**Files:**
- Modify: `hooks/claude/permission-request.js`
- Modify: `core-daemon/adapters/agent/claude.ts`
- Create: `tests/architecture/claude-query-roundtrip.test.ts`

**Steps:**
1. Map `PermissionRequest`, `AskUserQuestion`, `ExitPlanMode`, and `EnterPlanMode` into `Query` records.
2. Hold the per-query connection open until resolution or timeout.
3. Translate resolved `Query` decisions back into Claude-native hook return shapes.
4. Reject stale / wrong-chat / duplicate resolutions according to v4 rules.

**Verify:**
- The Claude prompt/approval path uses `queries`, not `pending-permission.json`.

### Task 2.5 — Re-scope watcher logic to Claude-only wake semantics

**Files:**
- Modify: `scripts/enter-watcher.ps1`
- Modify or retire: `hooks/session-start.js`
- Create: `docs/architecture/claude-wake-path.md`

**Steps:**
1. Keep watcher code only where Claude’s harness truly needs it.
2. Remove any remaining implication that watcher code owns comm state.
3. Make query wake suppression and normal turn wake behavior daemon-driven.

**Verify:**
- Watcher concerns are isolated to the Claude adapter path.

**Phase 2 exit criteria**
- Claude operates through the daemon.
- Claude query flows use `queries` records and connection lifetimes.
- `list_conversations` is usable from Claude’s tool surface.

---

## 6. Phase 3 — Move Codex onto the same v4 shape

**Objective:** Convert the Codex branch’s parallel stack into a first-class `CodexAgentAdapter` over the same daemon.

### Task 3.1 — Create `CodexAgentAdapter`

**Files:**
- Create: `core-daemon/adapters/agent/codex/adapter.ts`
- Create: `tests/architecture/codex-agent-adapter.test.ts`

**Steps:**
1. Map Codex hook/app-server semantics onto the shared agent contract.
2. Express `canWake`, `canSteer`, `canInterrupt`, and `midTurnPolicy` explicitly.
3. Preserve Codex-specific wake behavior inside the adapter.

**Verify:**
- Codex fits the shared contract without parallel state stacks.

### Task 3.2 — Convert Codex hook entrypoints to daemon clients

**Files:**
- Modify: `hooks/codex/user-prompt-submit.js`
- Modify: `hooks/codex/permission-request.js`
- Modify: `install-codex.js`

**Steps:**
1. Call `ensureDaemon()` before hook work.
2. Remove direct dependence on `~/.codex-telegram/` runtime ownership.
3. Route prompts/approvals through daemon-backed inbound and `Query` flows.

**Verify:**
- Codex no longer owns its own comm/session state tree.

### Task 3.3 — Convert `mcp-server/codex-app-server.js` wake flow into capability-driven dispatch

**Files:**
- Modify: `mcp-server/codex-app-server.js`
- Modify: `core-daemon/adapters/agent/codex.ts`
- Create: `tests/architecture/codex-turn-control.test.ts`

**Steps:**
1. Make `turn/start` the Codex wake path.
2. Prepare `turn/steer` as the v4 `midTurnPolicy = steer` path.
3. Ensure the bus consults capabilities rather than hardcoding Codex-specific logic.

**Verify:**
- Wake/steer semantics are routed through the shared contract.

### Task 3.4 — Remove architecture dependence on `--agent=codex` split and old dir split

**Files:**
- Modify: migration readers / install flow / Codex adapter docs
- Create: `docs/architecture/codex-migration.md`

**Steps:**
1. Treat old Codex-specific dir layout as migration input only.
2. Keep agent identity in adapter/session metadata, not in top-level state roots.
3. Update documentation accordingly.

**Phase 3 exit criteria**
- Claude and Codex share one daemon and one durable state root.
- Codex-specific behavior is adapter/capability based.
- old Codex runtime split survives only for migration compatibility.

---

## 7. Phase 4 — Multi-account Telegram + Matrix + controlled transcript sharing

**Objective:** Prove the v4 abstraction with the first non-Telegram comm while keeping agent adapters unchanged.

### Task 4.1 — Extend Telegram comm support for multiple registered accounts

**Files:**
- Modify: `core-daemon/adapters/comm/telegram.ts`
- Modify: `core-daemon/storage/sqlite.ts`
- Create: `tests/architecture/multi-account-telegram.test.ts`

**Steps:**
1. Support multiple registered Telegram accounts per daemon.
2. Keep uniqueness on `(comm, bot_user_id)`.
3. Preserve conversation separation by `account_label` and thread.

**Verify:**
- shared-room scenarios remain unambiguous because `account_label` is part of conversation identity.

### Task 4.2 — Implement `MatrixCommAdapter`

**Files:**
- Create: `core-daemon/adapters/comm/matrix.ts`
- Create: `tests/architecture/matrix-comm-adapter.test.ts`

**Steps:**
1. Normalize Matrix inbound/outbound into the same `Message` / `ChatRef` contract.
2. Reuse existing account registration, conversation inventory, query, and transcript machinery unchanged.

**Verify:**
- Agent adapters do not need edits for Matrix support.

### Task 4.3 — Add transcript subscription policy layer

**Files:**
- Create: `core-daemon/subscriptions.ts`
- Create: `tests/architecture/subscription-policy.test.ts`

**Steps:**
1. Implement explicit opt-in transcript subscriptions.
2. Apply default-deny policy by default.
3. Enforce origin labels, hop limits, dedupe, and foreign-bot rules on fanout.

**Verify:**
- Cross-agent delivery is explicit and guarded.

**Phase 4 exit criteria**
- Multi-account Telegram works.
- Matrix works without agent-adapter rewrites.
- Transcript sharing obeys the v4 security model.

---

## 8. Phase 5 — Optional service install

**Objective:** Add always-on daemon support without changing the default session-spawned lifecycle.

### Task 5.1 — Add CLI for service installation

**Files:**
- Create: `core-daemon/cli/install-service.ts`
- Create: `core-daemon/cli/uninstall-service.ts`
- Create: `tests/architecture/service-cli.test.ts`

### Task 5.2 — Add platform-specific service wrappers

**Files:**
- Create: `agents-comm-bus/service/windows/*`
- Create: `agents-comm-bus/service/macos/*`
- Create: `agents-comm-bus/service/linux/*`

### Task 5.3 — Document service mode as optional only

**Files:**
- Modify: `README.md`
- Modify: install/troubleshooting docs

**Phase 5 exit criteria**
- service mode exists as a power-user convenience
- phase-1 session bootstrap remains the default lifecycle path

---

## 9. Cross-cutting workstream — migration

This is not a late cleanup task. It must move in parallel with phases 1–3.

### Migration Task M1 — Enumerate the full compatibility surface

**Files:**
- Create: `docs/architecture/migration-plan.md`

**Must enumerate:**
- `<project>/.claude/telegram.json`
- `<project>/.codex/telegram.json`
- `~/.claude-telegram/*`
- `~/.codex-telegram/*`
- `last-chat.json`
- `pending-permission.json`
- plugin install paths
- generated `dist/server.js` usage

### Migration Task M2 — Add a daemon-guided migration command

**Files:**
- Create: `core-daemon/cli/migrate.ts`
- Create: `tests/migration/migrate-command.test.ts`

**Requirements:**
- credentials migration requires explicit user confirmation
- state ingestion can be read-only and automatic on first run
- migration result is auditable

### Migration Task M3 — Make transition-only fallback behavior explicit and temporary

**Files:**
- Create: `docs/architecture/transition-release.md`
- Create: `tests/migration/transition-fallback.test.ts`

**Important rule:**
Any standalone fallback retained for a transition release must be:
- documented as temporary
- test-covered
- removed in the next scheduled cleanup release

---

## 10. Cross-cutting workstream — testing / invariants

The issue already specifies the right first invariants. Turn them into continuous tests.

### Required invariant tests

Number these because the invariants become implementable at different points.
Do not block early pure tests on later daemon/storage work.

1. **No implicit cross-agent delivery.**
   - Earliest valid point: Phase 0, after `security.ts`.
   - Coverage: pure helper tests first; bus-level fanout coverage in Phase 4.
2. **Stale query responses are rejected.**
   - Earliest valid point: Phase 0, after `query-semantics.ts`.
   - Coverage: expired, already-resolved, wrong-chat, wrong-reply-target.
3. **Partial unique index enforces one open query per session.**
   - Earliest valid point: Phase 1 Task 1.4, after SQLite schema exists.
   - Phase 0 may only test the producer-side preflight predicate.
4. **One comm owner per `(comm, account)`.**
   - Earliest valid point: Phase 1 Task 1.4 / 1.8, after
     `account_registrations` schema and account CLI/storage exist.
5. **Deterministic inbound routing by account registration.**
   - Earliest valid point: Phase 1 Task 1.6 / 1.7, after bus routing and the
     Telegram adapter exist.
6. **Durable enqueue before wake.**
   - Earliest valid point: Phase 1 Task 1.6 / 1.9, after storage, transcript
     appenders, bus dispatch, and MCP shim wake behavior exist.
7. **Pending `Query` survives restart.**
   - Earliest valid point: Phase 1 Task 1.4 plus query persistence paths.
   - Full restart coverage lands once daemon bootstrap exists.
8. **Permanent failure clears only the affected route/account state.**
   - Earliest valid point: Phase 1 Task 1.7, after comm failure
     classification and bus error handling exist.
9. **Same-project second same-agent session is refused while the first lease is live.**
   - Earliest valid point: Phase 2 Task 2.2 for Claude; repeat/extend in
     Phase 3 for Codex.

**Files:**
- `tests/architecture/bus-invariants.test.ts`
- `tests/architecture/restart-survival.test.ts`
- `tests/architecture/query-staleness.test.ts`
- `tests/architecture/same-project-lease-collision.test.ts`

---

## 11. Cross-cutting workstream — documentation and install UX

### Doc Task D1 — Rewrite README around the daemon architecture

**Must cover:**
- what changed from the old MCP-owned polling model
- explicit account registration
- `list_conversations`
- state path vs plugin code path
- default session-spawned bootstrap
- optional service mode

### Doc Task D2 — Add operational troubleshooting docs

**Must cover:**
- stale pid/port file recovery
- duplicate registration conflicts on `(comm, bot_user_id)`
- protocol/version mismatch symptoms
- migration troubleshooting
- query timeout behavior

### Doc Task D3 — Add contributor architecture map

**Must cover:**
- core package responsibilities
- daemon responsibilities
- agent adapter responsibilities
- comm adapter responsibilities
- where Claude-only watcher logic lives after the rewrite

---

## 12. Recommended execution order

The cross-cutting workstreams are not cleanup phases. Interleave them at the
first point where each item is testable without faking daemon behavior.

1. **Phase 0 tasks 0.1-0.8.**
   - Establish core vocabulary, contracts, query semantics, security helpers,
     storage contracts, and architecture docs.
   - Add Section 10 items 1 and 2 here:
     - no implicit cross-agent delivery
     - stale query responses are rejected
   - Add only producer-side/pure coverage for item 3 here; real SQLite coverage
     waits for Phase 1.
2. **Migration Task M1.**
   - Enumerate the full legacy compatibility surface before daemon paths,
     account registration, or install behavior are implemented.
   - This must happen before Phase 1 path helpers and transition readers, not
     after them.
3. **Phase 1 tasks 1.1-1.5.**
   - Create the daemon package, bootstrap skeleton, IPC protocol, SQLite schema,
     transcript store, audit store, and blob store.
   - Add Section 10 storage tests as soon as the schema lands:
     - item 3: SQLite partial unique index for one open query per session
     - item 4: one comm owner per `(comm, account)`
     - item 7: pending `Query` survives restart, at least at storage level
4. **Phase 1 tasks 1.6-1.9.**
   - Implement bus routing, Telegram comm ownership, account CLI, and MCP shim
     behavior.
   - Add Section 10 bus tests as soon as the behavior exists:
     - item 5: deterministic inbound routing by account registration
     - item 6: durable enqueue before wake
     - item 8: permanent failure clears only affected route/account state
5. **Phase 1 tasks 1.10-1.11.**
   - Ship daemon binary through plugin installs and add transition migration
     readers.
   - Add/extend restart-survival coverage for item 7 against daemon bootstrap.
6. **Migration Task M2.**
   - Add the daemon-guided migration command after account registration,
     storage, audit, and transition readers exist.
   - Cover explicit credential confirmation, read-only first-run state
     ingestion, and auditable migration results.
7. **Migration Task M3.**
   - Document and test transition-only fallback behavior before converting
     Claude or Codex runtime surfaces.
   - Any fallback retained beyond this point must have a cleanup release named.
8. **Phase 2 tasks 2.1-2.5.**
   - Convert Claude hooks/MCP behavior to daemon clients.
   - Add Section 10 item 9 for Claude:
     - same-project second same-agent session is refused while the first lease
       is live.
9. **Phase 3 tasks 3.1-3.4.**
   - Convert Codex hooks/app-server behavior to daemon clients.
   - Extend Section 10 item 9 for Codex and rerun items 1, 5, 6, and 7 across
     both agents.
10. **Phase 4 tasks 4.1-4.3.**
    - Add multi-account, Matrix, and transcript subscription behavior.
    - Re-run/extend Section 10 items 1, 4, 5, 6, and 8 for multi-account and
      multi-comm cases.
11. **Phase 5 tasks 5.1-5.3.**
    - Add optional service install support while preserving session-spawned
      bootstrap as default.
    - Add service-mode restart checks for Section 10 item 7.
12. **Cleanup release.**
    - Remove transition-only fallback/readers only after the documented
      transition release window closes.
    - Re-run the full Section 10 invariant suite after removing them.

---

## 13. Definition of done

The v4 overhaul is complete only when all of the following are true:

- `agents-comm-bus` is the only owner of each `(comm, account)` connection.
- durable structured state lives in SQLite + JSON1 under `~/.agents-comm-bus/agents-comm-bus.db`.
- transcripts and audit are JSONL; attachments are filesystem blobs.
- account registration is explicit and enforced by schema constraints.
- conversations are inventory rows, not routing rules.
- queries are durable, TTL-governed, resolved-once records.
- session and query leases are driven by IPC connection lifetime.
- Claude and Codex both run through agent adapters over the same daemon.
- Telegram and Matrix both run through comm adapters over the same daemon.
- `list_conversations` exists and is useful for agent introspection.
- default-deny cross-agent delivery, origin labels, hop limits, dedupe, and foreign-bot rules are enforced.
- plugin install remains the default bootstrap path.
- optional service install exists but is not required.
- old layouts are readable only for the planned transition window and are then removable cleanly.

---

## 14. What changed from the old plan and must now be reflected in implementation

This update is not cosmetic. The old plan must be considered obsolete anywhere it still assumes:

- `agents-comm` instead of `agents-comm-bus`
- socket/named-pipe ambiguity instead of localhost WebSocket
- `bindings.json` as the routing primitive
- parent-walk / inherited project lookup
- append-only JSON files as the primary structured store
- query/permission handling as separate ad hoc mechanisms
- session ownership modeled outside connection lifetime
- MCP tools without `list_conversations`

Any implementation step still relying on those assumptions should be rewritten before coding begins.
