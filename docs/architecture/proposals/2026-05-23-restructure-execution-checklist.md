# Restructure execution checklist

**Status:** execution checklist for the settled restructure
**Date:** 2026-05-23
**Depends on:**
- `2026-05-23-restructure-paths.md`
- `2026-05-23-core-package-fold-decision.md`

> **Goal:** execute the settled restructure in a sequence that keeps the repo buildable and architecture tests green at every major checkpoint.

## Settled target shape

- daemon runtime: `core-daemon/`
- daemon-side bridges: `core-daemon/bridges/<agent>/`
- shared contracts package: `packages/core-contracts/`
- comm adapters: `adapters/<comm>/`
- host edge: `hosts/<agent>/`
- shared host plumbing: `hosts/common/`
- built artifacts: `plugins/<agent>/<comm>/`

## Ground rules

1. **One structural slice per commit.** Do not mix package moves, daemon renames, shim extraction, and hook relocation in one giant diff.
2. **Keep the tree green between slices.** Every numbered phase below ends with explicit verification commands.
3. **Preserve the package boundary.** Decision #2 is settled: keep the old `agents-comm-bus-core` semantics as a distinct package under `packages/core-contracts/`.
4. **Do not do speculative API cleanup in the move PRs.** Path moves first, behavior changes only where required to keep imports/builds working.
5. **Use full bridge paths in all commits/reviews.** Example: `core-daemon/bridges/claude/bridge.ts`, never bare `bridge.ts`.

## Known scripts / verification entrypoints

### Package-local build commands
- Shared package: `cd packages/core-contracts && npm run build`
- Daemon package: `cd agents-comm-bus && npm run build`
- MCP shim package: `cd mcp-server && npm run build`

### Package-local test commands currently defined
- Shared package tests: `cd packages/core-contracts && npm test`
  - Covers: `query-resolution`, `query-staleness`, `security-loop-prevention`, `session-lease` (core-contracts imports only).
  - Does **not** cover daemon runtime, bridge, or adapter tests.
- Daemon package tests: `cd agents-comm-bus && npm test`
  - Covers: `bootstrap-race`, `ipc-versioning`, `sqlite-schema`, `allowlist-factory`, `reload-allowlist-refresh`, `drain-pending-inbound`.

### Root-level architecture test commands (run from repo root)
- Full suite: `npm test`
- Core / boundary / storage: `npm run test:core`
- Bootstrap / IPC / CLI: `npm run test:bootstrap`
- Daemon lifecycle: `npm run test:daemon`
- Adapter / allowlist / drain: `npm run test:adapter`
- Bridge / host / shim: `npm run test:bridge`
- Hooks: `npm run test:hooks`

### High-signal architecture tests worth running during migration
Use the root-level `npm run test:<group>` commands above when a phase matches a script grouping. Use the package-local test commands when validating a package's ownership boundary. For ad-hoc combinations not covered by a script, use `node --test --import tsx ...` directly from repo root.

- core package / boundary / storage semantics (covered by `packages/core-contracts && npm test`):
  - `tests/architecture/query-resolution.test.ts`
  - `tests/architecture/query-staleness.test.ts`
  - `tests/architecture/security-loop-prevention.test.ts`
  - `tests/architecture/session-lease.test.ts`
- daemon runtime / storage impl (covered by `agents-comm-bus && npm test`):
  - `tests/architecture/bus-invariants.test.ts`
  - `tests/architecture/sqlite-schema.test.ts`
  - `tests/architecture/bootstrap-race.test.ts`
  - `tests/architecture/ipc-versioning.test.ts`
  - `tests/architecture/account-registration-cli.test.ts`
  - `tests/architecture/daemon-build-assets.test.ts`
- adapter / allowlist / drain behavior:
  - `tests/architecture/allowlist-factory.test.ts`
  - `tests/architecture/reload-allowlist-refresh.test.ts`
  - `tests/architecture/drain-pending-inbound.test.ts`
  - `tests/architecture/telegram-comm-adapter.test.ts`
- host / bridge / hook contracts (**not** in core-contracts `npm test`):
  - `tests/architecture/claude-hooks.test.ts`
  - `tests/architecture/codex-hooks.test.ts`
  - `tests/architecture/codex-app-server-lifecycle.test.ts`
  - `tests/architecture/codex-turn-control.test.ts`

---

## Phase 0 — preflight and freeze the baseline

**Objective:** capture a known-good baseline before moving paths.

### Checklist
- [ ] Confirm working tree is clean.
- [ ] Confirm branch tip includes the doc-settlement commits.
- [ ] Run current package builds:
  - [ ] `cd packages/core-contracts && npm run build`
  - [ ] `cd agents-comm-bus && npm run build`
  - [ ] `cd mcp-server && npm run build`
- [ ] Run current architecture tests:
  - [ ] `cd packages/core-contracts && npm test`
  - [ ] `cd agents-comm-bus && npm test`
  - [ ] `npm run test:daemon`
  - [ ] `npm run test:hooks`
- [ ] Save the exact failing/passing baseline in the PR body or execution notes.

### Commit
- No code move yet; this is a verification gate.

---

## Phase 1 — move `agents-comm-bus-core/` to `packages/core-contracts/`

**Objective:** preserve the shared-package boundary while relocating it to the settled final namespace.

### Scope
- `git mv agents-comm-bus-core packages/core-contracts`
- update package metadata, tsconfig references, and any root-level scripts/docs that point at the old directory
- keep the package name/export surface stable unless there is a deliberate package-name change in the same slice

### Required edits
- [ ] move directory: `agents-comm-bus-core/` -> `packages/core-contracts/`
- [ ] fix any relative references inside the moved package
- [ ] update any repo scripts, docs, or test invocations that `cd agents-comm-bus-core`
- [ ] update imports that use relative disk paths like `../agents-comm-bus-core/dist/...`
- [ ] update tests that import `../../agents-comm-bus-core/src/...`

### Guardrails
- Do **not** rename `agents-comm-bus/` yet.
- Do **not** extract shims or hooks yet.
- Minimize churn: this phase is a package move, not a behavior rewrite.

### Verify before commit
- [ ] `cd packages/core-contracts && npm run build`
- [ ] `cd packages/core-contracts && npm test`
- [ ] `cd agents-comm-bus && npm run build`
- [ ] `cd agents-comm-bus && npm test`
- [ ] `npm run test:core`

### Commit shape
- Suggested commit message: `Move agents-comm-bus-core to packages/core-contracts`

---

## Phase 2 — rename daemon source tree to `core-daemon/`

**Objective:** move the current daemon package source out of `core-daemon/**` into the settled `core-daemon/**` tree without changing behavior.

### Scope
- move daemon source files to `core-daemon/**`
- update daemon package build config / exports so `agents-comm-bus` still builds from the new source location
- rewrite internal imports and external callers that point into `agents-comm-bus/dist/...`

### Recommended order inside the phase
1. Move leaf subtrees first:
   - [ ] `src/runtime/**` -> `core-daemon/runtime/**`
   - [ ] `src/ipc/**` -> `core-daemon/ipc/**`
   - [ ] `src/bootstrap/**` -> `core-daemon/bootstrap/**`
   - [ ] `src/storage/**` -> `core-daemon/storage/**`
   - [ ] `src/migrations/**` -> `core-daemon/migrations/**`
   - [ ] `src/cli/**` -> `core-daemon/cli/**`
2. Move top-level daemon entry files:
   - [ ] `src/daemon.ts` -> `core-daemon/daemon.ts`
   - [ ] `src/bus.ts` -> `core-daemon/bus.ts`
   - [ ] `src/serve.ts` -> `core-daemon/serve.ts`
   - [ ] `src/config.ts` -> `core-daemon/config.ts`
   - [ ] `src/paths.ts` -> `core-daemon/paths.ts`
   - [ ] `src/types/vendor.d.ts` -> `core-daemon/types/vendor.d.ts`
3. Update package wiring:
   - [ ] daemon `tsconfig.json`
   - [ ] daemon `package.json` `main` / `types` / `exports` paths if needed
   - [ ] build asset copy script paths
4. Update external callers:
   - [ ] hooks
   - [ ] mcp shim code
   - [ ] tests
   - [ ] any install/runtime scripts importing daemon dist entrypoints

### Guardrails
- Keep `agents-comm-bus` as the package boundary for now; only the source tree name changes.
- Do not split `mcp-server/server.js` in this phase.
- Do not move comm adapters out to top-level `adapters/` yet unless required to complete import rewrites; if you must, do it as Phase 3, not ad hoc here.

### Verify before commit
- [ ] `cd agents-comm-bus && npm run build`
- [ ] `cd agents-comm-bus && npm test`
- [ ] `npm run test:bootstrap`
- [ ] `npm run test:daemon`

### Commit shape
- Suggested commit message: `Rename daemon source tree to core-daemon`

---

## Phase 3 — move comm adapters to top-level `adapters/<comm>/`

**Objective:** separate comm-provider integrations from daemon-runtime source.

### Scope
- move `core-daemon/adapters/comm/telegram/**` -> `adapters/telegram/**`
- preserve import behavior from daemon composition root
- keep adapter semantics unchanged

### Required edits
- [ ] move Telegram adapter files to `adapters/telegram/**`
- [ ] update `core-daemon/serve.ts` imports to `../adapters/telegram/...`
- [ ] update any direct imports in tests or helper scripts
- [ ] confirm allowlist/reload behavior still points at the same adapter implementation

### Optional same-phase additions
- [ ] if a second comm adapter scaffold already exists, normalize it into `adapters/<comm>/` too
- [ ] otherwise keep this phase Telegram-only and let future comms follow the settled pattern later

### Verify before commit
- [ ] `cd agents-comm-bus && npm run build`
- [ ] `cd agents-comm-bus && npm test`
- [ ] `npm run test:adapter`

### Commit shape
- Suggested commit message: `Move Telegram comm adapter to top-level adapters`

---

## Phase 4 — move daemon-side agent bridges to `core-daemon/bridges/<agent>/`

**Objective:** complete the settled bridge-location move while preserving the daemon/runtime boundary.

### Scope
- move Claude daemon-side bridge module files into `core-daemon/bridges/claude/**`
- move Codex daemon-side bridge module files into `core-daemon/bridges/codex/**`
- update composition-root imports and architecture tests

### Required edits
- [ ] `src/adapters/agent/claude/bridge.ts` -> `core-daemon/bridges/claude/bridge.ts`
- [ ] `src/adapters/agent/claude/adapter.ts` -> `core-daemon/bridges/claude/adapter.ts`
- [ ] `src/adapters/agent/claude/wake.ts` -> `core-daemon/bridges/claude/wake.ts`
- [ ] `src/adapters/agent/codex/bridge.ts` -> `core-daemon/bridges/codex/bridge.ts`
- [ ] `src/adapters/agent/codex/adapter.ts` -> `core-daemon/bridges/codex/adapter.ts`
- [ ] `src/adapters/agent/codex/app-server.ts` -> `core-daemon/bridges/codex/app-server.ts`
- [ ] `src/adapters/agent/codex/app-server-lifecycle.ts` -> `core-daemon/bridges/codex/app-server-lifecycle.ts`
- [ ] update `core-daemon/serve.ts` imports
- [ ] update any tests that assert or snapshot bridge file paths

### Guardrails
- This phase is still a path move, not the host-edge shim split.
- Do not pull MCP shim logic into bridge code as part of the move.

### Verify before commit
- [ ] `cd agents-comm-bus && npm run build`
- [ ] `npm run test:bridge`
- [ ] rerun daemon package test command: `cd agents-comm-bus && npm test`

### Commit shape
- Suggested commit message: `Move daemon-side bridges under core-daemon/bridges`

---

## Phase 5 — split `mcp-server/server.js` into host entrypoints + shared shim plumbing

**Objective:** convert the still-shared shim file into the settled host-edge structure:
- `hosts/common/mcp-shim-shared.js`
- `hosts/claude/claude-mcp-shim.js`
- `hosts/codex/codex-mcp-shim.js`

### Scope
This is the first phase that is a **true refactor**, not only a move.

### Recommended sequence
1. **Extract shared shim plumbing first**
   - [ ] move transport-agnostic request/response helpers into `hosts/common/mcp-shim-shared.js`
   - [ ] keep behavior byte-for-byte if possible
2. **Create Claude host entrypoint**
   - [ ] `hosts/claude/claude-mcp-shim.js`
   - [ ] wire Claude-specific metadata/env inference only here
3. **Create Codex host entrypoint**
   - [ ] `hosts/codex/codex-mcp-shim.js`
   - [ ] wire Codex-specific metadata/env inference only here
4. **Retire old shared entrypoint**
   - [ ] leave temporary wrapper only if needed for one transition commit
   - [ ] otherwise delete `mcp-server/server.js`
5. **Update packaging/build/install references**
   - [ ] `mcp-server/package.json` or successor build scripts
   - [ ] install/help text
   - [ ] plugin artifact wiring

### Guardrails
- MCP tool surface must remain generic (`comm_*`), not regress to Telegram-specific naming.
- Nested-only `target: { ... }` policy at the shim boundary must remain intact.
- Daemon IPC names may remain transport-specific internally; do not blur MCP-tool names with daemon method names.

### Verify before commit
- [ ] build the shim package or successor build target
- [ ] `npm run test:hooks`
- [ ] if there are shim-specific smoke scripts, run one Claude-path and one Codex-path smoke check against the daemon

### Commit shape
- Suggested commit message: `Split shared MCP shim into host entrypoints`

---

## Phase 6 — move hooks into `hosts/<agent>/hooks/`

**Objective:** finish relocating host-installed lifecycle glue under the host edge.

### Scope
- Claude hooks -> `hosts/claude/hooks/**`
- Codex hooks -> `hosts/codex/hooks/**`
- delete thin root-level compatibility wrappers during the hard cut

### Required edits
- [ ] move Claude hooks
- [ ] move Codex hooks
- [ ] update plugin manifests / installer wiring to new paths
- [ ] delete root-level thin wrappers such as `hosts/claude/hooks/user-prompt-submit.js` if no compatibility contract still requires them
- [ ] resolve `hosts/claude/hooks/session-start.js` explicitly as either a real host file path or deletion, per the settled path manifest

### Guardrails
- Do not leave ambiguous duplicate live hook paths if the plugin manifests already point at the new locations.
- Prefer deletion over carrying forward root compatibility wrappers.

### Verify before commit
- [ ] `npm run test:hooks`
- [ ] smoke-check any install/status command that prints hook paths

### Commit shape
- Suggested commit message: `Move host hooks under hosts/<agent>/hooks`

---

## Phase 7 — separate skill content from plugin-artifact mechanism

**Objective:** complete the source-vs-artifact split for host install
surfaces, but cut the work along the real delegation boundary:
**content** vs **mechanism**. Skill prose/content is editorial and should stay
reviewable by humans/interactive agents. Assembly, staging, manifests, hooks,
shims, and artifact-tree tests are mechanical and should remain Kanban-
delegable. `hosts/<agent>/...` remains source-side host edge code and
`plugins/<agent>/<comm>/...` becomes the generated/staged plugin artifact tree
consumed by marketplace git-subdir entries.

### Current repo state to account for
- `hosts/claude/` and `hosts/codex/` contain MCP shims and lifecycle hooks.
- Root `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and
  `.mcp.json.template` still exist as source/dev inputs.
- There is no `plugins/` artifact tree yet.
- `skills/telegram/SKILL.md` exists, but it is migration input only. It mixes
  current daemon-backed `comm_*` tool guidance with stale pre-daemon /
  single-agent assumptions such as `.claude-telegram/queue.json`, project-local
  `.mcp.json` credential setup, and Claude-only restart/log wording.

### Scope
- Define source-side skill inputs under `hosts/<agent>/skills/**` and shared
  fragments/templates under a clear source location such as
  `hosts/common/skills/**`.
- Separate the **real Telegram skill content rewrite** from the **mechanical
  skill assembly/staging pipeline** so the latter can proceed via Kanban.
- Add artifact assembly for `plugins/<agent>/<comm>/...`, starting with
  Telegram for Claude and Codex.
- Stage plugin manifests/templates into artifact paths, not source paths:
  - `plugins/claude/telegram/.claude-plugin/plugin.json`
  - `plugins/codex/telegram/.codex-plugin/plugin.json`
  - `plugins/codex/telegram/.mcp.json`
- Stage host runtime files into artifact paths so shipped manifests reference
  only files inside the plugin artifact tree.
- Stage skills using the real plugin skill package layout:
  - `plugins/claude/telegram/skills/telegram/SKILL.md`
  - `plugins/codex/telegram/skills/telegram/SKILL.md`

### Track 1 — skill content (editorial; not delegated)
- [ ] Produce the real per-`(agent, comm)` Telegram `SKILL.md` content and
  frontmatter as source input, reviewed as content rather than build plumbing.
- [ ] Rewrite the migrated Telegram skill text so it is daemon-current and does
  not preserve stale queue-file, project-local, or single-agent assumptions.
- [ ] Write comm-scoped and agent-aware skill descriptions so Telegram,
  Matrix, Discord, etc. can coexist without misleading implicit invocation.
- [ ] Treat this track as interchangeable source data for the mechanism track:
  once the real content lands in the agreed source location, the already-built
  assembly/staging pipeline should ship it with zero code changes.

### Track 2 — mechanism (Kanban-delegable)
- [ ] Update canonical docs that still describe flat skill files, including
  `docs/research/dist-tree-plan.md` and `docs/research/install-model.md`, from
  `skills/<comm>.md` to `skills/<skill-name>/SKILL.md`.
- [ ] Pin the `<skill-name>` directory contract for Telegram in this phase
  (currently `telegram`) so assembly output naming is settled before artifact
  staging.
- [ ] Create a source-side skill layout / mapping that makes it clear which
  shared fragments and agent-specific inputs produce the assembled Telegram
  skill output and its final `skills/<skill-name>/SKILL.md` packaging contract.
- [ ] Move or split `skills/telegram/SKILL.md` into source-side authoring
  inputs. Do not copy it verbatim into shipped artifacts.
- [ ] Add a fixture skill or source-side generated file for the assembled skill
  output so the mechanical pipeline can build/test against a stable contract
  without waiting on final prose.
- [ ] Make skill assembly frontmatter-aware. The assembled `SKILL.md` must
  have exactly one `name` and `description` block authored for that
  `(agent, comm)` artifact; do not concatenate multiple `SKILL.md` files
  verbatim.
- [ ] Create a source-to-artifact mapping for each generated artifact. The
  mapping should make it clear which source files/fragments produce each
  `plugins/<agent>/<comm>/...` output, including the assembled skill output.
- [ ] Update build/staging code to generate complete artifact directories under
  `plugins/<agent>/<comm>/...`. This phase is not complete if it only moves
  source files or only generates manifests.
- [ ] Keep dev/source install paths distinct from plugin artifact paths.
  Existing dev installers may point at repo source paths, but generated plugin
  manifests must be self-contained and must not reference `hosts/...`,
  repo-root `.mcp.json`, or other source-only files unless explicitly marked
  as dev-only.
- [ ] Update architecture tests that currently read root manifests or source
  hook paths so they validate the generated plugin artifacts as the installable
  contract.
- [ ] Add a focused artifact-tree test for `plugins/claude/telegram` asserting
  the tree contains the expected Claude manifest, MCP shim, hook files, and
  `skills/telegram/SKILL.md`.
- [ ] Add a focused artifact-tree test for `plugins/codex/telegram` asserting
  the tree contains the expected Codex manifest, `.mcp.json`, hook files, MCP
  shim, and `skills/telegram/SKILL.md`.
- [ ] Assert generated manifests reference artifact-local paths, not source
  paths such as `hosts/...` or root-level compatibility paths.
- [ ] Assert the staged skill files byte-match or otherwise exactly match the
  `(agent, comm)` assembled output produced by the agreed source input.
- [ ] Implement stale-string assertions mechanically, but do **not** make the
  worker's green path depend on unfinished prose: either run those checks
  against fixture-specific expectations or treat them as an integration gate
  when real content replaces the fixture.

### Verify before commit
- [ ] build all artifact-producing packages/scripts
- [ ] run the new artifact-tree tests
- [ ] run `tests/architecture/daemon-build-assets.test.ts`
- [ ] rerun `tests/architecture/claude-hooks.test.ts` and
  `tests/architecture/codex-hooks.test.ts`
- [ ] run `npm run test:hooks`
- [ ] run `npm test`
- [ ] run `git diff --check`

### Commit shape
- Suggested commit message: `Separate Phase 7 skill content from mechanism`

---

## Phase 8 — final cleanup and ratification sweep

**Objective:** remove stale compatibility paths and make the docs/tests match the executed tree exactly.

### Checklist
- [ ] search for stale old-path references:
  - [ ] `agents-comm-bus-core/`
  - [ ] `core-daemon/`
  - [ ] `src/adapters/comm/telegram/`
  - [ ] `src/adapters/agent/claude/`
  - [ ] `src/adapters/agent/codex/`
  - [ ] `mcp-server/server.js`
  - [ ] root `hosts/claude/hooks/user-prompt-submit.js`
- [ ] remove dead wrappers / dead build code
- [ ] update any remaining install/help docs not already covered by canonical docs
- [ ] rerun the full build/test matrix

### Final verification matrix
- [ ] `cd packages/core-contracts && npm run build && npm test`
- [ ] `cd agents-comm-bus && npm run build && npm test`
- [ ] `cd mcp-server && npm run build` or successor shim build command if that package has been absorbed/replaced
- [ ] `npm test`

### Commit shape
- Suggested commit message: `Clean up stale paths after restructure`

---

## Suggested PR strategy

### Preferred shape
Use **multiple PRs or a stacked PR sequence**, not one mega-PR.

Recommended stack:
1. `packages/core-contracts` move
2. `core-daemon` rename
3. top-level `adapters/telegram`
4. `core-daemon/bridges/*`
5. MCP shim split
6. hooks/skills/plugin-artifact cleanup
7. final dead-path cleanup

### Why this order
- early phases are mostly mechanical moves with bounded import churn
- the highest-risk behavioral refactor (`mcp-server/server.js` split) is isolated after the structural path groundwork is stable
- each phase has a clear rollback point
- reviewers can reason about one boundary at a time

## Stop conditions

Pause and regroup if any of these happen:
- a phase requires unexpected behavior changes outside its declared scope
- package exports need semantic redesign rather than path updates
- hook/shim move forces agent-runtime code into `hosts/**` or vice versa
- tests start failing for reasons unrelated to path/import churn

When that happens:
- stop the slice
- document the unexpected dependency
- add or amend a proposal note before continuing

## Definition of done

The restructure is done when:
- old path families are gone from live code
- canonical docs match the actual tree
- package builds pass
- architecture tests pass
- host-edge and daemon-runtime boundaries are clearer in code than they were before the move
