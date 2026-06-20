# AGE-59 Restructure — split combined package into core + per-comm

**Issue:** AGE-59 (The Pi Host)
**Branch:** `satriodewantono/age-59-restructure-per-comm`
**Worktree:** `D:\tmp\acb-age59-restructure`
**Base:** `main` (currently at `2c49ea0`)
**Scope:** Restructure ONLY — split the current combined `plugins/pi/agents-comm/` package into `plugins/pi/core/` (bundled, comm-agnostic) + `plugins/pi/telegram/` (user-installable, per-comm). Establish the per-comm-package-bundling-core shape from [README § Distribution (Option B — per-comm packages bundling a shared core)](README.md). Do NOT implement skills content (Phase 6), commands (Phase 7), or the prod-multi-comm entryEnsures split (follow-up issue — see below).

## CRITICAL constraint: the core MUST keep calling `entryEnsures` (for now)

Verified against the code: `entryEnsures` (via `agents-comm-bus/host-entry`) is the **only public path** to dev-marker resolution. `applyDevConfig` is NOT exported separately, and `ensureDaemon` alone (public via `agents-comm-bus/bootstrap/ensure-daemon`) does NOT walk for the `.agents-comm-bus-dev.json` marker — it only reads env vars. So if the core stopped calling `entryEnsures`, dev mode would break (the live-tested Telegram round-trip would stop resolving the dev daemon).

**Therefore: the core KEEPS its `entryEnsures` loop exactly as it is today** (Phase 4 code, `SUPPORTED_COMMS = ["telegram"]`). The per-comm `extensions/telegram/index.ts` ALSO calls `entryEnsures` for its own comm (idempotent in dev — `entryEnsures` is safe to call twice; both resolve the same dev daemon). This is correct for **dev + single-comm prod**. The **prod multi-comm** case (core hardcodes "telegram" but the user installed `pi-discord`) is a known limitation tracked by a **follow-up Linear issue** (filed separately): the clean fix is either (a) a comm-less `entryEnsures` mode for the core's daemon-resolution-only need, or (b) core-side comm discovery. Neither is in restructure scope.

**Do NOT attempt the entryEnsures-flow refactor in this restructure.** Leave the core's `daemon-client.ts` entryEnsures loop unchanged. Add a `TODO(age-XX)` comment pointing at the follow-up.

## READ THESE FIRST

1. **`docs/research/pi/README.md`** § "Distribution (Option B — per-comm packages bundling a shared core)" — the target shape, the "Why per-comm + bundled-core" rationale, the "Handling duplicate core loads" idempotent-guard requirement, the "Per-comm entryEnsures" note, and "What pi-core is NOT". This is the spec for the restructure.
2. **`docs/research/pi/CHECKLIST.md`** Phase 3.1b (release sync, now resolved per-comm) for context.
3. **The current `plugins/pi/agents-comm/` tree** — your starting point (listed below).
4. **Pi packages doc § Dependencies** (`https://pi.dev/docs/latest/packages#dependencies`) — the `bundledDependencies` + `node_modules/` paths pattern. (You can't fetch the URL headlessly; the README § Distribution quotes the relevant rule: "Other pi packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths.")

## Current state (starting point)

```
plugins/pi/agents-comm/
├── README.md
├── package.json                 ← name: @agents-comm-bus/pi-agents-comm; pi: {extensions: ["./extensions"], skills: ["./skills"]}; keywords: [pi-package]
├── extensions/agents-comm/      ← the comm-generic tools + lifecycle + poller (Phase 4/5 code)
│   ├── index.ts
│   ├── daemon-client.ts
│   ├── session-id.ts
│   ├── inbound-format.ts.ts
│   ├── tools.ts
│   └── commands.ts              ← Phase 7 stub (throws TODO(phase7))
└── skills/
    ├── telegram/SKILL.md         ← Phase 6 stub
    ├── discord/SKILL.md          ← Phase 6 stub
    ├── matrix/SKILL.md           ← Phase 6 stub
    └── curl/SKILL.md             ← Phase 6 stub
```

## Target state

```
plugins/pi/
├── core/                         ← @agents-comm-bus/pi-core (bundled, NEVER user-installed standalone)
│   ├── extensions/agents-comm/    ← MOVED from agents-comm/extensions/agents-comm/ (comm-generic tools + lifecycle + poller)
│   │   ├── index.ts               ← add idempotent lifecycle guard (see below)
│   │   ├── daemon-client.ts       ← UNCHANGED entryEnsures loop + TODO(age-XX) comment; add idempotent guard note
│   │   ├── session-id.ts          ← unchanged
│   │   ├── inbound-format.ts      ← unchanged
│   │   ├── tools.ts               ← add idempotent registration guard at top of registerCommTools
│   │   └── commands.ts            ← unchanged (Phase 7 stub)
│   ├── README.md                  ← NEW: short — "bundled core, not user-installed; see plugins/pi/telegram/ for the installable package"
│   └── package.json               ← name: @agents-comm-bus/pi-core; version: 0.1.0; NO pi-package keyword; NO pi manifest; dependencies: agents-comm-bus@0.2.30; peerDependencies: pi-runtime + typebox (same as before); private: false (it's a published dep, but not a pi-package)
└── telegram/                      ← @agents-comm-bus/pi-telegram (user installs this)
    ├── extensions/telegram/
    │   └── index.ts               ← NEW thin entrypoint: calls entryEnsures({agent:"pi", comm:"telegram", fromDir, readOnlyCentralInstall:true}) for its own comm; logs; no tool registration
    ├── skills/telegram/SKILL.md   ← MOVED from agents-comm/skills/telegram/SKILL.md (still Phase 6 stub)
    ├── README.md                  ← MOVED + updated from agents-comm/README.md (install instructions: pi install npm:@agents-comm-bus/pi-telegram)
    └── package.json               ← name: @agents-comm-bus/pi-telegram; version: 0.1.0; keywords: [pi-package]; pi: {extensions: ["node_modules/@agents-comm-bus/pi-core/extensions", "./extensions/telegram"], skills: ["./skills"]}; dependencies: {agents-comm-bus: 0.2.30, @agents-comm-bus/pi-core: 0.1.0, node-telegram-bot-api: ...}; bundledDependencies: ["@agents-comm-bus/pi-core"]; peerDependencies: pi-runtime + typebox
```

**Note: no `install-stamp.json` or `telegram.adapter.bundle.js` in `plugins/pi/telegram/` yet.** Those are release artifacts generated by `scripts/stage-plugins.js` (the existing per-`(agent, comm)` staging). The restructure is source-only; the release-pipeline work (Phase 3.1b) generates the stamp + bundle. The telegram package's `extensions/telegram/index.ts` `entryEnsures` call will fail in prod until the stamp exists — that's expected (prod isn't exercised until release work). In dev, `entryEnsures` skips central-install (dev marker sets `AGENTS_COMM_BUS_BIN`), so it works without a stamp. **Add a comment in `extensions/telegram/index.ts` noting the stamp/bundle are release artifacts.**

**Delete the discord/matrix/curl skill stubs** (they're `TODO(phase6)` placeholders with no per-comm package home yet). Phase 6 recreates them inside `plugins/pi/<comm>/skills/<comm>/` when those comms come online. Keeping them around with no package is dead weight.

## Deliverables

### 1. Move `plugins/pi/agents-comm/` → `plugins/pi/core/` (git mv to preserve history)

```bash
git mv plugins/pi/agents-comm plugins/pi/core
```

Then within `plugins/pi/core/`:
- **`package.json`** — rewrite:
  - `name`: `@agents-comm-bus/pi-core`
  - REMOVE `keywords: ["pi-package"]` (the core is NOT a user-installable pi-package; it's a bundled dep)
  - REMOVE the `pi` manifest entirely (the core has no pi-extension entries of its own — it's consumed via `node_modules/` by per-comm packages)
  - KEEP `dependencies: { agents-comm-bus: "0.2.30" }`, `peerDependencies` (pi-runtime + typebox), `engines`, `license`, `type: module`
  - Add `"private": false` (it IS published to npm as a dep, just not a pi-package)
- **`README.md`** — replace with a short note: "Bundled core for agents-comm-bus Pi per-comm packages. Not user-installed standalone — install `@agents-comm-bus/pi-telegram` (or other `pi-<comm>`) instead, which bundles this core. Source of truth: `docs/research/pi/README.md`."
- **`extensions/agents-comm/daemon-client.ts`** — add a `TODO(age-XX)` comment at the `entryEnsures` loop noting: "Follow-up: core should stop calling entryEnsures; per-comm extensions own it. Requires comm-less entryEnsures mode (core daemon-resolution only) OR core-side comm discovery. Multi-comm prod correctness depends on this. See docs/research/pi/README.md § Distribution." Do NOT change the logic.
- **`extensions/agents-comm/tools.ts`** — add the **idempotent registration guard** at the top of `registerCommTools`:
  ```ts
  // Idempotent guard: if multiple per-comm packages bundle this core, Pi loads
  // the core extension once per package's module root. The comm-generic tools
  // must register exactly once (Pi keeps the first by name; duplicates shadow).
  if (pi.getAllTools().some((t) => t.name === "comm_send_message")) {
    return; // already registered by another bundled-core instance
  }
  ```
- **`extensions/agents-comm/index.ts`** — add an **idempotent lifecycle guard** so duplicate core loads don't wire `session_start`/`session_shutdown` twice (module-level flag):
  ```ts
  let lifecycleWired = false;
  // ... inside the default export, before pi.on("session_start", ...):
  if (!lifecycleWired) {
    lifecycleWired = true;
    pi.on("session_start", ...);
    pi.on("session_shutdown", ...);
  }
  ```
  (The tools/commands registration is already guarded by the tools.ts check; the lifecycle handlers need their own guard.)

### 2. Create `plugins/pi/telegram/` (NEW)

- **`extensions/telegram/index.ts`** — thin per-comm entrypoint:
  ```ts
  /**
   * Per-comm Pi extension for telegram. Calls `entryEnsures` for its own comm
   * (central-installs the telegram adapter in prod; idempotent no-op in dev).
   * The comm-generic tools + lifecycle live in the bundled @agents-comm-bus/pi-core
   * extension (loaded via this package's pi.extensions manifest). This extension
   * registers NO tools (Pi's flat tool namespace forbids per-comm tool registration).
   *
   * TODO(age-XX): once the core stops calling entryEnsures (comm-less mode follow-up),
   * this per-comm entryEnsures becomes the sole central-install path.
   *
   * NOTE: install-stamp.json + telegram.adapter.bundle.js are release artifacts
   * (generated by scripts/stage-plugins.js). In dev, entryEnsures skips
   * central-install (AGENTS_COMM_BUS_BIN set via .agents-comm-bus-dev.json), so
   * this works without a stamp.
   */
  import { entryEnsures } from "agents-comm-bus/host-entry";

  export default async function telegramCommExtension(): Promise<void> {
    try {
      await entryEnsures({
        agent: "pi",
        comm: "telegram",
        fromDir: import.meta.dirname,
        readOnlyCentralInstall: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[pi-telegram] entryEnsures failed: ${message}`);
    }
  }
  ```
- **`skills/telegram/SKILL.md`** — `git mv` from `plugins/pi/core/skills/telegram/SKILL.md` (move it out of core into the telegram package). Still a Phase 6 stub.
- **`README.md`** — adapt the moved README: install instruction becomes `pi install npm:@agents-comm-bus/pi-telegram` (or git); note it bundles `@agents-comm-bus/pi-core`; prereq remains `agents-comm account-add --agent pi --comm telegram ...`.
- **`package.json`**:
  ```json
  {
    "name": "@agents-comm-bus/pi-telegram",
    "version": "0.1.0",
    "description": "Pi host extension for agents-comm-bus — Telegram comm (bundles the shared pi-core).",
    "type": "module",
    "keywords": ["pi-package"],
    "pi": {
      "extensions": [
        "node_modules/@agents-comm-bus/pi-core/extensions",
        "./extensions/telegram"
      ],
      "skills": ["./skills"]
    },
    "dependencies": {
      "agents-comm-bus": "0.2.30",
      "@agents-comm-bus/pi-core": "0.1.0",
      "node-telegram-bot-api": "^0.66.0"
    },
    "bundledDependencies": ["@agents-comm-bus/pi-core"],
    "peerDependencies": {
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-tui": "*",
      "typebox": "*"
    },
    "engines": { "node": ">=22" },
    "license": "MIT"
  }
  ```
  Note: `node-telegram-bot-api` is listed because the telegram adapter bundle depends on it at runtime (the staged adapter bundle inlines it, but listing it documents the comm's runtime dep). If the bundle inlines everything, this can be removed later — leave it for now as documentation.

### 3. Delete the discord/matrix/curl skill stubs from core

```bash
git rm plugins/pi/core/skills/discord/SKILL.md
git rm plugins/pi/core/skills/matrix/SKILL.md
git rm plugins/pi/core/skills/curl/SKILL.md
# also remove the now-empty skills/ dir from core (core has no skills)
rmdir plugins/pi/core/skills  # or git rm -r if git tracks the dir
```
Phase 6 recreates these inside `plugins/pi/<comm>/skills/<comm>/` when discord/matrix/curl per-comm packages are built.

### 4. Root `package.json` workspaces — ADD BOTH core + telegram

The monorepo's root `package.json` `workspaces` array currently does NOT include `plugins/pi/*` (Phase 4 correctly avoided this). For the per-comm shape, the dev workspace needs to link `plugins/pi/core` so `plugins/pi/telegram`'s `import`/`node_modules` resolution finds the core. Add both:

```json
"workspaces": [
  "agents-comm-bus",
  "packages/*",
  "hosts",
  "mcp-server",
  "plugins/pi/core",
  "plugins/pi/telegram"
]
```

**This is NOT the Phase 4 scope-creep.** Phase 4's workspace churn was unnecessary because the single combined package resolved `agents-comm-bus` via the existing hoist. Here, `plugins/pi/telegram` genuinely needs `@agents-comm-bus/pi-core` resolvable, and the workspace link is the mechanism. This is a deliberate, scoped addition for the per-comm shape. (Verify after: `npm install` links core; `plugins/pi/telegram` can resolve `node_modules/@agents-comm-bus/pi-core`.)

**Expect `package-lock.json` churn** from this workspace addition — that's expected and acceptable for this restructure (unlike Phase 4, where it was unnecessary). Commit it.

### 5. Update `docs/research/pi/CHECKLIST.md`

Tick a new restructure item (add under Phase 3 or a new "Restructure" subsection — your call, keep it minimal):
- [x] Restructure: split `plugins/pi/agents-comm/` → `plugins/pi/core/` + `plugins/pi/telegram/` (per-comm packages bundling a shared core; per README § Distribution).

## Out of scope (do NOT do)

- Implement skill content (Phase 6) — `skills/telegram/SKILL.md` stays a stub.
- Implement commands (Phase 7) — `commands.ts` stays a stub.
- Create discord/matrix/curl per-comm packages — only telegram (the live-tested comm). Others come when those comms are wired.
- The entryEnsures-flow refactor (comm-less core mode) — follow-up Linear issue, NOT this restructure. Leave core's entryEnsures loop unchanged.
- Generate `install-stamp.json` or `telegram.adapter.bundle.js` — release artifacts (Phase 3.1b / `scripts/stage-plugins.js`).
- Any change to `core-daemon/` (daemon side done).
- Any change to `agents-comm-bus/package.json` exports map (already has `host-entry` + `bootstrap/ensure-daemon`).

## Verify (after implementation)

From the worktree root (`D:/tmp/acb-age59-restructure`):

```powershell
# Workspace prep (fresh worktree)
cd packages/core-contracts && npm install && npm run build && cd ../..
cd agents-comm-bus && npm install && npm run build && cd ..
cd hosts && npm install && cd ..

# 1. The new workspace links resolve: core is installable + telegram finds it
npm install 2>&1 | tail -3
ls plugins/pi/telegram/node_modules/@agents-comm-bus/pi-core/extensions/agents-comm/ 2>&1 | head -3
#    (should show index.ts etc. — the workspace symlink to plugins/pi/core)

# 2. Both extension entrypoints parse
npx tsx -e "import('./plugins/pi/core/extensions/agents-comm/tools.ts').then(m=>console.log('core tools ok:',Object.keys(m))).catch(e=>{console.error('FAIL:',e.message);process.exit(1)})"
npx tsx -e "import('./plugins/pi/telegram/extensions/telegram/index.ts').then(()=>console.log('telegram ext parses')).catch(e=>{console.error('FAIL:',e.message);process.exit(1)})"

# 3. Daemon package still builds + full test suite green (no daemon regressions)
npm test 2>&1 | tail -8
npm run verify:clean-build 2>&1 | tail -5
npm run check:version-bump 2>&1 | tail -3
```

**Key success criterion:** the workspace links core into telegram's `node_modules`, both entrypoints parse, the daemon package's tests/verify-gates stay green, and the live Telegram round-trip will still work after `/reload` (dev mode: core's entryEnsures still resolves the dev daemon; the per-comm telegram entryEnsures is idempotent).

## Commit discipline

- Commit messages prefixed `AGE-59 ...`.
- One commit for the restructure (moves + new files + package.json + workspace + CHECKLIST), or split (core split / telegram package / workspace) — your call.
- **No `DAEMON_VERSION` bump** (no daemon code changed). **Do NOT edit `agents-comm-bus/package.json`** (exports map unchanged). The root `package.json` workspace addition IS expected.
- **Commit your own work. Do not ask whether to commit.** Run Verify, then `git add -A && git commit`.

## Definition of done (Restructure)

- [ ] `plugins/pi/agents-comm/` no longer exists; its contents moved to `plugins/pi/core/` (git mv preserved history).
- [ ] `plugins/pi/core/package.json` has NO `pi-package` keyword, NO `pi` manifest, name `@agents-comm-bus/pi-core`.
- [ ] `plugins/pi/core/extensions/agents-comm/tools.ts` has the idempotent registration guard.
- [ ] `plugins/pi/core/extensions/agents-comm/index.ts` has the idempotent lifecycle guard.
- [ ] `plugins/pi/core/extensions/agents-comm/daemon-client.ts` has the `TODO(age-XX)` comment on the entryEnsures loop (logic unchanged).
- [ ] `plugins/pi/telegram/` exists with `extensions/telegram/index.ts` (thin entryEnsures entrypoint), `skills/telegram/SKILL.md` (moved), `README.md` (adapted), `package.json` (pi-package, bundles core via `bundledDependencies` + `node_modules/` paths).
- [ ] discord/matrix/curl skill stubs deleted from core.
- [ ] Root `package.json` workspaces includes `plugins/pi/core` + `plugins/pi/telegram`; `npm install` links core into telegram's node_modules.
- [ ] `npm test` green (678 pass baseline); `verify:clean-build` passes; `check:version-bump` passes.
- [ ] CHECKLIST restructure item ticked.
- [ ] **No changes to `agents-comm-bus/package.json` or `core-daemon/`.**

## After restructure

Report back with: the final tree, confirmation that workspace linking works (telegram sees core in node_modules), gates green, and the commit SHAs. After merge, Satrio `/reload`s Pi (loading `plugins/pi/telegram` instead of the old `plugins/pi/agents-comm`) to confirm the live Telegram round-trip still works in the new shape. Then Phase 6 (skills) targets `plugins/pi/telegram/skills/telegram/SKILL.md`.

Also: file the follow-up Linear issue for the entryEnsures comm-less core mode (prod multi-comm correctness) — I (the delegating agent) will do this, not Cursor.
