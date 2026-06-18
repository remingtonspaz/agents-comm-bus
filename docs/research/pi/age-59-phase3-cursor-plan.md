# AGE-59 Phase 3 — Pi package skeleton implementation plan

**Issue:** AGE-59 (The Pi Host)
**Branch:** `satriodewantono/age-59-pi-skeleton`
**Worktree:** `D:\tmp\acb-age59-p3`
**Base:** `main` (currently at `aa560eb`)
**Scope:** Phase 3 ONLY — the Pi package skeleton. Create the package directory, `package.json`, README, and the extension module file layout as **stubs with documented signatures + TODO markers**. Do NOT implement the module bodies — that is Phase 4. The one substantive code change in Phase 3 is adding `./ipc/persistent-client` to the `agents-comm-bus` exports map (small, additive, needed so the Pi extension can import `PersistentIpcClient` cleanly in Phase 4).

## READ THESE FIRST (in order)

1. **`docs/research/pi/CHECKLIST.md`** — the authoritative checklist. Read the whole **Phase 3** section (§3.1, §3.1b, §3.2) and tick items off mentally as you satisfy them. Also skim Phase 4 so you know what each stubbed module is scaffolding for (don't implement Phase 4, but the stubs' exported signatures should anticipate it).
2. **`docs/research/pi/README.md`** — the design. Especially:
   - § "Pi package plan" (package shape, `package.json` shape, helper-module responsibilities)
   - § "Distribution (Option B)" + § "Release-pipeline gap" (why the package lives under `plugins/pi/agents-comm/`, and the open release-pipeline decision)
   - § "Dev mode" (the `entryEnsures` / `fromDir` seam — load-bearing for Phase 4, informs the daemon-client stub)
   - § "IPC client lifecycle" (why `PersistentIpcClient` + `registerReplay`)
   - § "Pi session identity" (the `piSessionId` one-liner that `session-id.ts` will implement in Phase 4)
   - § "Bridge correctness requirements" (the 7 MUST-fixes — already satisfied daemon-side in Phase 1; Phase 4 will honor them extension-side)
3. **`docs/research/pi/age-59-phase1-cursor-plan.md`** — for context on what the daemon bridge already provides (the `pi_*` IPC methods the extension will call).

## Reference files (existing patterns to mirror)

- `plugins/claude/telegram/` and `plugins/codex/telegram/` — the existing per-`(agent, comm)` plugin tree shapes. **Pi is NOT per-comm** — it's one combined package at `plugins/pi/agents-comm/` (per Phase 0 resolution). So don't mirror the `plugins/<agent>/<comm>/` nesting; mirror the *contents* (a package root with `package.json` + README + source).
- `hosts/common/mcp-shim-shared.js` — how the existing shims import `entryEnsures` and `PersistentIpcClient`. Note line 14: `import { PersistentIpcClient } from "../../agents-comm-bus/dist/core-daemon/ipc/persistent-client.js"` — a deep path that bypasses the exports map. Phase 3 fixes this by adding the export.
- `agents-comm-bus/package.json` — the `exports` map you'll extend.
- `C:/Users/Satrio/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/packages.md` and `.../docs/extensions.md` — Pi package manifest conventions (`pi` key, `peerDependencies` rule, auto-discovery directories). Read the "Creating a Pi Package" and "Dependencies" sections of packages.md.

## Deliverables

### 1. Package directory: `plugins/pi/agents-comm/` (NEW)

Create the full tree:

```
plugins/pi/agents-comm/
  package.json
  README.md
  extensions/
    agents-comm/
      index.ts          (stub)
      daemon-client.ts  (stub)
      session-id.ts     (stub)
      inbound-format.ts (stub)
      tools.ts          (stub)
      commands.ts       (stub, optional)
  skills/
    telegram/
      SKILL.md          (stub — Phase 6 fills content)
    discord/
      SKILL.md          (stub)
    matrix/
      SKILL.md          (stub)
    curl/
      SKILL.md          (stub)
```

The `extensions/` and `skills/` directory names matter — Pi auto-discovers `extensions/*.ts` and `skills/**/SKILL.md` per the Pi packages convention. The `agents-comm/` subfolder under `extensions/` is the directory-with-index pattern (Pi loads `extensions/*/index.ts`).

### 2. `plugins/pi/agents-comm/package.json` (NEW)

Per the README § "package.json shape" and the Pi packages doc:

```json
{
  "name": "@agents-comm-bus/pi-agents-comm",
  "version": "0.1.0",
  "description": "Pi host extension for agents-comm-bus — comm tools + inbound delivery for Pi sessions.",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  },
  "dependencies": {
    "agents-comm-bus": "0.2.29"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "engines": {
    "node": ">=22"
  },
  "license": "MIT"
}
```

Notes:
- `agents-comm-bus` in `dependencies` (NOT peer) — per README § Dev mode / "Daemon-module resolution", prod resolves it from `node_modules/`; dev resolves from the monorepo workspace. Pin to `0.2.29` (the current DAEMON_VERSION after Phase 1).
- The four Pi-runtime packages in `peerDependencies` at `"*"` — per the Pi packages doc: "list them in `peerDependencies` with a `*` range and do not bundle them."
- `keywords: ["pi-package"]` is required for Pi package discovery.
- `name` is scoped under `@agents-comm-bus/` to match the project namespace; adjust if Satrio prefers a different scope (leave a TODO comment if unsure — but the name above is a reasonable default, don't block on it).

### 3. `plugins/pi/agents-comm/README.md` (NEW)

A concise package README covering:
- One-paragraph what-it-is (Pi host extension for agents-comm-bus).
- Install (local dev: `pi -e ./plugins/pi/agents-comm` or `.pi/settings.json` local path; released: `pi install git:...` or `npm:...` per Option B).
- Prerequisites: an `agents-comm-bus` daemon registered with `agent=pi` (`agents-comm account-add --project <path> --agent pi --account-label main --comm <telegram|...> --bot-token <token>`).
- Dev mode note (the `.agents-comm-bus-dev.json` marker is picked up via the shared `entryEnsures` — see `docs/research/pi/README.md` § Dev mode).
- Status: Phase 3 skeleton; comm tools + inbound delivery land in Phase 4; skills content in Phase 6.
- Link to `docs/research/pi/README.md` + `CHECKLIST.md` for the full design.

Keep it short — the canonical docs live in `docs/research/pi/`.

### 4. Extension module stubs (`extensions/agents-comm/*.ts`)

Each stub file: a module-level doc comment naming its Phase 4 responsibility (copied/adapted from the CHECKLIST §4.x items), the intended exported signatures as `export` declarations with `TODO(phase4)` bodies that throw `new Error("phase4: not implemented")`, and any imports it will need. **Do NOT implement the bodies.** The goal is a skeleton that Phase 4 fills in and that `pi -e` can at least load without throwing at import time (the throws are at call time).

Mirror the responsibilities in `docs/research/pi/README.md` § "Extension helper modules" and CHECKLIST §4.1–4.4:

- **`session-id.ts`** — `export function piSessionId(sm: SessionManager): string` returning `pi_${sm.getSessionId()}`. (This one is a one-liner per the README; you may implement it fully since it's trivial — but mark with a comment that Phase 4 owns the "read fresh inside each session_start" usage rule.) Import type `SessionManager` from `@earendil-works/pi-coding-agent`.

- **`daemon-client.ts`** — export a `PiDaemonClient` class (or factory) with method stubs: `start()`, `close()`, `registerPiSession(params)`, `unregisterPiSession(params)`, `drainPiInbound(params)`, `sendCommMessage(params)`, `sendCommAttachment(params)`, `listConversations(params)`. Doc-comment: owns a `PersistentIpcClient` (imported from `agents-comm-bus` — see the exports-map fix below), `start()` on session_start, `close()` on session_shutdown, `registerReplay("pi_register_session", ...)` for transparent re-registration. Calls shared `entryEnsures` with `fromDir: import.meta.dirname` for dev/prod seam (see README § Dev mode). **Do not implement; throw `TODO(phase4)`.**

- **`inbound-format.ts`** — `export function formatInboundMessages(items: PendingInboundEntry[]): string` producing the `[Daemon Inbound Messages] ... [End Daemon Inbound Messages]` block. Doc-comment: port the format from `hosts/claude/hooks/user-prompt-submit.js` (`formatInboundMessages` function there); envelope fields `comm`, `account`, `account_label`, `chat_native_id`, `thread_native_id`, `conversation_id`, `platform_message_id`, `message_id`; attachment lines (mime, filename, size, local_path / blob_hash); no Pi-specific fields. **Do not implement; throw `TODO(phase4)`.** (Type the input loosely or import a type if `agents-comm-bus` exports one; otherwise `unknown[]` with a doc comment.)

- **`tools.ts`** — `export function registerCommTools(pi: ExtensionAPI): void` that will call `pi.registerTool(...)` for `comm_send_message`, `comm_send_attachment`, `comm_check_messages`, `list_conversations`. Doc-comment the schemas (typebox) and the "omit target to reply to most-recent inbound" + "target.account must be a concrete bot id" semantics from README § "Pi tools" and CHECKLIST §5. **Do not implement; throw `TODO(phase4)`.**

- **`commands.ts`** — `export function registerCommCommands(pi: ExtensionAPI): void` for `/comm-status`, `/comm-poll-now`, `/comm-list`, `/comm-pause`, `/comm-resume`. Mark optional-for-MVP. **Do not implement; throw `TODO(phase4)`.**

- **`index.ts`** — the entrypoint. `export default function (pi: ExtensionAPI) { ... }` that, in Phase 4, will: register tools + commands on load; wire `session_start` (compute session id, `client.start()`, `registerReplay`, start poller); wire `session_shutdown` (reason-branched: stop poller; if reason in {new,resume,fork,quit} call `unregisterPiSession` before close; if reload skip unregister; `client.close()`). For Phase 3, the body should call `registerCommTools(pi)` and `registerCommCommands(pi)` (which throw TODO) and leave the session handlers as `// TODO(phase4): pi.on("session_start", ...)` / `// TODO(phase4): pi.on("session_shutdown", ...)` comments. **The module MUST load without throwing at import time** — only call-time should throw. Import `ExtensionAPI` type from `@earendil-works/pi-coding-agent`.

### 5. Skill stubs (`skills/<comm>/SKILL.md`)

One stub per comm (telegram, discord, matrix, curl). Each is a minimal SKILL.md with frontmatter (`name`, `description`) and a `TODO(phase6)` body placeholder noting it will teach the model the comm workflow (see CHECKLIST §6.2 for the content checklist). Keep frontmatter valid so Pi discovery doesn't choke.

Example for `skills/telegram/SKILL.md`:
```markdown
---
name: agents-comm-telegram
description: TODO(phase6) — agents-comm-bus Telegram comm workflow for Pi sessions.
---

# agents-comm-bus Telegram (stub)

TODO(phase6): fill in per `docs/research/pi/CHECKLIST.md` §6.2.
```

### 6. `agents-comm-bus/package.json` exports map (MODIFY — the one substantive code change)

Add `./ipc/persistent-client` to the `exports` map so the Pi extension can import `PersistentIpcClient` cleanly in Phase 4 instead of via a deep `dist/` path (which bypasses the exports map and is fragile). Mirror the existing `./ipc/client` entry shape:

```json
"./ipc/persistent-client": {
  "import": "./dist/core-daemon/ipc/persistent-client.js",
  "types": "./dist/core-daemon/ipc/persistent-client.d.ts"
}
```

Insert it immediately after the existing `./ipc/client` entry. This is purely additive — no existing import changes. The `dist/core-daemon/ipc/persistent-client.{js,d.ts}` files already exist (Phase 1 build compiles them).

### 7. `entryEnsures` seam — DOCUMENT, do not fix in Phase 3

The shared `entryEnsures` + `applyDevConfig` helpers live in `hosts/common/install/` — which is **host glue, not published as a package export**. The Pi extension cannot `import { entryEnsures } from "agents-comm-bus/..."` cleanly today. This is a real seam.

**Do NOT try to fix this in Phase 3.** Instead, in `plugins/pi/agents-comm/README.md` and as a TODO comment at the top of `daemon-client.ts`, document the two options the README already flags:
1. Vendor a thin copy in the Pi package that calls `applyDevConfig` + `ensureDaemon` directly (the `ensureDaemon` export IS published via `agents-comm-bus/bootstrap/ensure-daemon`).
2. Publish `entryEnsures` as a new `agents-comm-bus` export (cleaner, but a separate daemon-package change).

Mark this as a **Phase 4 prerequisite decision** in the README. Phase 4's `daemon-client.ts` implementation will resolve it.

## Out of scope (do NOT do these — later phases)

- Implementing any module body (Phase 4).
- The inbound polling loop, `pi.sendUserMessage` injection, session lifecycle handlers (Phase 4).
- Tool schemas beyond doc comments (Phase 5).
- Skill content beyond frontmatter + TODO (Phase 6).
- The release-pipeline / staging-path work (§3.1b "Resolve packaging-shape gap" — that's a separate open decision, not Phase 3 code). Just leave the §3.1b items unchecked in the CHECKLIST.
- Any change to `core-daemon/` (Phase 1 territory — done).
- Any change to `hosts/` (the Pi extension is the host adapter; it doesn't live under `hosts/`).

## Verify (after implementation)

```powershell
# From the worktree root
cd "D:/tmp/acb-age59-p3"

# 1. The agents-comm-bus package still builds (exports map change is valid)
cd agents-comm-bus
npm install
npm run build
cd ..

# 2. The Pi package's stub modules at least parse / load
#    (jiti transpiles on load; a stub that throws at call-time but not import-time is the goal)
#    Use node --check or a trivial import:
node --input-type=module -e "import('./plugins/pi/agents-comm/extensions/agents-comm/session-id.ts').then(m => console.log('session-id exports:', Object.keys(m))).catch(e => { console.error('IMPORT FAILED:', e.message); process.exit(1); })" 2>&1 | tail -5 || true
#    (If jiti isn't on PATH for this check, skip it — the real load test happens in Phase 4 smoke. At minimum `node --check` each .ts via tsc --noEmit if practical.)

# 3. The exports map change didn't break the agents-comm-bus package's own tests
npm test 2>&1 | tail -8

# 4. verify:clean-build (the exports map change regenerates package.json in dist? verify artifacts still in sync)
npm run verify:clean-build 2>&1 | tail -8
```

If the `node --check`/import smoke is awkward in the worktree environment, at minimum eyeball each stub `.ts` for syntax and confirm `index.ts` has no top-level throw.

## Commit discipline

- Commit messages prefixed `AGE-59 ...`.
- One commit for the skeleton + exports map change, or split (skeleton / exports-map) — your call.
- No version bump needed in Phase 3 unless `verify:clean-build` says otherwise (the exports map change to `agents-comm-bus/package.json` is a source change; `DAEMON_VERSION` only governs the daemon artifact, and no daemon code changed here. If `check:version-bump` complains, bump per its guidance.)

## Definition of done (Phase 3)

- [ ] `plugins/pi/agents-comm/` exists with `package.json`, `README.md`, `extensions/agents-comm/*.ts` stubs, `skills/<comm>/SKILL.md` stubs.
- [ ] `package.json` has `pi` manifest, `pi-package` keyword, `agents-comm-bus` in `dependencies`, the four Pi-runtime packages in `peerDependencies` at `*`.
- [ ] Every stub module loads at import time (no top-level throw); bodies throw `TODO(phase4)` at call time.
- [ ] `session-id.ts` may be fully implemented (one-liner) — the rest are stubs.
- [ ] `agents-comm-bus/package.json` exports `./ipc/persistent-client` (additive).
- [ ] `agents-comm-bus` still builds + `npm test` still green + `verify:clean-build` passes.
- [ ] `entryEnsures` seam documented in package README + `daemon-client.ts` top comment as a Phase 4 prerequisite decision.
- [ ] Tick the §3.1 + §3.2 boxes in `docs/research/pi/CHECKLIST.md` (leave §3.1b release-sync unchecked — that's a separate open item).

## After Phase 3

Report back with: the file tree created, the `package.json` contents, confirmation that the exports map change builds + tests green, and any decisions you had to make (e.g. the package `name` scope). Phase 4 (implementing the stubs) will be a separate delegation.
