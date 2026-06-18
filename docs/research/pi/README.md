# Pi host integration plan

Date: 2026-06-11
Status: implementation plan for adding a first-class `pi` host to the universal `agents-comm-bus` architecture.

## Bottom line

Implement Pi as a **new agent bridge plus a Pi package extension**:

- daemon side: add `core-daemon/bridges/pi/`
- host side: ship a Pi package containing a runtime extension and comm-specific skills
- keep comm adapters unchanged; Pi consumes the same generic bus + adapter surfaces as Claude and Codex
- do **not** copy Claude/Codex watcher/bootstrap machinery; Pi can wake itself by injecting messages through the extension API

This is intentionally closer to the existing `claude` / `codex` split than to an extension-only sidecar design. Because this repo already has host-specific bridge directories under `core-daemon/bridges/`, a `pi` bridge is architecturally consistent and keeps session/routing/query state daemon-owned instead of reimplementing it in the Pi package.

## Goals

### MVP goals

1. Pi session registers with the daemon under `agent = "pi"`.
2. Pi package exposes the same user-facing comm tools already available through the Claude/Codex MCP shim:
   - `comm_send_message`
   - `comm_send_attachment`
   - `comm_check_messages`
   - `list_conversations`
3. Inbound comm messages become Pi user turns via the Pi extension.
4. Reply routing uses daemon-owned session/conversation state, not extension-local heuristics.
5. Packaging/install shape is natural for Pi users: `pi install ...` brings in the extension + skills.

### Phase 2 goals

1. Remote permission approval/denial via comm queries.
2. Remote question/choice flows analogous to Claude/Codex query handling.
3. Richer Pi-side diagnostics and local admin commands.
4. Optional callback/button support if a comm supports it and the UX is worth carrying into Pi.

## Non-goals for MVP

- No Claude-style wake watcher.
- No Codex app-server bootstrap/lifecycle management.
- No new comm adapter architecture.
- No changes to core routing invariants for existing agents.
- No attempt to make Pi look like Claude hooks or Codex hooks; use Pi extension primitives directly.

## Why a bridge instead of extension-only

The extension-only shape is possible, but weaker:

- it would need to own local "most recent inbound" routing state
- session registration semantics would be approximate
- remote permission/query parity would become awkward
- daemon-owned per-session state would get duplicated outside the daemon

A `pi` bridge avoids that. The daemon remains the authority for:

- session registration
- scoping `(project, agent)`
- most-recent inbound conversation tracking
- draining inbound for one Pi session without cannibalizing another agent
- future query lifecycle

## Proposed architecture

```text
Pi TUI / SDK host
  └─ Pi package extension
      ├─ session_start -> pi_register_session
      ├─ tool registrations -> daemon IPC requests
      ├─ inbound poll/drain -> pi_drain_inbound
      └─ pi.sendUserMessage(...) to wake Pi naturally

agents-comm-bus daemon
  ├─ core-daemon/bridges/pi/bridge.ts
  ├─ existing MessageBus
  ├─ existing storage / sessions / conversations / queries
  └─ existing comm adapters (telegram, discord, matrix, curl, ...)
```

## Design principles

1. **Pi-specific code belongs in `core-daemon/bridges/pi/` and the Pi package, not `daemon.ts`.**
2. **Reuse generic comm IPC and bus paths wherever possible.**
3. **Prefer daemon-owned session state over extension-owned routing guesses.**
4. **Use Pi's native extension APIs for wake/injection instead of external process tricks.**
5. **Keep MVP narrow: inbound/outbound/session registration first, queries later.**

---

## Daemon-side plan

## 1. Add a new Pi bridge directory

Create:

```text
core-daemon/bridges/pi/
  bridge.ts
```

Optional follow-on split if the file grows:

```text
core-daemon/bridges/pi/
  bridge.ts
  inbound.ts
  query.ts
  session.ts
```

For MVP, one `bridge.ts` is enough.

## 2. Register the bridge in the composition root

Update:

- `core-daemon/serve.ts`

Add:

- `PiBridgeFactory`
- include it in `agentBridgeFactories`

Target shape:

```ts
agentBridgeFactories: [
  new ClaudeBridgeFactory(),
  new CodexBridgeFactory(),
  new PiBridgeFactory(),
]
```

This keeps the existing composition-root pattern intact.

## 3. Pi bridge responsibilities

The Pi bridge should own:

- `agentId = "pi"`
- `ipcMethods` set for Pi-owned methods
- session registration
- Pi-scoped inbound draining
- future query resolution plumbing
- optional per-comm callback wiring only if/when Pi needs it

For MVP, Pi does **not** need an `onInboundConversation()` wake implementation analogous to Claude's watcher or Codex's steer path, because the Pi extension can poll/drain and inject messages itself.

That means the bridge can start simpler than Claude/Codex.

## 4. Proposed Pi IPC methods

### `pi_register_session`

Purpose:
- register/refresh a Pi session
- stamp session ownership
- ensure comm adapters are live for `(project, agent="pi")`
- establish daemon-owned routing state for later sends/drains

Proposed request shape:

```ts
{
  agent: "pi",
  session: string,
  project: string,
  cwd: string,
  connection_id: string,  // STABLE per Pi extension runtime (see Bridge correctness requirements)
  host?: {
    mode?: "tui" | "rpc" | "json" | "print",
    session_file?: string | null,
    pid?: number | null,
    label?: string | null,
  },
}
```

Proposed response shape:

```ts
{
  ok: true,
  session: string,
  project: string,
  agent: "pi",
}
```

Notes:
- **MUST send a stable per-runtime `connection_id`** (generated by the Pi extension, not the bridge). See [§ Bridge correctness requirements](#bridge-correctness-requirements) — this is load-bearing for `registerReplay` after a daemon crash.
- **Registration ordering MUST mirror Claude/Codex** (AGE-38/AGE-45): `upsertSession` → `acquireSessionLease` (with daemon-owner stamp) → wire bridge/session state + socket-close handler → `ensureCommsBestEffort(project)` **LAST**. The README's earlier "ensure first" ordering was wrong: ensuring comms before the lease/state/close-handler is wired lets inbound race ahead of a session that isn't ready to receive it. Claude's literal comment: "after wake registration + close handler so inbound cannot race ahead" (`claude/bridge.ts:396`). Pi has no wake watcher, but the same race applies (adapters start polling → inbound enqueues → drain sees a session with no lease/state).
- **MUST stamp daemon-owner identity** via `sessionLeaseOwnerWithDaemon(sessionLeaseOwnerFromParams(params), context.daemonOwner)` when calling `storage.acquireSessionLease(...)` — exactly as ClaudeBridge and CodexBridge do post-AGE-58. The `daemonOwner` comes from `AgentBridgeContext.daemonOwner` (populated by the daemon at `daemon.ts:272`); the `PiBridgeFactory.create(context)` must thread it into `PiBridgeOptions.daemonOwner` (mirror `codex/bridge.ts:984`). Skipping this leaves Pi sessions with null daemon-owner metadata, and `boot-scope-restore.ts` (`classifySessionDaemonOwner` -> `"missing"`) will fail-closed (`skipped_no_daemon_owner`) -> Pi comms will **not** restore on daemon restart. This is load-bearing, not cosmetic. (AGENTS.md's "Adding a new agent bridge" predates AGE-58 and does not mention it.)
- the `owner_process_pid`/`owner_process_label` from `params.host` still flow through `sessionLeaseOwnerFromParams` for PID-liveness fallback on genuine `quit`/crash; the daemon-owner stamp is the separate AGE-58 layer that makes boot-scope restore work.
- normalize `project` via the same project normalization logic other bridges use.
- **drain/unregister MUST bind to the stored session row, not trust caller-supplied `project`.** Use `storage.getSession(session)` as source of truth for the `(project, agent)` scope; reject/no-op if the caller's project doesn't match. This mirrors `ownedAccountKeys(session)` in `claude/bridge.ts:315` and prevents a misrouted call from affecting another scope.

### `pi_drain_inbound`

Purpose:
- return daemon-delivered inbound messages scoped to the Pi session's `(project, agent)`
- remove only the drained entries for that scope

Proposed request shape:

```ts
{
  agent: "pi",
  session: string,
  project: string,
  limit?: number,
  comm?: string,
}
```

Proposed response shape:

```ts
{
  messages: PendingInboundEntry[]
}
```

Notes:
- mirror the existing Claude/Codex drain behavior rather than inventing a Pi-only payload shape.
- preserve `(message_id, comm, account)`-aware removal discipline.
- **MUST stamp `most_recent_inbound` on the session row**: after a successful drain with ≥1 message, call `storage.setSessionMostRecentInbound(session, drained[drained.length - 1].conversation.conversation_id)` — exactly as Claude does (`claude/bridge.ts:404-408`). This is load-bearing because Pi's bridge has a no-op `onInboundConversation`, so drain is the **only** place the session's most-recent inbound gets set. Without it, every no-target `comm_send_message` — the documented default in the tools AND skills — throws via `bus.targetFromSession` (`bus.ts:632-635`, "no most-recent inbound conversation"). Acceptance test: drain one inbound, then a no-target `comm_send_message` resolves to that conversation.
- **reuse the shared `ownedAccountKeys` scoping helper** (project,agent-scoped, per `claude/bridge.ts:315`), do not reimplement `(project, agent)` scoping — keeps the sibling-cannibalization invariant identical to Claude/Codex.
- resolve scope from `storage.getSession(session)`, not the caller-supplied `project` (see register notes).

### `pi_unregister_session`

Purpose:
- explicitly release the Pi session's lease and untrack it from the bridge
- called by the extension from `session_shutdown` (reason-branched) **before** `client.close()`, while the socket is still open so the daemon can match the `connectionId`

Proposed request shape:

```ts
{
  agent: "pi",
  session: string,
  project: string,
  connection_id: string,  // SAME stable per-runtime id sent in pi_register_session
}
```

Proposed response shape:

```ts
{ ok: true }
```

Notes:
- calls `storage.releaseSessionLease(session, connectionId, now)` + bridge-internal untrack; the `connectionId` MUST be the same stable id used at register so the daemon matches the lease row
- idempotent (safe to call on an already-released session)
- on success, clears owner/lease metadata so boot-scope-restore will not try to restore a released Pi scope
- this is the primary lease-release path for Pi; PID-liveness is only a fallback for the genuine crash/`quit` case
- see [§ Session replacement & lease release](#session-replacement--lease-release) for why Pi needs an explicit unregister that Claude/Codex do not

## 5. Pi bridge internal behavior

### Session registration

Follow the **same ordering** as Claude/Codex (AGE-38/AGE-45 — ensure-comms LAST, not first, so inbound cannot race ahead of a session that isn't ready):

1. validate `session` / `project` (but bind scope to the **stored** session row at drain/unregister time, not the caller's project)
2. normalize project path
3. upsert session row in storage with `agent = "pi"`
4. `acquireSessionLease(...)` with the stable `connection_id` from params + daemon-owner stamp via `sessionLeaseOwnerWithDaemon(sessionLeaseOwnerFromParams(params), this.options.daemonOwner)` (AGE-58, load-bearing for boot-scope-restore)
5. wire bridge/session state + socket-close handler (releases lease on clean socket close, mirror `claude/bridge.ts:388-390`)
6. `ensureCommsBestEffort(project)` **LAST** — after state + close handler so inbound cannot race ahead (`claude/bridge.ts:396-397`)
7. return `{ ok: true, ... }`

### Inbound drain

Follow the same broad invariants as other bridges:

- only drain entries owned by the Pi session's `(project, agent)` registrations (reuse `ownedAccountKeys(session)`, `claude/bridge.ts:315`)
- do not sweep other agents' pending inbound
- **stamp `most_recent_inbound` on the session row** = last drained conversation (`setSessionMostRecentInbound`, `claude/bridge.ts:404-408`) — load-bearing for no-target `comm_send_message` (see `pi_drain_inbound` notes)
- resolve scope from `storage.getSession(session)`, not the caller's `project`
- cap by `limit`

### Bridge correctness requirements

Consolidated list of the load-bearing bridge behaviors verified against the Claude/Codex code during cross-review (Codex + Claude, 2026-06-17). These are **non-optional for MVP**:

1. **Stable per-runtime `connection_id`.** The Pi extension generates one stable id per extension runtime and sends it in BOTH `pi_register_session` and `pi_unregister_session`. Why: `PersistentIpcClient.registerReplay()` replays exact params after a daemon crash; `acquireSessionLease`'s WHERE clause is `lease_holder_connection_id IS NULL OR = ?` (`sqlite.ts`), so a fresh random id (Claude's `claude:${session}:${crypto.randomUUID()}` fallback at `claude/bridge.ts:347-348`) fails re-acquire against the stale row left by a crashed daemon. A clean socket close releases via `releaseSessionConnectionLeasePreservingOwner` (`claude/bridge.ts:390`), but on a **crash** the close handler never runs — exactly when replay needs the stable id. Pi should generate e.g. `pi:${session}:${runtimeNonce}` once per `session_start` and reuse it.
2. **Registration ordering: ensure-comms LAST** (AGE-38/AGE-45). `upsertSession` → `acquireSessionLease` (daemon-owner stamp) → wire state + socket-close handler → `ensureCommsBestEffort` LAST. Ensuring comms before the lease/state/close-handler is wired lets inbound race ahead of a session that isn't ready. Claude's comment: "after wake registration + close handler so inbound cannot race ahead" (`claude/bridge.ts:396`).
3. **`most_recent_inbound` stamp at drain time.** Because Pi's `onInboundConversation` is a no-op, drain is the **only** place the session's most-recent inbound gets set. Without it, `bus.targetFromSession` (`bus.ts:632-635`) throws on every default no-target send — which is the documented best practice in the tools AND skills. Mirror `claude/bridge.ts:404-408`.
4. **Daemon-owner identity stamp** (AGE-58). `sessionLeaseOwnerWithDaemon(...)` at `acquireSessionLease` time, threaded from `context.daemonOwner` via the factory. Without it `boot-scope-restore` fails-closed (`skipped_no_daemon_owner`) and Pi comms don't restore on daemon restart.
5. **Bind drain/unregister to the stored session row.** Use `storage.getSession(session)` as the scope source of truth; reject/no-op caller-supplied `project` mismatches. Prevents a misrouted call from affecting another scope.
6. **Reuse `ownedAccountKeys` scoping.** Don't reimplement `(project, agent)` scoping; reuse the same helper (`claude/bridge.ts:315`) so the sibling-cannibalization invariant is identical across bridges.
7. **Omit optional bridge methods, don't stub.** `attachComm` / `detachComm` / `invalidateRegistrationCaches` / `onInboundConversation` are all optional on `AgentBridge`; only `agentId` / `ipcMethods` / `attach()` / `handleIpcMethod` are required. A no-op `attach()` is fine for MVP (it's where Claude/Codex wire resolve-sink + `onCallback` — Pi needs neither yet).

### Phase-2 watch item (queries)

When Pi adds queries, check how `bus.setResolveSink` multiplexes across a **3rd** bridge (Claude+Codex coexist today; a third resolve-sink registration must not clobber the existing ones). Non-issue for MVP since Pi has no queries.

### Query support later

When Phase 2 starts, add Pi-owned methods such as:

- `pi_open_query`
- `pi_poll_queries` or `pi_wait_query`
- maybe `pi_ack_query_delivery`

But do not put those in the MVP unless the extension immediately needs them.

## Session replacement & lease release

Pi's session-replacement semantics differ structurally from Codex's, and the difference shapes how the bridge releases leases. This is the one place Pi needs bridge behavior the other hosts do not.

### Why Pi is not Codex

Codex's bridge talks to a long-lived app-server (separate process, thread-scoped). When the user runs `/new`/`/clear` in the CLI, the app-server keeps running with its old thread, the daemon's `CodexBridge` keeps its `(session -> app_server_url, thread_id)` mapping, and inbound keeps steering into the now-stale session invisibly. Codex works around this by killing and relaunching itself (a `session-start.js` bootstrap restart) so the app-server/thread rebinds — and its lease release relies on PID-liveness polling (`releaseLeasesWithDeadOwners`): `/new` relaunches the process -> old PID dies -> lease released.

Pi's extension is **in-process**, so `/new`/`/resume`/`/fork`/`/clone` tear the old extension runtime down and rebind a fresh one **without the Pi process dying**. There is no stale app-server. So Pi largely does **not** have the invisible-continuation problem.

### Why PID-liveness does not work for Pi `/new`

Because the Pi process does not die on `/new`, the daemon's PID-liveness poll sees the old `owner_process_pid` still alive and **does not release the old lease**. Orphaned session rows + comm leases would accumulate faster than Claude/Codex because Pi `/new` is cheap and frequent. This is the actual Pi-specific session-replacement concern, and it is **not** solvable by copying Codex's PID-death trick.

### The Pi superpower: a precise exit signal

Pi's `session_shutdown` event carries a `reason`: `"quit" | "reload" | "new" | "resume" | "fork"`. The extension knows exactly when its session is ending and why. Claude/Codex can only infer session end from process death. This lets Pi give the daemon an intent-carrying session-exit signal instead of relying on process-death heuristics.

### Resolution

1. **No Codex bootstrapper/restart machinery.** No stale app-server; the extension is rebuilt on session replacement with a fresh UUID.
2. **Add `pi_unregister_session` IPC method** (above) that releases the lease + untracks. The extension calls it from `session_shutdown` before `client.close()`.
3. **Release rule keyed on `session_shutdown` reason:**
   - `"new"` / `"resume"` / `"fork"` / `"quit"` -> call `pi_unregister_session` (the old session UUID is genuinely ending; a new one will register)
   - `"reload"` -> **do not** unregister. `/reload` keeps the same session file/UUID; the rebuilt extension re-registers the same `pi_<uuid>` idempotently via `registerReplay`. Releasing here would briefly orphan the session and force a needless re-acquire.
4. **`session_start` `reason` discrimination is free additional signal:**
   - `"new"` / `"fork"` -> fresh session; pending-inbound continuity is the default (messages that arrived during the switch flow into the new session — usually desired)
   - `"resume"` -> continuation expected
   - `"reload"` -> same session, just rebind
5. **`pi_register_session` should still stamp `owner_process_pid`** so PID-liveness works for the genuine `quit`/crash case as a fallback, but the **primary** release path is the explicit unregister, not PID death.

### Pending-inbound policy on `/new`

By default keep flowing (continuity): the remote user is still in the same chat; inbound keeps flowing to whichever Pi session is active. This is arguably correct, not a bug. If a user wants a hard break, a future `/comm-pause` or a "discard pending on new" flag could gate it. Not an MVP blocker.

### Why no protocol-layer edit is needed for `pi_unregister_session`

The IPC protocol (`core-daemon/ipc/protocol.ts`) is method-name-agnostic: `IpcRequest.method` is a plain `string`, dispatch is a `Map<string, IpcMethodHandler>` lookup in `daemon.ts`, and bridges advertise their methods via the `ipcMethods` set. Adding `pi_unregister_session` requires only adding the string to the Pi bridge's `ipcMethods` set + a `case` in `handleIpcMethod` — all inside `core-daemon/bridges/pi/bridge.ts`. No edit to `ipc/protocol.ts`, `ipc/server.ts`, or `daemon.ts`. `IPC_PROTOCOL_VERSION` does not bump (additive method, no wire-schema change); only `DAEMON_VERSION` bumps for the artifact gate.

---

## 6. Files likely touched on daemon side

### New

- `core-daemon/bridges/pi/bridge.ts`

### Modified

- `core-daemon/serve.ts`
- possibly `tests/architecture/*` for new bridge coverage

### Maybe modified only if existing helpers are too Claude/Codex-shaped

- shared session helper code, if any should be extracted from existing bridges
- storage helper usage sites, only if Pi exposes a gap in current bridge ergonomics

The intended rule is: if Pi needs a helper, prefer extracting a **generic** helper rather than adding Pi conditionals in `daemon.ts`.

---

## Pi package plan

## 1. Package shape

Create a new Pi package (source of truth under `plugins/pi/agents-comm/` in this monorepo; see [Distribution (Option B)](#distribution-option-b) for how it ships), with a structure like:

```text
pi-agents-comm/
  package.json
  extensions/
    agents-comm/
      index.ts
      daemon-client.ts
      inbound-format.ts
      session-id.ts
      tools.ts
      commands.ts
  skills/
    telegram/SKILL.md
    discord/SKILL.md
    matrix/SKILL.md
    curl/SKILL.md
  README.md
```

This package is the Pi equivalent of `plugins/claude/<comm>/` and `plugins/codex/<comm>/`. See [Distribution (Option B)](#distribution-option-b) below for how it ships.

## 2. `package.json` shape

Use a Pi package manifest:

```json
{
  "name": "@earendil-works/pi-agents-comm",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

Dependency guidance:

- Pi runtime imports such as `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` should be `peerDependencies` with `"*"` per Pi docs.
- daemon-client/runtime deps belong in `dependencies`.

## 3. Extension entrypoint responsibilities

Primary file:

- `extensions/agents-comm/index.ts`

It should:

1. register Pi comm tools on load
2. on `session_start`, register the Pi session with the daemon
3. start an inbound polling loop
4. on inbound messages, inject them using `pi.sendUserMessage(...)`
5. on `session_shutdown`, stop timers/connections cleanly
6. expose optional slash commands for diagnostics/admin

## 4. Extension helper modules

### `daemon-client.ts`

Responsibilities:
- own a `PersistentIpcClient` for the Pi session lifetime (not a sidecar — in-process WS)
- `start()` on `session_start`, `close()` on `session_shutdown`
- `registerReplay("pi_register_session", ...)` so daemon restarts transparently re-register
- wrap `request(method, params)` for Pi use; surface `DisconnectedError` concisely to tools/poller

See [§ IPC client lifecycle](#ipc-client-lifecycle) for the rationale and wiring sketch.

Possible exported helpers:

- `registerPiSession(...)`
- `unregisterPiSession(...)` (session_shutdown, reason-branched)
- `drainPiInbound(...)`
- `sendCommMessage(...)`
- `sendCommAttachment(...)`
- `listConversations(...)`
- `ensureCommsForScope(...)` if needed separately from session registration

### `session-id.ts`

Responsibilities:
- derive a stable Pi session id from `ctx.sessionManager.getSessionId()`
- produce `pi_<uuid>` directly — no hashing, no cwd fallback, no env override
- no project baked into the id (project is a separate `pi_register_session` param)

See [§ Pi session identity](#pi-session-identity) for the rationale and stability properties. The implementation is a one-liner; the value is in not reimplementing Claude/Codex's defensive derivation.

### `inbound-format.ts`

Responsibilities:
- format daemon-delivered inbound messages into the same readable envelope style already used by Claude/Codex
- include routing metadata (`comm`, `account`, `chat_native_id`, `thread_native_id`, `conversation_id`, etc.)
- mention attachment local paths when available

Starting with the existing `[Daemon Inbound Messages] ...` block format is a feature, not a bug: it keeps the prompt contract familiar across hosts.

### `tools.ts`

Responsibilities:
- define Pi-registered tools:
  - `comm_send_message`
  - `comm_send_attachment`
  - `comm_check_messages`
  - `list_conversations`
- implement schemas with `typebox`
- return concise result text

These tools should intentionally mirror the current MCP tool semantics so the bundled skills can be close to the existing Claude/Codex host skills.

### `commands.ts`

Optional but recommended.

Useful commands:
- `/comm-status`
- `/comm-poll-now`
- `/comm-list`
- `/comm-pause`
- `/comm-resume`

These are not required for MVP correctness, but they make smoke testing and operator support much easier.

---

## Distribution (Option B)

This is the Pi-specific instance of **Option B** in [`docs/research/install-model.md`](../install-model.md) (the fallback for any agent whose marketplace/package format lacks git-subdir support). Pi packages do **not** support git-subdir sources: a `pi install git:<url>@<ref>` clones the whole repo and looks for the `pi` manifest at the repo root, so a subdirectory of the agents-comm-bus monorepo cannot be a Pi git source directly. Local paths *do* support subdirectories, so dev loading works either way.

### Source of truth

The package source and built artifacts live in this monorepo under `plugins/pi/agents-comm/`, parallel to `plugins/claude/<comm>/` and `plugins/codex/<comm>/`. CI builds and commits artifacts here on each release, same Option A discipline as the other agents.

### Release path

A dedicated Pi package repo (root = the Pi package) hosts the installable package. Its contents are a **full-package mirror** of `plugins/pi/agents-comm/`, synced by CI on each release tag. Install with either:

```bash
pi install git:github.com/<you>/pi-agents-comm@v1   # git source
# or
pi install npm:@<scope>/pi-agents-comm              # if published to npm
```

### Pi-specific nuance vs. Claude/Codex

Unlike Claude and Codex marketplace repos (thin manifest files pointing into the monorepo via git-subdir), the Pi package repo is **not** a thin manifest. Pi packages are self-contained: `package.json` with a `pi` manifest + `extensions/` + `skills/`. So CI's release step for Pi is a straight directory sync from `plugins/pi/agents-comm/` into the dedicated repo root, not a manifest pin bump.

### Release-pipeline gap (needs resolution before release)

Cross-review (Codex + Claude, 2026-06-17) flagged a real packaging gap. The existing `scripts/stage-plugins.js` emits **one artifact per `(agent, comm)`** and copies exactly one `${comm}.adapter.bundle.js` plus an install stamp for that comm. The Pi plan wants **one combined package for all comms**, which does not fit that model. Two options:

1. **New Pi staging path** — a dedicated staging step that assembles a single Pi package containing all adapter bundles + `adapter_bundle_versions` for all comms, plus its own production-install/verify gate. More upfront work; matches the one-package-all-comms product shape.
2. **Per-comm Pi packages** — reuse the current `stage-plugins.js` model: one Pi package per comm (`plugins/pi/<comm>/`), each carrying one adapter bundle. Less new plumbing; closer to the Claude/Codex release train; but diverges from the "one combined package" decision in Phase 0 and means a user installing Pi+Telegram and Pi+Discord gets two packages.

This is a release-pipeline decision, not an MVP code blocker — the daemon bridge + extension can be built and smoke-tested against either shape. It must be resolved before the first real release. Tracked as an open item below.

### Local dev

During development, load the in-repo subfolder directly:

```bash
pi -e ./plugins/pi/agents-comm       # ephemeral try
pi install /abs/path/to/plugins/pi/agents-comm   # persisted local install
```

Relative local paths resolve against the settings file, so an in-repo subfolder works for dev regardless of the git-subdir limitation.

---

## Dev mode

There are two distinct Pi scenarios, and the README did not previously codify the difference. Getting this right matters because the Pi extension is a **new caller of the shared `entryEnsures` / `applyDevConfig` dev-config resolver** — the same one Claude/Codex hooks and MCP shims already use. Pi inherits dev mode for free *only if* it calls that resolver the same way; it is not automatic.

### The two scenarios

| | Dev (this repo) | Prod (consumer repo) |
|---|---|---|
| Who runs Pi here | a developer iterating on the Pi host/extension in the agents-comm-bus monorepo | a user in some other project who `pi install`ed the released package |
| Pi cwd | the agents-comm-bus repo root | the consumer's project |
| Extension source | `plugins/pi/agents-comm/` loaded via `pi -e` or project `.pi/settings.json` local path | the installed package under `~/.pi/agent/...` (npm/git) or `.pi/...` (project) |
| Daemon the extension talks to | source daemon at `agents-comm-bus/dist/core-daemon/serve.js` | central daemon at `~/.agents-comm-bus/bin/daemon.js` |
| State root | `.agents-comm-bus-dev/` (gitignored, repo-local) | `~/.agents-comm-bus/` (per-user) |
| Discovery root | `.agents-comm-bus-discovery/` (gitignored, repo-local) | `~/.agents-comm-bus/` |
| Dev marker | `.agents-comm-bus-dev.json` present at repo root | **must not be present** — strict prod mode |
| Comm account registration | `agents-comm account-add` against the dev state root (via `AGENTS_COMM_BUS_ROOT` env or dev marker) | `agents-comm account-add` against `~/.agents-comm-bus/` (the default) |
| Comm-resource leases | still homedir/global (dev and prod daemons arbitrate the same bot leases) | same |

### How Pi inherits dev mode for free

The existing resolver (`hosts/common/install/entry-ensures.js` → `dev-config-resolver.js`) already:
1. walks up from `fromDir` to find `.agents-comm-bus-dev.json` at the project root,
2. reads `daemonBin` / `adaptersDir` / `discoveryRoot` / optional `stateRoot`,
3. populates the `AGENTS_COMM_BUS_BIN` / `AGENTS_COMM_BUS_ADAPTERS_DIR` / `AGENTS_COMM_BUS_ROOT` env-shaped values,
4. passes them to `ensureDaemon` so the daemon runs from source.

The Pi extension's `daemon-client.ts` becomes a new caller of `entryEnsures`. The only hard requirement is: **pass `fromDir` so the project-root walk resolves**. Concretely, pass the extension's own module location (`import.meta.dirname`) when invoked from the package, and let the resolver walk up to the dev marker in dev, or fall through to strict prod mode in a consumer repo. Do **not** hand-roll env-var detection in the extension — that would fork the dev-mode contract.

### Dev isolation and prod coexistence

This repo already uses the documented pattern: `.agents-comm-bus-dev.json` at the repo root points `daemonBin` at `agents-comm-bus/dist/core-daemon/serve.js` and `discoveryRoot` at `.agents-comm-bus-discovery/` (gitignored). The Pi dev extension plugs into that unchanged. Two daemons (dev here + prod at `~/.agents-comm-bus/`) coexist with separate state roots and separate `port`/`daemon.pid`/`.spawn.lock` under their respective roots. **Comm-resource leases remain homedir/global**, so a dev and a prod daemon still arbitrate the same Telegram bot lease exclusively — a dev daemon will not reclaim a bot a higher-rank prod daemon holds (see AGENTS.md § State paths).

### Loading the source extension in dev

Two equivalent dev load paths:

```bash
# ephemeral, one-off:
pi -e ./plugins/pi/agents-comm

# persisted for this checkout (project-scoped, shareable with teammates):
#   .pi/settings.json
{
  "packages": [
    "/abs/path/to/agents-comm-bus/plugins/pi/agents-comm"
  ]
}
```
Project-scoped `.pi/settings.json` is the dev equivalent of Claude's `.mcp.json` + `.claude/settings.local.json`: it points Pi at the source extension without touching the user-scope package install.

### Iteration loop

Because the Pi extension is in-process to Pi and the bridge is daemon-side, dev iteration touches both sides:

1. Edit `core-daemon/bridges/pi/bridge.ts` (daemon side).
2. `npm --workspace agents-comm-bus run build` (rebuild dist).
3. Restart the dev daemon: stop the pid in `.agents-comm-bus-discovery/daemon.pid`, delete `.agents-comm-bus-discovery/port` + `daemon.pid`. The next `entryEnsures` call respawns it from the new `serve.js`.
4. `/reload` in Pi (or restart Pi). The extension's `session_start` re-fires; `registerReplay("pi_register_session", ...)` idempotently re-registers the same `pi_<uuid>` against the restarted daemon. No re-acquire dance needed.
5. Edit extension source (`plugins/pi/agents-comm/extensions/...`) — TypeScript via jiti, so `/reload` picks it up without a separate build step (jiti transpiles on load).

### What must NOT ship in the released package

- `.agents-comm-bus-dev.json` (dev marker)
- `.agents-comm-bus-discovery/` (dev discovery dir)
- any `.pi/settings.json` that points at a local absolute path
The Option B full-package mirror (see [Distribution (Option B)](#distribution-option-b)) must exclude these. A consumer repo has no dev marker, so `entryEnsures` runs in strict prod mode and bootstraps the central daemon — exactly the prod contract.

### Daemon-module resolution: dev vs prod

- Dev: the extension imports daemon-client code from the repo's `agents-comm-bus/dist/...` (resolved via the monorepo workspace). Editing bridge/IPC code and rebuilding dist is visible to the dev daemon.
- Prod: the released Pi package declares `agents-comm-bus` as a `dependency` (or bundles it) so the import resolves from `node_modules/agents-comm-bus/dist/...`. The version pin in `package.json` is what keeps the extension and the central daemon protocol-compatible.

---

## Pi extension runtime behavior

## 1. Session lifecycle

### On `session_start`

1. compute/restore stable Pi session id
2. call `pi_register_session`
3. start inbound polling loop
4. optionally show a small status notification (`ctx.ui.notify`) in TUI mode

### On `session_shutdown`

1. stop polling loop
2. close daemon IPC client if one is held open
3. clear transient status/widgets if any are used

## 2. Inbound delivery strategy

Pi can wake itself naturally; no watcher needed.

Recommended behavior:

- polling loop calls `pi_drain_inbound`
- if zero messages, do nothing
- if messages exist, format them into one user-visible block
- inject with `pi.sendUserMessage(...)`

Delivery mode:
- if Pi is idle: send immediately
- if Pi is streaming: use `{ deliverAs: "followUp" }` for MVP safety

Why `followUp` first:
- safer than mid-turn steering while the base behavior is still being proven
- avoids surprising interruption semantics during the first implementation

A later enhancement may choose `steer` for specific inbound classes.

## 3. Tool semantics

### `comm_send_message`

- should send via `daemonRequest(`${comm}_send`, { message, target })`
- best practice remains: omit `target` to reply to the session's most-recent inbound conversation
- if `target.account` is supplied, it must be a concrete bot id, not an account label

### `comm_send_attachment`

- should mirror current MCP semantics
- validate path exists before daemon request when practical

### `comm_check_messages`

Two viable behaviors:

1. directly call the Pi bridge `pi_drain_inbound`
2. call generic daemon drain if the bridge is not needed

Recommendation: use `pi_drain_inbound` so all inbound scoping stays consistent with session registration.

### `list_conversations`

- should call generic `list_conversations`
- return the same bot-id-oriented display style used today, because `bot_user_id` is the routing key users need

---

## Skill plan

Bundle Pi skills that teach the agent the comm workflow.

## 1. Per-comm skills

Create:

```text
skills/telegram/SKILL.md
skills/discord/SKILL.md
skills/matrix/SKILL.md
skills/curl/SKILL.md
```

These should be Pi-adapted versions of the existing host skills, preserving the important behavior rules:

- inbound may arrive in a `[Daemon Inbound Messages]` block
- user-visible remote replies should go back over `comm_send_message`
- omit `target` to reply to the most-recent inbound unless intentionally targeting elsewhere
- use `list_conversations` only when explicitly choosing another destination
- use `comm_check_messages` when you suspect new inbound arrived

## 2. Shared guidance points

Every Pi comm skill should remind the model that:

1. **local terminal output is not the same as replying to the remote comm user**
2. **`comm_send_message` is the user-visible outbound channel**
3. **the inbound envelope surfaces the concrete `account=<bot_id>` routing key**
4. **account labels like `main` are human aliases, not send targets**

---

## Concrete implementation sequence by file

## Phase 1 — daemon MVP

### 1. Add Pi bridge

Create:
- `core-daemon/bridges/pi/bridge.ts`

Implement:
- `PiBridgeFactory`
- `PiBridge`
- `ipcMethods = new Set(["pi_register_session", "pi_drain_inbound", "pi_unregister_session"])`

### 2. Wire bridge into composition root

Modify:
- `core-daemon/serve.ts`

### 3. Add/adjust tests

Add:
- `tests/architecture/pi-bridge.test.ts`

Test cases:
- `pi_register_session` ensures comms for `(project, "pi")`
- registration upserts session correctly
- `pi_drain_inbound` drains only Pi-owned pending inbound
- drain honors `(message_id, comm, account)` scoping
- repeated registration is idempotent

## Phase 2 — Pi package MVP

### 4. Create package skeleton

Create package files:
- `package.json`
- `extensions/agents-comm/index.ts`
- `extensions/agents-comm/daemon-client.ts`
- `extensions/agents-comm/inbound-format.ts`
- `extensions/agents-comm/session-id.ts`
- `extensions/agents-comm/tools.ts`
- optional `extensions/agents-comm/commands.ts`
- `skills/*/SKILL.md`

### 5. Implement daemon client wrapper

Start simple:
- one helper that establishes IPC, requests, and closes
- optimize to persistent connection only if needed

### 6. Implement session registration + polling

In `index.ts`:
- `session_start` -> `pi_register_session`
- start `setInterval` or similar async loop
- `session_shutdown` -> stop loop

### 7. Implement tools

In `tools.ts`:
- register the four comm tools
- use `typebox` schemas matching existing MCP behavior

### 8. Implement inbound formatting + injection

In `inbound-format.ts` + `index.ts`:
- format messages into daemon inbound block
- inject via `pi.sendUserMessage(...)`

### 9. Add diagnostic commands

In `commands.ts`:
- `/comm-status`
- `/comm-poll-now`
- `/comm-pause`
- `/comm-resume`

## Phase 3 — smoke tests

### 10. Manual E2E with Telegram first

Verify:
- Pi session starts and registers
- inbound Telegram arrives in Pi
- Pi can answer with `comm_send_message`
- reply routes to the correct bot/chat
- busy Pi receives inbound as follow-up, not lost

---

## Test plan

## Daemon tests

Add a focused suite for the Pi bridge:

- registration calls `ensureCommsForSession(project, "pi")`
- session row records `agent = "pi"`
- most-recent inbound state is updated consistently with existing bridge expectations
- drain respects Pi scope and leaves other agents' entries intact
- unsupported/invalid params fail loudly and predictably

## Package/extension tests

If the Pi package gets test coverage in-repo, start with:

- session id derivation stability
- inbound formatter snapshot-ish tests
- tool argument validation
- idle vs streaming delivery decision logic

## Manual smoke tests

1. register a Telegram bot for `--agent pi`
2. install/load the Pi package
3. send inbound message from Telegram
4. verify Pi receives a user turn containing daemon inbound block
5. have Pi reply via `comm_send_message`
6. verify the correct Telegram bot and chat receive it
7. test a second agent on the same chat to confirm Pi drain does not cannibalize sibling inbound

---

## Risks and mitigation

## 1. Pi session identity may not expose a perfect stable id

Mitigation:
- start with the best stable session artifact Pi exposes
- keep the derivation isolated in `session-id.ts`
- if needed, later persist a generated id via Pi session custom entries

## 2. Polling loop may duplicate or race with itself

Mitigation:
- maintain one loop per active extension runtime
- serialize drain calls; do not allow overlapping polls
- stop loop on `session_shutdown`

## 3. Mid-stream message injection semantics may be surprising

Mitigation:
- default to `followUp` for MVP
- only adopt `steer` after explicit validation

## 4. Query/permission parity may pressure the bridge design later

Mitigation:
- make `pi_register_session` / `pi_drain_inbound` clean first-class IPC methods now
- leave extension internals structured so query polling/opening can slot in later

## 5. Risk of over-copying Claude/Codex host code

Mitigation:
- extract only genuinely shared formatting/IPC helper ideas
- do not import watcher/bootstrap assumptions into Pi

---

## Open questions

1. ~~What is the best canonical stable Pi session identifier available to an extension?~~
   **Resolved** — derive directly from `ctx.sessionManager.getSessionId()`
   (the session UUID baked into the `<timestamp>_<uuid>.jsonl` filename
   and used by `/resume`). Produce `pi_${uuid}` — no hashing, no cwd
   fallback, no env override. See [§ Pi session identity](#pi-session-identity).
2. ~~Should the Pi package use a short-lived IPC connection per request or maintain a persistent client?~~
   **Resolved** — persistent client, via `PersistentIpcClient`
   (`agents-comm-bus/dist/core-daemon/ipc/persistent-client.js`). Use
   `registerReplay("pi_register_session", ...)` so the session lease is
   transparently re-acquired after a daemon restart. `session_start` →
   `start()`; `session_shutdown` → `close()`. See [§ IPC client lifecycle](#ipc-client-lifecycle).
3. ~~Is there any Pi-specific notion of project/session replacement that should trigger re-registration beyond normal `session_start`?~~
   **Resolved** — yes: Pi `/new`/`/resume`/`/fork`/`/clone` do not kill the
   process, so PID-liveness lease release (Codex's model) does not work.
   Add an explicit `pi_unregister_session` IPC method called from a
   reason-branched `session_shutdown` handler (release on
   new/resume/fork/quit; skip on reload). No Codex-style bootstrapper
   needed. See [§ Session replacement & lease release](#session-replacement--lease-release).
4. For Phase 2, should remote approvals use a polling model from the extension or a more event-like query wait path?
5. ~~Does the eventual distribution shape want one Pi package for all comms or separate per-comm Pi packages that reuse a shared base?~~ Resolved — see [Distribution (Option B)](#distribution-option-b).
6. **Release-pipeline shape for the combined Pi package.** `scripts/stage-plugins.js` is per-`(agent, comm)` with one adapter bundle each; the one-package-all-comms Pi shape needs either a new Pi staging path + production-install/verify gate, or a switch to per-comm Pi packages. Not an MVP code blocker, but must be resolved before the first real release. See [§ Release-pipeline gap](#release-pipeline-gap-needs-resolution-before-release).

---

## Pi session identity

The canonical stable Pi session identifier is `ctx.sessionManager.getSessionId()` — the session UUID Pi writes into the `<timestamp>_<uuid>.jsonl` filename and keys `/resume` off. Unlike Claude/Codex, Pi exposes this as a single typed API returning a clean UUID, so the defensive hashing + cwd-fallback derivation the other hosts use is unnecessary here.

### Derivation

```ts
// session-id.ts
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export function piSessionId(sm: SessionManager): string {
  return `pi_${sm.getSessionId()}`;
}
```

Read it fresh inside each `session_start` handler; do not cache across reload (the extension runtime is rebuilt on `/reload`/`/new`/`/fork`/`/resume`).

### Why no hashing

Claude/Codex hash because their hook input is an arbitrary string (session id, env var, or cwd fallback) of unbounded length. Pi's `getSessionId()` is already a bounded UUID, so the hash would only throw away debuggability: `pi_3f9a...` in audit logs correlates directly to the session file on disk.

### Stability properties

| Event | UUID | Daemon session | Correct? |
|---|---|---|---|
| `/resume` | unchanged (same file) | re-register idempotently | inbound continues to existing conversation |
| `/new`, `/fork` | new file → new UUID | new session | **same conversation continues** (conversation identity is keyed by `(project, agent, comm, account_label, chat, thread)`, not session — `/new`/`/fork` create a new *session*, not a new *conversation*; pending-inbound keeps flowing to whichever Pi session is active) |
| `/reload` | unchanged | idempotent re-register | polling loop rebinds |
| daemon restart | unchanged (UUID in filename) | re-associate on next register | routing survives |
| two Pi instances, same project | different files → different UUIDs | no collision | correct |

### What about project scoping?

Do **not** bake `cwd` into the session id. The daemon already scopes by `project` (passed separately to `pi_register_session`), and conversations are keyed by `(project, agent, comm, account_label, chat, thread)`. The session id only needs to be unique-per-Pi-session; encoding project into it is redundant and would break across a `/resume` into a renamed project root.

### Edge case: ephemeral / in-memory sessions

`getSessionId()` returns a UUID even for in-memory (`SessionManager.inMemory()`) sessions — `AgentSession.sessionId` is typed `string`, never undefined. So the derivation works uniformly with no fallback path. `getSessionFile()` would be undefined for those, which is exactly why `getSessionId()` (not the file path) is the right source.

---

## IPC client lifecycle

The Pi extension holds one long-lived in-process WebSocket connection to the daemon for the whole Pi session, using `PersistentIpcClient` from `agents-comm-bus/dist/core-daemon/ipc/persistent-client.js`. This is **not** a sidecar process — the client lives inside the Pi process; only the daemon is a separate process.

### Why persistent over short-lived

| | short-lived (`connectIpc`) | persistent (`PersistentIpcClient`) |
|---|---|---|
| Shape | open WS → handshake → request → close, per call | one WS for the session |
| Used by today | Claude/Codex hooks (one-shot per prompt) | Claude/Codex MCP shims (session-long) |
| Per-poll / per-tool overhead | handshake every time | one handshake total |
| Daemon restart | each caller re-ensures next time | auto-reconnect + `ensureDaemon` respawn |
| Session lease resume | caller must re-register manually | `registerReplay` re-issues on every reconnect |

Pi is session-long with a polling loop + four tools all hitting the daemon, so it matches the MCP-shim shape, not the hook shape.

### Wiring

```ts
// on session_start
client = new PersistentIpcClient({
  clientVersion: "pi-extension-1",
  metadata: { agent: "pi", project, shimName: "pi-agents-comm" },
  ensureDaemonOptions: { /* from entryEnsures */ },
  onReconnected: (hello) => { /* optional diagnostics */ },
});
await client.start();
await client.registerReplay("pi_register_session", { agent: "pi", session, project, cwd: project, /* host info */ });

// tools + poller call client.request(method, params)

// on session_shutdown
client.close();
```

`registerReplay` both issues the request immediately and queues it for replay on every future reconnect, so a daemon restart mid-session transparently re-registers the Pi session and re-acquires its lease — no extension code needed to detect the restart.

### Failure mode during momentary disconnect

`client.request()` throws `DisconnectedError` if the socket is momentarily down. Tools and the poller should catch this and surface a concise error (do not crash the extension); the client is already scheduling a reconnect in the background.

---

## Recommended first implementation cut

If implementing immediately, the smallest valuable cut is:

1. `core-daemon/bridges/pi/bridge.ts`
2. `core-daemon/serve.ts` registration
3. Pi package extension with:
   - `pi_register_session`
   - `pi_unregister_session` (session_shutdown, reason-branched)
   - `pi_drain_inbound`
   - `comm_send_message`
   - `comm_check_messages`
4. one Pi skill for Telegram
5. Telegram smoke test

That proves the architectural seam with minimum surface area. After that, add:

- attachment send
- conversation listing
- extra comm skills
- remote query/permission support

## Go/no-go recommendation

Go.

A Pi host version fits the current universal-overhaul architecture naturally if it is implemented as a new daemon bridge plus a Pi package extension. Pi is likely the **simplest** host to integrate of the three because it already gives the host-side primitives Claude/Codex had to approximate with hooks and external wake mechanisms.
