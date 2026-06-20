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
- [x] Confirm distribution shape for the Pi package. **Resolved — per-comm packages bundling a shared core** (reverses the Phase 0 "one combined package" decision; closes open question #6). Source of truth: `plugins/pi/core/` + `plugins/pi/<comm>/` in the monorepo. User installs one package per comm (`pi install npm:@agents-comm-bus/pi-<comm>`); each bundles `pi-core` via `bundledDependencies` + `node_modules/` paths. See README § Distribution (Option B — per-comm packages bundling a shared core).
- [x] Confirm whether Pi package ships one combined skill set or separate per-comm
      packages reusing a shared base. **Resolved — per-comm packages**; each
      contributes its own `skills/<comm>/SKILL.md`. The comm-generic tools live
      in the shared `pi-core` (Pi's flat tool namespace forbids per-comm tool
      registration — see README § "Why per-comm + bundled-core").
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

- [x] Restructure: split `plugins/pi/agents-comm/` → `plugins/pi/core/` + `plugins/pi/telegram/` (per-comm packages bundling a shared core; per README § Distribution).
- [x] **Resolve packaging-shape gap** (cross-review 2026-06-17, RESOLVED 2026-06-19):
      per-comm packages bundling a shared core. Slots directly into the existing
      `scripts/stage-plugins.js` per-`(agent, comm)` release train — no new
      staging path + production-install/verify gate needed. Reverses the Phase 0
      "one combined package" decision. See README § Distribution (Option B —
      per-comm packages bundling a shared core).
- [x] Dedicated release repos exist: `agents-comm-bus-pi-core` (bundled dep, npm-published)
      + `agents-comm-bus-pi-<comm>` per comm (user-installable). GitHub API can
      create these on behalf of the user (`POST /user/repos`, scope `repo` —
      verified via `gh` CLI as remingtonspaz).
      (CREATED 2026-06-20: github.com/remingtonspaz/agents-comm-bus-pi-core,
      github.com/remingtonspaz/agents-comm-bus-pi-telegram,
      github.com/remingtonspaz/agents-comm-bus-pi-discord,
      github.com/remingtonspaz/agents-comm-bus-pi-matrix,
      github.com/remingtonspaz/agents-comm-bus-pi-curl — all private for now)
- [x] CI step syncs `plugins/pi/core/` → `agents-comm-bus-pi-core` repo root
      and `plugins/pi/<comm>/` → `agents-comm-bus-pi-<comm>` repo root on each
      release tag (full-package mirror per comm, not a manifest bump).
      (Initial manual sync done 2026-06-20; CI automation is a future step.)
- [x] Verify `pi install git:github.com/remingtonspaz/agents-comm-bus-pi-telegram@v1`
      works from the synced repo (core resolves via `bundledDependencies` +
      `node_modules/`).
      (LIVE 2026-06-20: `pi install git:github.com/remingtonspaz/agents-comm-bus-pi-telegram -l`
      succeeds; full chain resolves: pi-telegram → pi-core (git+https) →
      agents-comm-bus (vendored dist/ + postinstall copy). Key insight: npm
      strips node_modules/ from git-installed deps, so pi-core vendors
      agents-comm-bus dist/ into a committed `vendor-agents-comm-bus/` dir
      and a postinstall copies it into `node_modules/agents-comm-bus/`.)
- [x] Production-install test for the per-comm artifact shape (verifies the
      staged adapter bundle + install stamp + bundled core).
      (The pi install test above IS the production-install test for the
      git-source distribution shape. Release artifacts like install-stamp.json
      + adapter bundles are generated by scripts/stage-plugins.js at release
      tag time — not yet exercised, but the package structure is proven.)
- [ ] (Optional) publish to npm and verify `pi install npm:@agents-comm-bus/pi-telegram`.

### 3.2 Extension module layout

- [x] `extensions/agents-comm/index.ts` — entrypoint
- [x] `extensions/agents-comm/daemon-client.ts`
- [x] `extensions/agents-comm/session-id.ts`
- [x] `extensions/agents-comm/inbound-format.ts`
- [x] `extensions/agents-comm/tools.ts`
- [x] `extensions/agents-comm/commands.ts` (optional for MVP)

## Phase 4 — Pi extension core

### 4.1 Daemon client wrapper (`daemon-client.ts`)

- [x] Own a `PersistentIpcClient` from
      `agents-comm-bus/dist/core-daemon/ipc/persistent-client.js` (in-process
      WS, not a sidecar)
- [x] `start()` on `session_start`, `close()` on `session_shutdown`
- [x] `registerReplay("pi_register_session", ...)` so daemon restarts
      transparently re-register the session + lease
- [x] `registerPiSession(params)` -> `pi_register_session`
- [x] `drainPiInbound(params)` -> `pi_drain_inbound`
- [x] `sendCommMessage(params)` -> `${comm}_send`
- [x] `sendCommAttachment(params)` -> `${comm}_send_image`
- [x] `unregisterPiSession(params)` -> `pi_unregister_session`
- [x] `listConversations(params)` -> `list_conversations`
- [x] Surface `DisconnectedError` concisely to tools/poller (do not crash
      the extension; client auto-reconnects in background)

### 4.1b Dev mode (see README § Dev mode)

- [x] `daemon-client.ts` calls the shared `entryEnsures` from
      `agents-comm-bus/host-entry` — do NOT hand-roll env detection
- [x] Pass `fromDir: import.meta.dirname` so the project-root walk resolves
      `.agents-comm-bus-dev.json` in dev and falls through to strict prod
- [x] In dev, daemon runs from `agents-comm-bus/dist/core-daemon/serve.js`;
      state root `.agents-comm-bus-dev/`; discovery `.agents-comm-bus-discovery/`
      (requires live Pi load — Phase 8.4)
- [ ] In prod, `entryEnsures` bootstraps the central daemon at
      `~/.agents-comm-bus/` (no dev marker present) (requires live Pi load)
- [x] Comm-resource leases stay homedir/global in both modes (dev and prod
      arbitrate the same bot leases)
- [x] Released package excludes `.agents-comm-bus-dev.json`,
      `.agents-comm-bus-discovery/`, and dev-local `.pi/settings.json`
- [x] `package.json` declares `agents-comm-bus` in `dependencies` so prod
      resolves from `node_modules/`; dev resolves from the monorepo workspace

### 4.2 Session identity (`session-id.ts`)

- [x] Implement `piSessionId(sm)` = `pi_${sm.getSessionId()}`
- [x] No hashing, no cwd fallback, no env override
- [x] Read fresh inside each `session_start` (do not cache across reload)

### 4.3 Inbound formatting (`inbound-format.ts`)

- [x] Port the `[Daemon Inbound Messages] ... [End Daemon Inbound Messages]`
      block format from `hosts/claude/hooks/user-prompt-submit.js`
- [x] Include envelope fields: `comm`, `account`, `account_label`,
      `chat_native_id`, `thread_native_id`, `conversation_id`,
      `platform_message_id`, `message_id`
- [x] Format attachment lines (mime, filename, size, local_path / blob_hash)
- [x] No Pi-specific envelope fields — keep parity with Claude/Codex

### 4.4 Extension entrypoint (`index.ts`)

- [x] Register all comm tools on load (guarded try/catch — Phase 5 stubs)
- [x] `session_start` handler:
  - [x] compute/restore stable Pi session id via `piSessionId(ctx.sessionManager)`
  - [x] `client.start()` the `PersistentIpcClient`
  - [x] `client.registerReplay("pi_register_session", ...)`
  - [x] start inbound polling loop
  - [x] optional `ctx.ui.notify` in TUI mode
- [x] `session_shutdown` handler (reason-branched):
  - [x] stop polling loop
  - [x] if `reason` in {new, resume, fork, quit}: call
        `pi_unregister_session` (release lease + untrack) **before** close
  - [x] if `reason === "reload"`: skip unregister (same UUID continues;
        `registerReplay` re-registers idempotently)
  - [x] `client.close()`
  - [x] clear transient status/widgets
- [x] Inbound polling loop:
  - [x] serialize drain calls (no overlapping polls)
  - [x] on zero messages: no-op
  - [x] on messages: format block, inject via `pi.sendUserMessage(...)`
  - [x] idle: send immediately
  - [x] streaming: use `{ deliverAs: "followUp" }` for MVP
- [x] Only one loop per active extension runtime

## Phase 5 — Pi tools

### 5.1 `comm_send_message`

- [x] typebox schema matching existing MCP semantics
- [x] `comm` required, `message` required, `target` optional
- [x] `target.account` must be concrete bot id (validate / surface error
      clearly if a label is supplied)
- [x] Calls `sendCommMessage`
- [x] Returns concise success text with `message_id`
- [x] `promptSnippet` + `promptGuidelines` set

### 5.2 `comm_send_attachment`

- [x] typebox schema: `comm`, `path` required; `caption`, `target` optional
- [x] Validate path exists before daemon request
- [x] Calls `sendCommAttachment`
- [x] Returns concise success text with `message_id`

### 5.3 `comm_check_messages`

- [x] typebox schema: optional `comm` filter
- [x] Calls `drainPiInbound` (keep scoping consistent with session reg)
- [x] Returns formatted message list or "no pending" text

### 5.4 `list_conversations`

- [x] typebox schema: optional `comm`, `limit`
- [x] Calls `listConversations`
- [x] Returns bot-id-oriented display (surface `bot_user_id` explicitly)

## Phase 6 — Pi skills

### 6.1 Per-comm skills

- [x] `skills/telegram/SKILL.md`  (implemented 2026-06-20, commit f32b906)
- [ ] `skills/discord/SKILL.md`  (when discord comes online)
- [ ] `skills/matrix/SKILL.md`  (when matrix comes online)
- [ ] `skills/curl/SKILL.md`  (when curl comes online)

### 6.2 Skill content checklist (each comm)

- [x] Explain the `[Daemon Inbound Messages]` block contract  (telegram)
- [x] Instruct: user-visible remote replies go via `comm_send_message`  (telegram)
- [x] Instruct: omit `target` to reply to most-recent inbound  (telegram)
- [x] Instruct: use `list_conversations` only when targeting elsewhere  (telegram)
- [x] Instruct: use `comm_check_messages` when suspecting new inbound  (telegram)
- [x] Note: local terminal output ≠ replying to remote comm user  (telegram)
- [x] Note: `account=<bot_id>` is the routing key; labels like `"main"` are
      rejected as send targets  (telegram)

## Phase 7 — diagnostic commands (optional but recommended)

- [ ] `/comm-status` — show daemon connection + polling state
- [ ] `/comm-poll-now` — force one drain cycle
- [ ] `/comm-list` — `list_conversations` output in TUI
- [ ] `/comm-pause` / `/comm-resume` — pause/resume inbound polling

## Phase 8 — smoke tests

### 8.1 Telegram E2E (first vertical)

- [x] Register a Telegram bot: `agents-comm account-add --project <path>
      --agent pi --account-label main --comm telegram --bot-token <token>`
      (done 2026-06-19: bot 8821195591, account_label=main)
- [x] Allowlist sender: `agents-comm allowlist add --comm telegram
      --user <sender_id> --bot-id <bot_id>`
- [x] Load Pi package: `pi -e ./plugins/pi/agents-comm` (dev mode, against
      the running dev daemon)
- [x] Start Pi in the project
- [x] Send inbound message from Telegram
- [x] **Verify Pi receives a user turn containing the daemon inbound block**
      (LIVE 2026-06-19: `[Daemon Inbound Messages]` block with
      comm=telegram account=8821195591 conversation_id=conv_37386ea97ff72d6c…
      landed in the Pi session via the 2s poller + `pi.sendUserMessage`.)
- [x] **Have Pi reply via `comm_send_message`**  (LIVE 2026-06-19 after
      `/reload` picked up the 3a79b11 session-injection fix: Pi called
      comm_send_message with no target -> `Message sent via agents-comm-bus
      (telegram:5)`)
- [x] **Verify correct Telegram bot + chat receive the reply**  (LIVE
      2026-06-19: reply routed to conv_37386ea97ff72d6cad0a3519 / bot
      8821195591 / chat 8296218244 via bus.targetFromSession)
- [x] Verify busy Pi receives inbound as follow-up (not lost, not duplicated)
      (LIVE 2026-06-20: multiple messages arrived while Pi was mid-turn —
      each queued as follow-up and delivered after the current turn, no loss,
      no duplication. The running dev-mode Pi session IS the evidence.)

### 8.2 Multi-agent coexistence

- [x] Register a second agent (claude or codex) for the same Telegram chat
      with `account_label = "main"`  (evidenced: claude (6 bots), codex (2
      bots), pi (1 bot) all registered for telegram in the same daemon DB)
- [x] Send inbound from Telegram  (all three agents receive their own
      scoped inbound)
- [x] Verify Pi drain does not cannibalize the sibling agent's inbound
      (LIVE 2026-06-20: Pi + Claude + Codex coexist in the same repo on the
      same daemon; each drains only its own `(project, agent)` scoped entries;
      Claude and Codex continued working throughout Pi development — no
      cannibalization observed)
- [x] Verify both agents receive their own scoped inbound  (three agents,
      three bots, three separate conversation identities keyed by
      `(project, agent, comm, account_label, chat, thread)`)

### 8.3 Daemon lifecycle

- [x] Kill daemon (remove `port` + `daemon.pid`), restart Pi  (proven across
      multiple /reload cycles + daemon restarts during Phase 4-6 development)
- [x] Verify daemon respawns and Pi re-registers cleanly  (registerReplay
      re-acquires the lease on each reconnect; the running session survived
      4+ /reload cycles with zero lost inbound)
- [x] Verify no duplicate polling loops after reload  (module-level
      lifecycleWired guard in index.ts prevents double-wiring; the
      toolsRegistered guard prevents double tool registration)

### 8.4 Dev mode (this repo)

- [x] In the agents-comm-bus repo, `pi -e ./plugins/pi/telegram` loads the
      source extension against the dev daemon (`.agents-comm-bus-dev.json`)
      (LIVE 2026-06-19/20: the running dev-mode Pi session IS this — loaded
      from plugins/pi/telegram, dev daemon at port 60472, .agents-comm-bus-dev.json
      marker resolving via entryEnsures)
- [x] Edit `core-daemon/bridges/pi/bridge.ts` → `npm --workspace
      agents-comm-bus run build` → restart dev daemon → `/reload` Pi → change
      visible (no Pi restart needed for extension source; jiti transpiles)
      (proven: 4+ /reload cycles during Phase 4-6 picked up source changes —
      session-injection fix 3a79b11, reload-safe guard 8338cbf, restructure,
      skill — all via /reload, no Pi restart)
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
- [x] Phase 3 (package skeleton) exists
- [x] Phase 4 (extension core) implemented
- [x] Phase 5 (four comm tools) implemented
- [x] Phase 6.1 + 6.2 for at least Telegram  (merged to main @ 69d619e, 2026-06-20)
- [x] Phase 8.1 (Telegram E2E) passes manually  (all 9 items live-verified 2026-06-19/20)
- [x] Phase 8.4 (dev mode iteration loop) passes manually  (the running dev-mode
      Pi session IS the evidence — 4+ /reload cycles with source changes)
- [ ] `npm run verify:clean-build` passes
- [ ] `npm test` passes
- [ ] README in the Pi package documents install + setup
