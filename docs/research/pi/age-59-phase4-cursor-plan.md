# AGE-59 Phase 4 — Pi extension core implementation plan

**Issue:** AGE-59 (The Pi Host)
**Branch:** `satriodewantono/age-59-pi-extension-core`
**Worktree:** `D:\tmp\acb-age59-p4`
**Base:** `main` (currently at `76ff7cf`)
**Scope:** Phase 4 ONLY — implement the bodies of the Pi extension stub modules created in Phase 3. The daemon bridge (`core-daemon/bridges/pi/`) is already done (Phase 1, merged). This phase turns the `TODO(phase4)` stubs into working code. Do NOT build tool schemas beyond what `tools.ts` needs (Phase 5 polishes), skill content (Phase 6), or run smoke tests (Phase 8).

## READ THESE FIRST (in order)

1. **`docs/research/pi/CHECKLIST.md`** — the authoritative checklist. Read the whole **Phase 4** section (§4.1, §4.1b, §4.2, §4.3, §4.4) and tick boxes as you satisfy them. Also re-read §4.1b (Dev mode) carefully — it has load-bearing requirements.
2. **`docs/research/pi/README.md`** — the design. Especially:
   - § "Pi extension runtime behavior" (session lifecycle, inbound delivery strategy, tool semantics)
   - § "IPC client lifecycle" (why `PersistentIpcClient` + `registerReplay`, with a wiring sketch)
   - § "Dev mode" (the `entryEnsures` / `fromDir` seam — now RESOLVED, see below)
   - § "Bridge correctness requirements" (the 7 MUST-fixes — daemon-side, already done; Phase 4 honors them extension-side, esp. the stable `connection_id`)
   - § "Session replacement & lease release" (the reason-branched `session_shutdown` handler)
3. **`docs/research/pi/age-59-phase1-cursor-plan.md`** — for the daemon-side `pi_*` IPC method shapes the extension calls (request/response fields).
4. **The Phase 3 stubs** at `plugins/pi/agents-comm/extensions/agents-comm/*.ts` — these are your starting point. Each has a doc comment naming its responsibility and typed param interfaces (in `daemon-client.ts`). Preserve those interfaces.

## IMPORTANT: the `entryEnsures` seam is RESOLVED (ignore stale Phase 3 comments)

Phase 3's `daemon-client.ts` top comment and the package README say `entryEnsures` is "not published from `agents-comm-bus`" and offer two options (vendor / publish). **That is now stale.** AGE-60 + AGE-61 (merged to `main` as `76ff7cf`) moved the `entryEnsures` cluster into `agents-comm-bus` under `core-daemon/host-runtime/`, exposed via a public export:

```ts
import { entryEnsures } from "agents-comm-bus/host-entry";
```

Verified: `host-entry` exports `[ 'entryEnsures', 'resolveEntryContext' ]`. `DAEMON_VERSION` is now `0.2.30`.

**Your tasks that follow from this:**
- Rewrite the `daemon-client.ts` top comment to drop the "seam / prerequisite decision" framing — say instead that it imports `entryEnsures` from `agents-comm-bus/host-entry` (the AGE-61 public export) and `PersistentIpcClient` from `agents-comm-bus/ipc/persistent-client` (the Phase 3 export).
- Bump the Pi package's `agents-comm-bus` dependency pin in `plugins/pi/agents-comm/package.json` from `0.2.29` → `0.2.30` (it's stale; `host-entry` doesn't exist in 0.2.29).
- Update the package README's "Dev mode" / "entryEnsures seam" section to reflect that the seam is resolved (import from `agents-comm-bus/host-entry`).

## Multi-comm install: Pi-side loop (Option B)

The current `entryEnsures({ agent, comm })` signature takes a **singular `comm`**. The Pi package is one-combined-for-all-comms (Phase 0 decision), so to install multiple comms the extension calls `entryEnsures` **once per comm** in a loop. (The shared-contract multi-comm signature change is a separate future issue; do NOT attempt it here.)

**MVP comm set: hardcode `["telegram"]`.** Phase 8.1 smoke is Telegram-only. Generalizing to discover comms from registered accounts is later work. Keep the list in one place (e.g. a `const SUPPORTED_COMMS = ["telegram"] as const` in `daemon-client.ts` or a config) so it's easy to extend.

Loop semantics:
- For each `comm` in the set: `await entryEnsures({ agent: "pi", comm, fromDir: import.meta.dirname, readOnlyCentralInstall: true })`.
- Each call returns `{ port, hello, spawned, centralInstall, ... }`. The `port` should be the same across calls (same daemon); take it from the last (or first — they agree). `ensureDaemon` is idempotent so N probes are safe.
- `readOnlyCentralInstall: true` — reuse an already-installed central daemon+adapter without taking `install.lock` (matches the MCP-shim pattern; the extension is a session client, not the installer owner).
- If a call throws, log + continue (best-effort per comm; a bad credential for one comm must not fail the whole extension load). Surface the failure via `ctx.ui.notify` in TUI mode if practical.

## Reference files (read these)

- `core-daemon/host-runtime/entry-ensures.ts` — the `entryEnsures` signature + `EntryEnsuresOptions` (agent, comm, fromDir, readOnlyCentralInstall, etc.) and `EntryEnsuresResult` (port, hello, spawned, centralInstall, stateRoot, discoveryRoot, env).
- `core-daemon/ipc/persistent-client.ts` — `PersistentIpcClient` + `PersistentIpcClientOptions` (clientVersion, metadata, ensureDaemonOptions, onConnected/onReconnected/onDisconnected/onError/log) + `registerReplay(method, params)` + `request(method, params)` + `close()` + `DisconnectedError`.
- `hosts/common/mcp-shim-shared.js` — the existing pattern for `ensureMcpRuntime` + `createDaemonRequester` + `PersistentIpcClient` wiring. Mirror its shape but adapt for the Pi extension's persistent (not per-request) client.
- `hosts/claude/hooks/user-prompt-submit.js` — the `formatInboundMessages` function to port for `inbound-format.ts` (envelope fields, attachment lines).
- `core-daemon/bridges/pi/bridge.ts` — the daemon-side handler shapes (what `pi_register_session` / `pi_drain_inbound` / `pi_unregister_session` expect and return). Your extension calls these; match the param shapes exactly.
- `C:/Users/Satrio/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — Pi extension API (`ExtensionAPI`, `pi.on`, `pi.registerTool`, `pi.sendUserMessage`, `ctx.ui`, `ctx.sessionManager`, `ctx.cwd`). The "Events" → "Session Events" section documents `session_start` (`event.reason`: startup|reload|new|resume|fork) and `session_shutdown` (`event.reason`: quit|reload|new|resume|fork).

## Deliverables

### 4.1 + 4.1b — `daemon-client.ts` (implement the stub)

Replace the `TODO(phase4)` bodies. Owns a `PersistentIpcClient` for the session lifetime.

**`start()` flow:**
1. Loop `entryEnsures({ agent: "pi", comm, fromDir: import.meta.dirname, readOnlyCentralInstall: true })` over `SUPPORTED_COMMS` (MVP: `["telegram"]`). Capture `port` + `stateRoot`/`discoveryRoot`/`env` from the result. Best-effort per comm (log + continue on failure).
2. Construct `PersistentIpcClient` with:
   - `clientVersion: "pi-extension-1"` (or similar; matches the `CLIENT_VERSION` pattern in Claude/Codex hooks)
   - `metadata: { agent: "pi", project, shimName: "pi-agents-comm" }` (project from `process.cwd()` — the extension's cwd is the Pi project)
   - `ensureDaemonOptions: { stateRoot, discoveryRoot, env }` (from the `entryEnsures` result, so reconnects respawn the right daemon)
   - `onError: (e) => log(...)`, `onDisconnected: (r) => log(...)`, optional `onReconnected` for diagnostics
3. `await client.start()`.

**`registerPiSession(params)` flow:**
- `await client.registerReplay("pi_register_session", params)` — both issues the request now AND queues it for replay on every reconnect (transparent re-registration after daemon restart). `params` = `{ agent: "pi", session, project, cwd, connection_id, host: { pid, label, mode, session_file } }`. **The `connection_id` MUST be a stable per-runtime id** generated by the extension (see `index.ts` below), NOT a random-per-call id — this is MUST-fix #1, load-bearing for replay after daemon crash.

**Other methods** (`unregisterPiSession`, `drainPiInbound`, `sendCommMessage`, `sendCommAttachment`, `listConversations`):
- Each is `await client.request(method, params)`.
- Map to the daemon IPC methods: `pi_unregister_session`, `pi_drain_inbound`, `${comm}_send`, `${comm}_send_image`, `list_conversations`.
- Surface `DisconnectedError` concisely: catch it, return a short error string (don't crash the extension; the client auto-reconnects in the background). Mirror how `mcp-shim-shared.js`'s `createDaemonRequester` wraps errors.

**`close()`:** `client.close()`.

### 4.2 — `session-id.ts` (already implemented in Phase 3, just verify)

`piSessionId(sm) = pi_${sm.getSessionId()}`. Confirm it's correct; no change needed unless Phase 3 left a TODO. Add a comment reinforcing the usage rule: read fresh inside each `session_start` (do not cache across reload).

### 4.3 — `inbound-format.ts` (implement the stub)

Port `formatInboundMessages` from `hosts/claude/hooks/user-prompt-submit.js`. Produce the `[Daemon Inbound Messages] ... [End Daemon Inbound Messages]` block. Envelope fields per entry: `comm`, `account`, `account_label`, `chat_native_id`, `thread_native_id`, `conversation_id`, `platform_message_id`, `message_id`. Attachment lines: mime, filename, size, `local_path` / `blob_hash`. **No Pi-specific envelope fields** — keep parity with Claude/Codex so skills/prompt contracts stay uniform. Type the input as the daemon's `PendingInboundEntry` shape (loosely type or import if `agents-comm-bus` exposes it; otherwise a local interface matching the daemon's drain response).

### 4.4 — `index.ts` (implement the session handlers)

The entrypoint. Replace the `TODO(phase4)` session-handler comments with real `pi.on(...)` handlers.

**On load (top-level in the default export):**
- `registerCommTools(pi)` (Phase 5 polishes schemas; for Phase 4 the tools can be minimally functional — see §5 below. If Phase 5 is a separate delegation, leave `tools.ts` as a stub that throws `TODO(phase5)` and have `index.ts` guard the call so load doesn't throw. **Decision: keep `tools.ts` as a Phase 5 stub for now; do NOT implement tool bodies in Phase 4.** `index.ts` should call `registerCommTools` inside a try/catch that logs + continues, OR defer registration to Phase 5. Simplest: leave the `registerCommTools(pi)` call but have `tools.ts` throw `TODO(phase5)` — `index.ts` load will throw when Pi invokes the entrypoint. **To keep the extension loadable for Phase 4 smoke (inbound poller test), wrap the `registerCommTools`/`registerCommCommands` calls in try/catch with a console.warn, so a Phase 5 stub doesn't break load.** Document this in a comment.)
- `registerCommCommands(pi)` — same treatment (Phase 7/optional; stub throws `TODO`).

**Module-scoped state (one per active extension runtime):**
- `client: PiDaemonClient | null`
- `pollTimer: NodeJS.Timeout | null`
- `connectionId: string | null` — **stable per runtime**, generated once at load: `pi-conn-${crypto.randomUUID()}` (or similar; stable for the lifetime of this extension instance). Sent in BOTH `pi_register_session` and `pi_unregister_session`.
- `piSession: string | null` — the `pi_<uuid>` from `piSessionId(ctx.sessionManager)`, read fresh in `session_start`.

**`pi.on("session_start", async (event, ctx) => { ... })`:**
1. `piSession = piSessionId(ctx.sessionManager)` (fresh each time; do not reuse a cached value across reload).
2. `connectionId` is already set at module load; reuse it.
3. `client = new PiDaemonClient(...)`; `await client.start()`.
4. `await client.registerPiSession({ agent: "pi", session: piSession, project: ctx.cwd, cwd: ctx.cwd, connection_id: connectionId, host: { pid: process.pid, label: "pi", mode: ctx.mode, session_file: ctx.sessionManager.getSessionFile() ?? null } })`.
5. Start the inbound polling loop (see below).
6. Optional `ctx.ui.notify("agents-comm-bus connected", "info")` in TUI mode (`ctx.mode === "tui"`).

**`pi.on("session_shutdown", async (event, ctx) => { ... })` (reason-branched):**
1. Stop the polling loop (`clearTimeout(pollTimer); pollTimer = null`).
2. `const reason = event.reason` (`"quit" | "reload" | "new" | "resume" | "fork"`).
3. **If `reason` is `"new" | "resume" | "fork" | "quit"`**: call `await client?.unregisterPiSession({ agent: "pi", session: piSession, connection_id: connectionId })` BEFORE `client.close()` — while the socket is still open so the daemon can match the `connectionId` and release the lease. Wrap in try/catch (best-effort; don't fail shutdown on a daemon error).
4. **If `reason === "reload"`**: skip unregister (same UUID continues; `registerReplay` re-registers idempotently on the next `session_start`).
5. `await client?.close(); client = null`.

**Inbound polling loop:**
- `async function pollOnce()`: `const { messages } = await client.drainPiInbound({ agent: "pi", session: piSession, project: ctx.cwd, limit: 100 })`. If `messages.length > 0`: format via `formatInboundMessages(messages)`; inject with `pi.sendUserMessage(formattedBlock)`. **Delivery mode:** if Pi is idle → send immediately (default); if streaming → `pi.sendUserMessage(formattedBlock, { deliverAs: "followUp" })` for MVP safety. (Use `ctx.isIdle()` / `ctx.hasPendingMessages()` to decide; see Pi docs. If the API isn't clear, default to `followUp` when not idle, immediate when idle.)
- `pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS)` (e.g. 2000ms) at the end of each `pollOnce`, self-scheduling. `unref()` the timer so it doesn't keep the process alive.
- Serialize: guard with an `isPolling` flag so overlapping polls can't happen.
- On `DisconnectedError` during a poll: log, skip this tick, schedule the next (the client is reconnecting in the background).

### 4.5 — `tools.ts` + `commands.ts` (leave as Phase 5/7 stubs)

**Do NOT implement tool bodies or command bodies in Phase 4.** Leave them throwing `TODO(phase5)` / `TODO(phase7)`. The `index.ts` try/catch guard (see 4.4) keeps the extension loadable for Phase 4's inbound-poller smoke. Phase 5 implements the four comm tools; Phase 7 (optional) implements commands.

### 4.6 — `package.json` + README updates

- Bump `agents-comm-bus` dep: `0.2.29` → `0.2.30`.
- Update README "Dev mode" / "entryEnsures seam" section: the seam is resolved (AGE-61); import from `agents-comm-bus/host-entry`.
- No other package.json changes.

## Out of scope (do NOT do these — later phases)

- Implementing `tools.ts` bodies (comm_send_message, etc.) — Phase 5.
- Tool schemas beyond what's needed to not break load — Phase 5.
- `commands.ts` bodies — Phase 7 (optional).
- Skill content (Phase 6).
- Smoke tests / live Telegram E2E (Phase 8).
- Any change to `core-daemon/` (daemon side is done).
- Any change to the `entryEnsures` signature / multi-comm shared-contract work (separate future issue).
- Discovering comms from registered accounts (MVP hardcodes `["telegram"]`).

## Verify (after implementation)

From the worktree root (`D:/tmp/acb-age59-p4`):

```powershell
# Workspace prep (fresh worktree — install all workspace deps or the subprocess tests flake, AGE-48)
cd packages/core-contracts && npm install && npm run build && cd ../..
cd agents-comm-bus && npm install && npm run build && cd ..
cd hosts && npm install && cd ..   # IMPORTANT: hosts workspace deps, or 3 subprocess suites fail

# 1. The Pi package's TypeScript at least typechecks / parses.
#    (There's no tsc project for plugins/pi/ — jiti transpiles on load. At minimum
#     eyeball each .ts for syntax; ideally load each module via tsx:)
npx tsx -e "import('./plugins/pi/agents-comm/extensions/agents-comm/session-id.ts').then(m=>console.log('session-id ok:',Object.keys(m))).catch(e=>{console.error(e.message);process.exit(1)})"
npx tsx -e "import('./plugins/pi/agents-comm/extensions/agents-comm/inbound-format.ts').then(m=>console.log('inbound-format ok:',Object.keys(m))).catch(e=>{console.error(e.message);process.exit(1)})"
npx tsx -e "import('./plugins/pi/agents-comm/extensions/agents-comm/daemon-client.ts').then(m=>console.log('daemon-client ok:',Object.keys(m))).catch(e=>{console.error(e.message);process.exit(1)})"
# index.ts will try to register handlers on import via the default export; loading it standalone
# without a Pi runtime will likely throw on the first pi.on — that's expected. Verify it PARSES
# via tsc --noEmit against a loose config, or just node --check after stripping types with tsx.

# 2. Daemon package still builds + full test suite green (no regressions)
npm test 2>&1 | tail -8
npm run verify:clean-build 2>&1 | tail -5

# 3. Version-bump gate (Pi package.json dep pin change is not a daemon artifact change,
#    so no DAEMON_VERSION bump expected. Confirm.)
npm run check:version-bump 2>&1 | tail -3
```

If `npx tsx` isn't available, `npm install tsx --no-save` in the worktree root, or skip the import smoke and rely on a careful eyeball + a Phase 8 live load.

The key success criterion for Phase 4: **the module files parse cleanly and the daemon package's tests/verify-gates stay green.** A live `pi -e ./plugins/pi/agents-comm` load test happens in Phase 8.

## Commit discipline

- Commit messages prefixed `AGE-59 ...`.
- One commit for the extension core + package.json/README updates, or split logically (daemon-client / inbound-format / index-handlers / package-bump) — your call.
- No `DAEMON_VERSION` bump expected (no daemon code changed). If `check:version-bump` complains, investigate before bumping — it shouldn't, since the Pi package dep pin is a consumer-package change, not a daemon artifact change.

## Definition of done (Phase 4)

- [ ] `daemon-client.ts` implements `start()` (entryEnsures loop over `["telegram"]` + PersistentIpcClient construct + start), `registerPiSession` (via `registerReplay`), the request-wrapper methods, `close()`.
- [ ] `daemon-client.ts` top comment rewritten: imports from `agents-comm-bus/host-entry` + `agents-comm-bus/ipc/persistent-client`; no more "seam/prerequisite decision" framing.
- [ ] `inbound-format.ts` ports the `[Daemon Inbound Messages]` block format from Claude's hook.
- [ ] `index.ts` implements `session_start` (compute piSession, client.start, registerPiSession with stable connection_id, start poller) and `session_shutdown` (reason-branched: unregister on new/resume/fork/quit before close; skip on reload; close).
- [ ] Stable per-runtime `connection_id` generated once at module load, sent in both register + unregister.
- [ ] Inbound poller: serialized, self-scheduling, `DisconnectedError`-tolerant, idle→immediate / streaming→followUp.
- [ ] `tools.ts` + `commands.ts` remain Phase 5/7 stubs; `index.ts` guards their registration so load doesn't throw.
- [ ] `plugins/pi/agents-comm/package.json`: `agents-comm-bus` dep bumped `0.2.29` → `0.2.30`.
- [ ] Package README updated: `entryEnsures` seam resolved (AGE-61).
- [ ] All `*.ts` modules parse/load cleanly (no syntax errors, no top-level throws except the guarded tool/command registrar calls).
- [ ] `npm test` green (674 pass baseline); `verify:clean-build` passes; `check:version-bump` passes.
- [ ] Tick the §4.1, §4.1b, §4.2, §4.3, §4.4 boxes in `docs/research/pi/CHECKLIST.md` (leave §4.1b items that need a live Pi load — e.g. "dev daemon runs from source" — unchecked if you can't verify them headlessly; note in the report).

## After Phase 4

Report back with: the implemented files, confirmation that modules parse + gates green, the stable `connection_id` generation approach, and any decisions you had to make (e.g. delivery-mode API shape). Phase 5 (implementing the four comm tools) will be a separate delegation.
