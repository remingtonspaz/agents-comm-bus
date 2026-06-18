# Pi host integration checklist

Date: 2026-06-17
Status: actionable checklist companion to [README.md](./README.md).

Each item maps to a concrete deliverable. Tick boxes as work lands. Items are
grouped by phase; phases are sequential unless noted.

Legend:
- [ ] not started
- [~] in progress
- [x] done
- [!] blocked / needs decision

---

## Phase 0 — design lock

- [x] Confirm Pi session identity strategy. **Resolved** — derive from
      `ctx.sessionManager.getSessionId()` as `pi_<uuid>`. No hashing, no cwd
      fallback. See README § Pi session identity.
- [x] Confirm distribution shape for the Pi package. **Resolved — Option B**
      of `docs/research/install-model.md`. Source of truth in
      `plugins/pi/agents-comm/`; dedicated full-package-mirror Pi repo for
      releases; local-path install for dev. See README § Distribution
      (Option B).
- [x] Confirm whether Pi package ships one combined skill set or per-comm
      packages reusing a shared base. **Resolved — one combined package**
      mirroring the Option B full-package shape; per-comm skills live as
      siblings under `skills/`.
- [x] Confirm `agent = "pi"` as the canonical AgentId string in registrations
      and CLI usage. **Resolved** — use `"pi"`.

## Phase 1 — daemon bridge MVP

### 1.1 Pi bridge module

- [x] Create `core-daemon/bridges/pi/bridge.ts`
- [x] Implement `PiBridgeFactory` (`agentId = "pi"`, `create(context)`)
- [x] Implement `PiBridge` class implementing `AgentBridge`:
  - [x] `readonly agentId = "pi"`
  - [x] `readonly ipcMethods = new Set(["pi_register_session", "pi_drain_inbound", "pi_unregister_session"])`
  - [x] `attach(comms)` — no-op or minimal for MVP (no wake watcher)
  - [x] OMIT optional bridge methods (`attachComm`/`detachComm`/
        `invalidateRegistrationCaches`/`onInboundConversation`) — only
        `agentId`/`ipcMethods`/`attach()`/`handleIpcMethod` are required; a
        no-op `attach()` is fine for MVP (Pi needs no resolve-sink/onCallback yet)
  - [x] `handleIpcMethod(method, params, ctx)` — dispatch to the three methods
- [x] Decide whether to split into `inbound.ts` / `session.ts` / `query.ts`
      later; keep one file for MVP. (Kept one file for MVP.)

### 1.2 `pi_register_session`

- [x] Validate `session` and `project` params
- [x] Read **stable per-runtime `connection_id`** from params (extension-
      generated; see README § Bridge correctness requirements #1)
- [x] Normalize project path via shared project normalizer
- [x] **Ordering: ensure-comms LAST** (AGE-38/AGE-45): upsert → acquireLease
      → wire state + socket-close handler → `ensureCommsBestEffort` LAST
- [x] Upsert session row with `agent = "pi"`
- [x] **Stamp daemon-owner identity** via
      `sessionLeaseOwnerWithDaemon(sessionLeaseOwnerFromParams(params),
      this.options.daemonOwner)` when calling `acquireSessionLease` (AGE-58,
      load-bearing for boot-scope-restore — see README § `pi_register_session`)
- [x] `acquireSessionLease` uses the stable `connection_id` (not a bridge-
      generated random id) so `registerReplay` re-acquires after daemon crash
- [x] Wire socket-close handler that releases lease on clean close
      (mirror `claude/bridge.ts:388-390`)
- [x] `PiBridgeFactory.create(context)` threads `context.daemonOwner` into
      `PiBridgeOptions.daemonOwner` (mirror `codex/bridge.ts:984`)
- [x] Return `{ ok, session, project, agent }`
- [x] Idempotent on repeated registration (hooks/extension re-register often)

### 1.3 `pi_drain_inbound`

- [x] Resolve scope from `storage.getSession(session)` (NOT caller-supplied
      `project`); reject/no-op on mismatch
- [x] Reuse shared `ownedAccountKeys(session)` scoping helper
      (`claude/bridge.ts:315`) — do not reimplement `(project, agent)` scoping
- [x] Drain only entries owned by Pi registrations
- [x] Honor `limit`
- [x] Honor optional `comm` filter without sweeping other comms' entries
- [x] Remove drained entries by composite key `(message_id, comm, account)`
- [x] **Stamp `most_recent_inbound`** = `drained[last].conversation.conversation_id`
      via `storage.setSessionMostRecentInbound(...)` (mirror
      `claude/bridge.ts:404-408`) — load-bearing: Pi's no-op
      `onInboundConversation` means drain is the ONLY place this gets set;
      without it every no-target `comm_send_message` throws
      (`bus.ts:632-635`)
- [x] Return `{ messages: PendingInboundEntry[] }`

### 1.4 `pi_unregister_session`

- [x] Resolve session by `storage.getSession(session)` (NOT caller-supplied
      `project`); reject/no-op on mismatch
- [x] `storage.releaseSessionLease(session, connectionId, now)` — `connectionId`
      MUST be the same stable id used at register so the daemon matches the
      lease row
- [x] Clears owner/lease metadata so boot-scope-restore will not try to
      restore a released Pi scope
- [x] Untrack session from bridge-internal state
- [x] Idempotent (no-op on already-released session)
- [x] Return `{ ok: true }`
- [x] No protocol-layer edit (method-name-agnostic dispatch; see README §
      Session replacement & lease release / "Why no protocol-layer edit")

### 1.5 Composition root wiring

- [x] Import `PiBridgeFactory` in `core-daemon/serve.ts`
- [x] Add `new PiBridgeFactory()` to `agentBridgeFactories`
- [x] Verify no comm-neutral invariants break (daemon.ts must stay Pi-agnostic)

### 1.6 Daemon build + assets

- [x] `npm run build` in `agents-comm-bus/` compiles the new bridge
- [x] `npm run verify:clean-build` passes (tracked artifacts in sync)
- [x] `npm run check:ipc-protocol` — bump `IPC_PROTOCOL_VERSION` major if the
      wire schema changed in a backward-incompatible way; otherwise add
      `IPC_COMPAT_NOTE` if additive  (Confirmed: protocol unchanged vs `main`
      — additive `pi_*` methods only. Note the gate's default base ref is
      `origin/universal-overhaul`, which lags `main`; run with `-- main` for
      an accurate comparison.)
- [x] Bump `DAEMON_VERSION` via `npm run bump:daemon` if required by the
      version-bump gate  (0.2.28 -> 0.2.29)

## Phase 2 — daemon bridge tests

### 2.1 Architecture test scaffold

- [x] Create `tests/architecture/pi-bridge.test.ts`
- [x] Reuse existing test harness/fakes from `claude-hooks.test.ts` /
      `codex-agent-adapter.test.ts` where possible

### 2.2 Registration tests

- [x] `pi_register_session` calls `ensureCommsForSession(project, "pi")`
- [x] Session row upserted with `agent = "pi"`
- [x] Repeated registration is idempotent (no duplicate rows, no errors)
- [x] Missing/invalid params fail loudly and predictably
- [x] Owner stamping reflects host-supplied pid/label + daemon identity
- [x] **Daemon-owner identity stamped** (AGE-58): the lease row carries
      `daemon.{discovery_root,checkout_root,state_root,daemon_bin,authority_rank}`
      from `context.daemonOwner`, not null — otherwise
      `classifySessionDaemonOwner` returns `"missing"` and boot-scope-restore
      fails-closed for Pi (`skipped_no_daemon_owner`)

### 2.3 Drain tests

- [x] `pi_drain_inbound` returns only Pi-scoped entries
- [x] Does not cannibalize Claude or Codex pending inbound
- [x] Honors `limit`
- [x] Honors `comm` filter; non-matching comms' entries stay queued
- [x] Removes by `(message_id, comm, account)` composite key
- [x] Same message_id across two bots in one chat does not wipe the sibling
      entry (the AGE-15 / multi-agent invariant)
- [x] **Most-recent stamp**: after drain, session row's
      `most_recent_inbound_conversation_id` = last drained conversation
- [x] **No-target send routes to drained conversation**: after drain, a
      `comm_send_message` with no `target` resolves via `targetFromSession`
      to that conversation (does not throw "no most-recent inbound")
- [x] Wrong-project drain (`project` mismatch) is rejected/no-op and cannot
      affect another scope

### 2.4 Unregister tests

- [x] `pi_unregister_session` releases the lease + untracks (using the SAME
      stable `connection_id` as register)
- [x] Idempotent (no error on already-released session)
- [x] Does not release a different session's lease
- [x] After unregister, a fresh `pi_register_session` for the same UUID
      re-acquires cleanly (simulating `/new` then later `/resume` back)
- [x] Wrong-project unregister is rejected/no-op and cannot affect another scope
- [x] After unregister, boot-scope-restore does NOT restore the released
      scope (owner/lease metadata cleared)

### 2.4b Connection-id replay tests

- [x] Register with stable `connection_id`, simulate daemon crash (no clean
      socket close), replay `pi_register_session` with the SAME id →
      `acquireSessionLease` re-acquires (WHERE `IS NULL OR = ?` matches)
- [x] Replay with a DIFFERENT random id → re-acquire fails (proves the
      stable id is load-bearing, not just a nicety)
- [x] Boot-restore restores Pi scope ONLY when the daemon-owner discovery
      root matches (AGE-58 stamp)

### 2.5 Build gate

- [x] `npm test` (default suite) passes  (674 pass / 0 fail / 1 skipped)
- [x] `npm run test:bridge` passes with the new Pi suite included  (12 pass / 0 fail)

## Phase 3 — Pi package skeleton

### 3.1 Package files

- [x] Package source lives under `plugins/pi/agents-comm/` in the monorepo
      (parallel to `plugins/claude/<comm>/` and `plugins/codex/<comm>/`).
- [x] Create `package.json` with:
  - [x] `name`, `keywords: ["pi-package"]`
  - [x] `pi` manifest pointing at `./extensions` and `./skills`
  - [x] `peerDependencies` for `@earendil-works/pi-coding-agent`,
        `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox` at `"*"`
  - [x] `dependencies` for any runtime deps (e.g. ws, if needed directly)
- [x] Create `README.md` for the package

### 3.1b Release sync (Option B)

- [ ] **Resolve packaging-shape gap** (cross-review 2026-06-17): existing
      `scripts/stage-plugins.js` is per-`(agent, comm)` with one adapter bundle
      each; the one-package-all-comms Pi shape needs either (a) a new Pi staging
      path assembling all adapter bundles + `adapter_bundle_versions` + its
      own production-install/verify gate, or (b) a switch to per-comm Pi
      packages reusing the current model. Not an MVP code blocker; must be
      resolved before the first real release. See README § Release-pipeline gap.
- [ ] Dedicated Pi package repo exists (root = the Pi package).
- [ ] CI step syncs `plugins/pi/agents-comm/` → dedicated repo root on each
      release tag (full-package mirror, not a manifest bump).
- [ ] Verify `pi install git:github.com/<you>/pi-agents-comm@v1` works from
      the synced repo.
- [ ] Production-install test for the chosen Pi artifact shape (verifies the
      staged bundle set + install stamp).
- [ ] (Optional) publish to npm and verify `pi install npm:@<scope>/pi-agents-comm`.

### 3.2 Extension module layout

- [x] `extensions/agents-comm/index.ts` — entrypoint
- [x] `extensions/agents-comm/daemon-client.ts`
- [x] `extensions/agents-comm/session-id.ts`
- [x] `extensions/agents-comm/inbound-format.ts`
- [x] `extensions/agents-comm/tools.ts`
- [x] `extensions/agents-comm/commands.ts` (optional for MVP)

## Phase 4 — Pi extension core

### 4.1 Daemon client wrapper (`daemon-client.ts`)

- [ ] Own a `PersistentIpcClient` from
      `agents-comm-bus/dist/core-daemon/ipc/persistent-client.js` (in-process
      WS, not a sidecar)
- [ ] `start()` on `session_start`, `close()` on `session_shutdown`
- [ ] `registerReplay("pi_register_session", ...)` so daemon restarts
      transparently re-register the session + lease
- [ ] `registerPiSession(params)` -> `pi_register_session`
- [ ] `drainPiInbound(params)` -> `pi_drain_inbound`
- [ ] `sendCommMessage(params)` -> `${comm}_send`
- [ ] `sendCommAttachment(params)` -> `${comm}_send_image`
- [ ] `unregisterPiSession(params)` -> `pi_unregister_session`
- [ ] `listConversations(params)` -> `list_conversations`
- [ ] Surface `DisconnectedError` concisely to tools/poller (do not crash
      the extension; client auto-reconnects in background)

### 4.1b Dev mode (see README § Dev mode)

- [ ] `daemon-client.ts` calls the shared `entryEnsures` from
      `hosts/common/install/entry-ensures.js` — do NOT hand-roll env detection
- [ ] Pass `fromDir: import.meta.dirname` so the project-root walk resolves
      `.agents-comm-bus-dev.json` in dev and falls through to strict prod
- [ ] In dev, daemon runs from `agents-comm-bus/dist/core-daemon/serve.js`;
      state root `.agents-comm-bus-dev/`; discovery `.agents-comm-bus-discovery/`
- [ ] In prod, `entryEnsures` bootstraps the central daemon at
      `~/.agents-comm-bus/` (no dev marker present)
- [ ] Comm-resource leases stay homedir/global in both modes (dev and prod
      arbitrate the same bot leases)
- [ ] Released package excludes `.agents-comm-bus-dev.json`,
      `.agents-comm-bus-discovery/`, and dev-local `.pi/settings.json`
- [ ] `package.json` declares `agents-comm-bus` in `dependencies` so prod
      resolves from `node_modules/`; dev resolves from the monorepo workspace

### 4.2 Session identity (`session-id.ts`)

- [ ] Implement `piSessionId(sm)` = `pi_${sm.getSessionId()}`
- [ ] No hashing, no cwd fallback, no env override
- [ ] Read fresh inside each `session_start` (do not cache across reload)

### 4.3 Inbound formatting (`inbound-format.ts`)

- [ ] Port the `[Daemon Inbound Messages] ... [End Daemon Inbound Messages]`
      block format from `hosts/claude/hooks/user-prompt-submit.js`
- [ ] Include envelope fields: `comm`, `account`, `account_label`,
      `chat_native_id`, `thread_native_id`, `conversation_id`,
      `platform_message_id`, `message_id`
- [ ] Format attachment lines (mime, filename, size, local_path / blob_hash)
- [ ] No Pi-specific envelope fields — keep parity with Claude/Codex

### 4.4 Extension entrypoint (`index.ts`)

- [ ] Register all comm tools on load
- [ ] `session_start` handler:
  - [ ] compute/restore stable Pi session id via `piSessionId(ctx.sessionManager)`
  - [ ] `client.start()` the `PersistentIpcClient`
  - [ ] `client.registerReplay("pi_register_session", ...)`
  - [ ] start inbound polling loop
  - [ ] optional `ctx.ui.notify` in TUI mode
- [ ] `session_shutdown` handler (reason-branched):
  - [ ] stop polling loop
  - [ ] if `reason` in {new, resume, fork, quit}: call
        `pi_unregister_session` (release lease + untrack) **before** close
  - [ ] if `reason === "reload"`: skip unregister (same UUID continues;
        `registerReplay` re-registers idempotently)
  - [ ] `client.close()`
  - [ ] clear transient status/widgets
- [ ] Inbound polling loop:
  - [ ] serialize drain calls (no overlapping polls)
  - [ ] on zero messages: no-op
  - [ ] on messages: format block, inject via `pi.sendUserMessage(...)`
  - [ ] idle: send immediately
  - [ ] streaming: use `{ deliverAs: "followUp" }` for MVP
- [ ] Only one loop per active extension runtime

## Phase 5 — Pi tools

### 5.1 `comm_send_message`

- [ ] typebox schema matching existing MCP semantics
- [ ] `comm` required, `message` required, `target` optional
- [ ] `target.account` must be concrete bot id (validate / surface error
      clearly if a label is supplied)
- [ ] Calls `sendCommMessage`
- [ ] Returns concise success text with `message_id`
- [ ] `promptSnippet` + `promptGuidelines` set

### 5.2 `comm_send_attachment`

- [ ] typebox schema: `comm`, `path` required; `caption`, `target` optional
- [ ] Validate path exists before daemon request
- [ ] Calls `sendCommAttachment`
- [ ] Returns concise success text with `message_id`

### 5.3 `comm_check_messages`

- [ ] typebox schema: optional `comm` filter
- [ ] Calls `drainPiInbound` (keep scoping consistent with session reg)
- [ ] Returns formatted message list or "no pending" text

### 5.4 `list_conversations`

- [ ] typebox schema: optional `comm`, `limit`
- [ ] Calls `listConversations`
- [ ] Returns bot-id-oriented display (surface `bot_user_id` explicitly)

## Phase 6 — Pi skills

### 6.1 Per-comm skills

- [ ] `skills/telegram/SKILL.md`
- [ ] `skills/discord/SKILL.md`
- [ ] `skills/matrix/SKILL.md`
- [ ] `skills/curl/SKILL.md`

### 6.2 Skill content checklist (each comm)

- [ ] Explain the `[Daemon Inbound Messages]` block contract
- [ ] Instruct: user-visible remote replies go via `comm_send_message`
- [ ] Instruct: omit `target` to reply to most-recent inbound
- [ ] Instruct: use `list_conversations` only when targeting elsewhere
- [ ] Instruct: use `comm_check_messages` when suspecting new inbound
- [ ] Note: local terminal output ≠ replying to remote comm user
- [ ] Note: `account=<bot_id>` is the routing key; labels like `"main"` are
      rejected as send targets

## Phase 7 — diagnostic commands (optional but recommended)

- [ ] `/comm-status` — show daemon connection + polling state
- [ ] `/comm-poll-now` — force one drain cycle
- [ ] `/comm-list` — `list_conversations` output in TUI
- [ ] `/comm-pause` / `/comm-resume` — pause/resume inbound polling

## Phase 8 — smoke tests

### 8.1 Telegram E2E (first vertical)

- [ ] Register a Telegram bot: `agents-comm account-add --project <path>
      --agent pi --account-label main --comm telegram --bot-token <token>`
- [ ] Allowlist sender: `agents-comm allowlist add --comm telegram
      --user <sender_id> --bot-id <bot_id>`
- [ ] Load Pi package: `pi -e ./path/to/pi-agents-comm` (or `pi install`)
- [ ] Start Pi in the project
- [ ] Send inbound message from Telegram
- [ ] Verify Pi receives a user turn containing the daemon inbound block
- [ ] Have Pi reply via `comm_send_message`
- [ ] Verify correct Telegram bot + chat receive the reply
- [ ] Verify busy Pi receives inbound as follow-up (not lost, not duplicated)

### 8.2 Multi-agent coexistence

- [ ] Register a second agent (claude or codex) for the same Telegram chat
      with `account_label = "main"`
- [ ] Send inbound from Telegram
- [ ] Verify Pi drain does not cannibalize the sibling agent's inbound
- [ ] Verify both agents receive their own scoped inbound

### 8.3 Daemon lifecycle

- [ ] Kill daemon (remove `port` + `daemon.pid`), restart Pi
- [ ] Verify daemon respawns and Pi re-registers cleanly
- [ ] Verify no duplicate polling loops after reload

### 8.4 Dev mode (this repo)

- [ ] In the agents-comm-bus repo, `pi -e ./plugins/pi/agents-comm` loads the
      source extension against the dev daemon (`.agents-comm-bus-dev.json`)
- [ ] Edit `core-daemon/bridges/pi/bridge.ts` → `npm --workspace
      agents-comm-bus run build` → restart dev daemon → `/reload` Pi → change
      visible (no Pi restart needed for extension source; jiti transpiles)
- [ ] Confirm dev daemon + prod daemon coexist (separate state roots, no
      409 on the same bot — only one holds the lease at a time)
- [ ] Confirm a consumer-repo simulation (unset env, remove dev marker) →
      `entryEnsures` falls through to strict prod / central install path

## Phase 9 — phase 2 (remote approvals / queries) — deferred

Tracked here for planning continuity; do not implement in the MVP cut.

- [ ] Design `pi_open_query` IPC method
- [ ] Design `pi_poll_queries` or `pi_wait_query` (decide poll vs event-like)
- [ ] Wire `tool_call` interception in the extension for risky tools
- [ ] Map Pi permission decisions to comm inline-keyboard buttons
- [ ] Map Pi question/choice flows to numbered-option buttons
- [ ] Add `pi_ack_query_delivery` if delivery semantics require it
- [ ] Add query lifecycle tests parallel to Claude/Codex query suites

---

## Definition of done (MVP)

All of the following must be ticked:

- [x] Phase 1 (daemon bridge) complete and merged  (merged to main @ 2cc45f0, 2026-06-17)
- [x] Phase 2 (bridge tests) green  (26 tests, 674 total pass)
- [ ] Phase 3 (package skeleton) exists
- [ ] Phase 4 (extension core) implemented
- [ ] Phase 5 (four comm tools) implemented
- [ ] Phase 6.1 + 6.2 for at least Telegram
- [ ] Phase 8.1 (Telegram E2E) passes manually
- [ ] Phase 8.4 (dev mode iteration loop) passes manually
- [ ] `npm run verify:clean-build` passes
- [ ] `npm test` passes
- [ ] README in the Pi package documents install + setup
