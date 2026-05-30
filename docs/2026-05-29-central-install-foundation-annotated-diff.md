# Central-install foundation — annotated diff

Unified + annotated diff of every change on `universal-overhaul` since
`6163e96` (the daemon-token-file doc commit), through `34670d8`.

This range is the **Model B central-install foundation**, built test-design-first
per the design thread: the reconciliation/execution/locking/mode machinery for
the future `~/.agents-comm-bus/{bin,adapters}` central install, plus its docs and
tests. **None of it is wired into the live `ensureDaemon` paths yet** — the dev
loop is untouched. Dual-reviewed (Codex + Hermes LGTM) as the foundation
checkpoint before the activation phase.

Remaining (not in this range, deliberate next steps that flip live behavior):
1. emit `install-stamp.json` from the stage/assemble scripts into real plugin artifacts
2. wire `ensureCentralInstall(...)` into the `ensureDaemon` callers (hooks + MCP shim),
   landing together with `AGENTS_COMM_BUS_BIN` set in dev configs so dev sessions
   take the source-mode skip.

## File inventory

```
 agents-comm-bus/package.json                       |   2 +-
 docs/research/install-model.md                     | 226 +++++++++++--
 hosts/common/install/ensure-central-install.js     | 181 ++++++++++
 hosts/common/install/install-lock.js               | 118 +++++++
 hosts/common/install/node-fs-seam.js               | 117 +++++++
 hosts/common/install/reconcile-central-install.js  | 363 +++++++++++++++++++++
 hosts/common/install/run-central-install.js        |  58 ++++
 .../central-install-concurrency.test.ts            | 207 ++++++++++++
 tests/architecture/central-install-execute.test.ts | 241 ++++++++++++++
 tests/architecture/central-install-mode.test.ts    | 276 ++++++++++++++++
 .../architecture/central-install-reconcile.test.ts | 262 +++++++++++++++
 11 files changed, 2027 insertions(+), 24 deletions(-)
```

## How to read this

Organized by commit in chronological order. Each section is one commit:
a short annotation of **what** it changes and **why**, followed by that commit's
unified diff in a fenced block. The sum of the per-commit diffs equals the full
`6163e96..34670d8` range diff. Diffs use four-backtick fences because the
in-range `install-model.md` diff itself contains triple-backtick code blocks.

## Annotated commits

---

## `3e886b1` — Add central-install reconciliation seam + T1 tests

Introduces the **pure decision layer**. `reconcile-central-install.js` defines
`reconcileInstall(actor, state) -> plan` (no I/O, fully deterministic) separate
from `executeInstallPlan(plan, actor, paths, fs)` (effects via an injected fs
seam) — mirroring the `ensure-daemon.ts` dependency-injection style. Locks the
core rules: blob replacement keys on the **bundle's own version**
(`daemonBundleVersion`/`adapterBundleVersion`), never `plugin_version`;
`installed_by` reference-counting keyed on `(agent, comm)`; idempotent re-run,
no-downgrade, provenance-merge-only on equal/older. T1 tests include the headline
regression: a higher-`plugin_version` hotfix carrying an older daemon bundle must
not replace a newer installed daemon.

````diff
diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
index 57f8289..b886785 100644
--- a/agents-comm-bus/package.json
+++ b/agents-comm-bus/package.json
@@ -27,7 +27,7 @@
   "scripts": {
     "build": "tsc && node scripts/copy-assets.js",
     "typecheck": "tsc --noEmit",
-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\""
+    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\""
   },
   "engines": { "node": ">=22" },
   "dependencies": {
diff --git a/hosts/common/install/reconcile-central-install.js b/hosts/common/install/reconcile-central-install.js
new file mode 100644
index 0000000..32375d3
--- /dev/null
+++ b/hosts/common/install/reconcile-central-install.js
@@ -0,0 +1,346 @@
+/**
+ * Central-install reconciliation seam (host-edge, agent-agnostic).
+ *
+ * This is the shared library boundary the per-agent install hooks delegate to.
+ * It mirrors the dependency-injection discipline of
+ * `core-daemon/bootstrap/ensure-daemon.ts`: a PURE decision function
+ * (`reconcileInstall`) that takes the installing plugin's identity + the
+ * current on-disk central-install state and returns a *plan*, kept separate
+ * from `executeInstallPlan`, which performs the actual filesystem effects
+ * against an injected `fs` seam. That split is what makes the four-layer test
+ * model cheap:
+ *   - T1: drive `reconcileInstall` with plain objects (this file; no I/O).
+ *   - T2: drive `executeInstallPlan` against a temp state root.
+ *   - T3: race many reconcile+execute pairs against one temp root.
+ *   - T4: run the real install hook in a subprocess against temp HOME.
+ *
+ * Versioning invariant (see install-model.md "Version metadata policy"):
+ * the replace decision for a shared blob keys on that blob's OWN version
+ * (`daemonBundleVersion` / `adapterBundleVersion`), NEVER on `pluginVersion`.
+ * `pluginVersion` is provenance only. This prevents an adapter-side plugin
+ * hotfix (higher plugin_version) that re-bundles an OLDER daemon from silently
+ * downgrading a newer installed daemon.
+ *
+ * Reference counting: a single `bin/daemon.js` is shared across every comm
+ * plugin of every agent. The reference unit is therefore `(agent, comm)`, not
+ * `agent` alone — claude-telegram and claude-matrix are two independent
+ * references to the same daemon blob. `installed_by` entries are keyed on
+ * `(agent, comm)` so uninstalling one comm plugin doesn't drop the daemon's
+ * reference held by another comm plugin of the same agent.
+ *
+ * @typedef {"claude" | "codex"} AgentId
+ * @typedef {"daemon" | "adapter"} ContentKind
+ *
+ * @typedef {Object} InstallActor
+ * @property {AgentId} agent
+ * @property {string} comm                  e.g. "telegram"
+ * @property {string} pluginVersion         provenance only — NOT a replace key
+ * @property {string} daemonBundleVersion   replace key for bin/daemon.js
+ * @property {string} adapterBundleVersion  replace key for adapters/<comm>.js
+ * @property {string} [pluginInstallDir]    source dir for bundle bytes (used by execute)
+ * @property {string} installedAt           ISO timestamp, injected (keeps reconcile pure)
+ *
+ * @typedef {Object} ProvenanceEntry
+ * @property {AgentId} agent
+ * @property {string} comm
+ * @property {string} plugin_version
+ * @property {string} bundle_version
+ * @property {string} installed_at
+ *
+ * @typedef {Object} VersionRecord   the parsed content of a *.version.json file
+ * @property {number} schema_version
+ * @property {string} content_version   the installed blob's own version (highest-wins key)
+ * @property {ContentKind} content_kind
+ * @property {string} [content_id]      <comm> for adapters; absent for the daemon
+ * @property {ProvenanceEntry} content_source   which plugin laid down the current blob
+ * @property {ProvenanceEntry[]} installed_by   reference set, keyed by (agent, comm)
+ *
+ * @typedef {Object} CentralState
+ * @property {boolean} daemonExists                bin/daemon.js present on disk
+ * @property {VersionRecord | null} daemonVersionFile
+ * @property {boolean} adapterExists               adapters/<actor.comm>.js present on disk
+ * @property {VersionRecord | null} adapterVersionFile
+ * @property {boolean} daemonRunning               a live daemon answered discovery
+ *
+ * @typedef {Object} ArtifactPlan
+ * @property {boolean} writeBundle          copy the plugin's bundle into the central path
+ * @property {boolean} writeVersionFile     (re)write the *.version.json metadata
+ * @property {boolean} contentReplaced      the installed blob version changed
+ * @property {string} resultingContentVersion
+ * @property {VersionRecord} resultingVersionFile   metadata to persist (merged provenance)
+ * @property {string[]} reasons
+ *
+ * @typedef {Object} ReconcilePlan
+ * @property {ArtifactPlan} daemon
+ * @property {ArtifactPlan} adapter
+ * @property {boolean} requiresSpawn            no live daemon — caller must spawn
+ * @property {boolean} requiresDaemonRestart    daemon blob changed under a live daemon
+ * @property {boolean} requiresAdapterReload    adapter blob added/changed under a live daemon
+ * @property {string[]} reasons
+ */
+
+export const VERSION_FILE_SCHEMA = 1;
+
+/**
+ * Pure decision function. No I/O. Deterministic given its inputs (timestamps
+ * are supplied via `actor.installedAt`, never read from the clock here).
+ *
+ * @param {InstallActor} actor
+ * @param {CentralState} state
+ * @returns {ReconcilePlan}
+ */
+export function reconcileInstall(actor, state) {
+  const daemon = reconcileArtifact("daemon", actor, state.daemonVersionFile, state.daemonExists, undefined);
+  const adapter = reconcileArtifact("adapter", actor, state.adapterVersionFile, state.adapterExists, actor.comm);
+
+  const requiresSpawn = !state.daemonRunning;
+  const requiresDaemonRestart = state.daemonRunning && daemon.contentReplaced;
+  const requiresAdapterReload = state.daemonRunning && adapter.contentReplaced;
+
+  return {
+    daemon,
+    adapter,
+    requiresSpawn,
+    requiresDaemonRestart,
+    requiresAdapterReload,
+    reasons: [...daemon.reasons, ...adapter.reasons],
+  };
+}
+
+/**
+ * @param {ContentKind} kind
+ * @param {InstallActor} actor
+ * @param {VersionRecord | null} existing
+ * @param {boolean} bundleExists
+ * @param {string | undefined} contentId
+ * @returns {ArtifactPlan}
+ */
+function reconcileArtifact(kind, actor, existing, bundleExists, contentId) {
+  const incomingVersion = kind === "daemon" ? actor.daemonBundleVersion : actor.adapterBundleVersion;
+  const entry = makeEntry(actor, kind);
+
+  // Cold: nothing recorded yet for this artifact.
+  if (!existing) {
+    /** @type {VersionRecord} */
+    const record = {
+      schema_version: VERSION_FILE_SCHEMA,
+      content_version: incomingVersion,
+      content_kind: kind,
+      ...(contentId ? { content_id: contentId } : {}),
+      content_source: entry,
+      installed_by: [entry],
+    };
+    return {
+      writeBundle: true,
+      writeVersionFile: true,
+      contentReplaced: true,
+      resultingContentVersion: incomingVersion,
+      resultingVersionFile: record,
+      reasons: [`cold install: no existing ${kind}`],
+    };
+  }
+
+  const { list, changed } = upsertInstalledBy(existing.installed_by, entry);
+  /** @type {VersionRecord} */
+  const record = { ...existing, installed_by: list };
+  const reasons = [];
+  let writeBundle = false;
+  let contentReplaced = false;
+
+  const cmp = compareVersions(incomingVersion, existing.content_version);
+  if (cmp > 0) {
+    // Genuine upgrade — incoming blob is newer than what's installed.
+    writeBundle = true;
+    contentReplaced = true;
+    record.content_version = incomingVersion;
+    record.content_source = entry;
+    reasons.push(`upgrade ${kind}: incoming ${incomingVersion} > installed ${existing.content_version}`);
+  } else if (cmp === 0) {
+    reasons.push(`no content change: incoming ${kind} equals installed ${incomingVersion}`);
+    if (!bundleExists) {
+      // Metadata says this version is installed but the blob is gone — restore it.
+      writeBundle = true;
+      reasons.push(`recovery: ${kind} blob missing on disk, rewriting at installed version`);
+    }
+  } else {
+    // Older incoming blob. THE REGRESSION GUARD: this branch is reached even
+    // when actor.pluginVersion > content_source.plugin_version, because the
+    // comparison keys on the blob version, not the plugin version.
+    reasons.push(`no downgrade: incoming ${kind} ${incomingVersion} < installed ${existing.content_version}`);
+    if (!bundleExists) {
+      // Recorded-newer blob is missing and we only carry an older one. Restore
+      // the older blob rather than leave the artifact unusable — an explicit,
+      // logged downgrade-on-recovery, distinct from a normal install path.
+      writeBundle = true;
+      contentReplaced = true;
+      record.content_version = incomingVersion;
+      record.content_source = entry;
+      reasons.push(`recovery: ${kind} blob missing and only older bundle available; restoring at ${incomingVersion}`);
+    }
+  }
+
+  return {
+    writeBundle,
+    writeVersionFile: changed || contentReplaced,
+    contentReplaced,
+    resultingContentVersion: record.content_version,
+    resultingVersionFile: record,
+    reasons,
+  };
+}
+
+/**
+ * Upsert a provenance entry keyed on (agent, comm). Returns the new list and
+ * whether anything meaningful changed. An entry whose (plugin_version,
+ * bundle_version) is unchanged is a no-op (its installed_at is preserved) so a
+ * re-run of the same install is idempotent and does not churn the file.
+ *
+ * @param {ProvenanceEntry[]} list
+ * @param {ProvenanceEntry} entry
+ * @returns {{ list: ProvenanceEntry[], changed: boolean }}
+ */
+function upsertInstalledBy(list, entry) {
+  const idx = list.findIndex((e) => e.agent === entry.agent && e.comm === entry.comm);
+  if (idx === -1) {
+    return { list: [...list, entry], changed: true };
+  }
+  const prev = list[idx];
+  if (prev.plugin_version === entry.plugin_version && prev.bundle_version === entry.bundle_version) {
+    return { list, changed: false };
+  }
+  const next = list.slice();
+  next[idx] = entry;
+  return { list: next, changed: true };
+}
+
+/**
+ * @param {InstallActor} actor
+ * @param {ContentKind} kind
+ * @returns {ProvenanceEntry}
+ */
+function makeEntry(actor, kind) {
+  return {
+    agent: actor.agent,
+    comm: actor.comm,
+    plugin_version: actor.pluginVersion,
+    bundle_version: kind === "daemon" ? actor.daemonBundleVersion : actor.adapterBundleVersion,
+    installed_at: actor.installedAt,
+  };
+}
+
+/**
+ * Release-version comparison ("semver-ish"). Compares dotted numeric
+ * components; prerelease suffixes (after `-`) are stripped — full prerelease
+ * ordering is out of scope for v1. Non-numeric components fall back to string
+ * comparison per component.
+ *
+ * @param {string} a
+ * @param {string} b
+ * @returns {-1 | 0 | 1}
+ */
+export function compareVersions(a, b) {
+  const pa = parseVersion(a);
+  const pb = parseVersion(b);
+  const n = Math.max(pa.length, pb.length);
+  for (let i = 0; i < n; i++) {
+    const x = pa[i] ?? 0;
+    const y = pb[i] ?? 0;
+    if (typeof x === "number" && typeof y === "number") {
+      if (x !== y) return x < y ? -1 : 1;
+    } else {
+      const xs = String(x);
+      const ys = String(y);
+      if (xs !== ys) return xs < ys ? -1 : 1;
+    }
+  }
+  return 0;
+}
+
+/**
+ * @param {string} v
+ * @returns {Array<number | string>}
+ */
+function parseVersion(v) {
+  return String(v)
+    .split("-")[0]
+    .split(".")
+    .map((s) => {
+      const num = Number(s);
+      return Number.isInteger(num) ? num : s;
+    });
+}
+
+/**
+ * Minimal filesystem seam used by `executeInstallPlan`. Injectable so tests
+ * can drive execution against a temp root (T2) or a fake (T3) without touching
+ * the real `~/.agents-comm-bus/`.
+ *
+ * @typedef {Object} FsSeam
+ * @property {(dir: string) => Promise<void>} mkdirp
+ * @property {(from: string, to: string) => Promise<void>} copyFile
+ * @property {(file: string, data: string) => Promise<void>} writeFile
+ *
+ * @typedef {Object} CentralPaths
+ * @property {string} daemonBundle        target path for bin/daemon.js
+ * @property {string} daemonVersionFile   target path for bin/version.json
+ * @property {string} adapterBundle       target path for adapters/<comm>.js
+ * @property {string} adapterVersionFile  target path for adapters/<comm>.version.json
+ *
+ * @typedef {Object} ExecutionResult
+ * @property {string[]} wroteBundles
+ * @property {string[]} wroteVersionFiles
+ */
+
+/**
+ * Reference executor for the plan. Kept intentionally thin: it only performs
+ * the writes the plan asked for. Spawn / restart / reload are the caller's
+ * responsibility (they depend on the runtime daemon connection, not the fs).
+ *
+ * @param {ReconcilePlan} plan
+ * @param {InstallActor} actor
+ * @param {CentralPaths} paths
+ * @param {FsSeam} fs
+ * @returns {Promise<ExecutionResult>}
+ */
+export async function executeInstallPlan(plan, actor, paths, fs) {
+  const wroteBundles = [];
+  const wroteVersionFiles = [];
+  const daemonSrc = actor.pluginInstallDir ? `${actor.pluginInstallDir}/daemon.bundle.js` : null;
+  const adapterSrc = actor.pluginInstallDir
+    ? `${actor.pluginInstallDir}/${actor.comm}.adapter.bundle.js`
+    : null;
+
+  if (plan.daemon.writeBundle && daemonSrc) {
+    await fs.mkdirp(dirname(paths.daemonBundle));
+    await fs.copyFile(daemonSrc, paths.daemonBundle);
+    wroteBundles.push(paths.daemonBundle);
+  }
+  if (plan.daemon.writeVersionFile) {
+    await fs.mkdirp(dirname(paths.daemonVersionFile));
+    await fs.writeFile(paths.daemonVersionFile, serialize(plan.daemon.resultingVersionFile));
+    wroteVersionFiles.push(paths.daemonVersionFile);
+  }
+  if (plan.adapter.writeBundle && adapterSrc) {
+    await fs.mkdirp(dirname(paths.adapterBundle));
+    await fs.copyFile(adapterSrc, paths.adapterBundle);
+    wroteBundles.push(paths.adapterBundle);
+  }
+  if (plan.adapter.writeVersionFile) {
+    await fs.mkdirp(dirname(paths.adapterVersionFile));
+    await fs.writeFile(paths.adapterVersionFile, serialize(plan.adapter.resultingVersionFile));
+    wroteVersionFiles.push(paths.adapterVersionFile);
+  }
+
+  return { wroteBundles, wroteVersionFiles };
+}
+
+/** @param {VersionRecord} record */
+function serialize(record) {
+  return `${JSON.stringify(record, null, 2)}\n`;
+}
+
+/** @param {string} p */
+function dirname(p) {
+  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
+  return i === -1 ? "." : p.slice(0, i);
+}
diff --git a/tests/architecture/central-install-reconcile.test.ts b/tests/architecture/central-install-reconcile.test.ts
new file mode 100644
index 0000000..ade74e4
--- /dev/null
+++ b/tests/architecture/central-install-reconcile.test.ts
@@ -0,0 +1,221 @@
+import assert from "node:assert/strict";
+import { describe, it } from "node:test";
+
+import {
+  reconcileInstall,
+  compareVersions,
+  VERSION_FILE_SCHEMA,
+} from "../../hosts/common/install/reconcile-central-install.js";
+
+// ---------------------------------------------------------------------------
+// Builders — keep each test readable by defaulting the boring fields.
+// ---------------------------------------------------------------------------
+
+type Agent = "claude" | "codex";
+
+interface ActorOverrides {
+  agent?: Agent;
+  comm?: string;
+  pluginVersion?: string;
+  daemonBundleVersion?: string;
+  adapterBundleVersion?: string;
+  installedAt?: string;
+}
+
+function actor(o: ActorOverrides = {}) {
+  return {
+    agent: o.agent ?? "claude",
+    comm: o.comm ?? "telegram",
+    pluginVersion: o.pluginVersion ?? "1.0.0",
+    daemonBundleVersion: o.daemonBundleVersion ?? "1.0.0",
+    adapterBundleVersion: o.adapterBundleVersion ?? "1.0.0",
+    pluginInstallDir: "/fake/plugin",
+    installedAt: o.installedAt ?? "2026-05-18T20:25:00Z",
+  };
+}
+
+const EMPTY_STATE = {
+  daemonExists: false,
+  daemonVersionFile: null,
+  adapterExists: false,
+  adapterVersionFile: null,
+  daemonRunning: false,
+};
+
+/** Apply a plan's resulting metadata back into a CentralState, as execute would. */
+function applied(state: any, plan: any) {
+  return {
+    daemonExists: state.daemonExists || plan.daemon.writeBundle,
+    daemonVersionFile: plan.daemon.writeVersionFile ? plan.daemon.resultingVersionFile : state.daemonVersionFile,
+    adapterExists: state.adapterExists || plan.adapter.writeBundle,
+    adapterVersionFile: plan.adapter.writeVersionFile ? plan.adapter.resultingVersionFile : state.adapterVersionFile,
+    daemonRunning: state.daemonRunning,
+  };
+}
+
+// ---------------------------------------------------------------------------
+// T1 — pure reconciliation logic
+// ---------------------------------------------------------------------------
+
+describe("compareVersions", () => {
+  it("orders dotted release versions numerically", () => {
+    assert.equal(compareVersions("2.0.0", "1.0.0"), 1);
+    assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
+    assert.equal(compareVersions("1.2.0", "1.10.0"), -1); // numeric, not lexical
+    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
+  });
+});
+
+describe("reconcileInstall — cold install", () => {
+  it("lays down daemon + adapter from empty state", () => {
+    const plan = reconcileInstall(actor(), EMPTY_STATE);
+
+    assert.equal(plan.daemon.writeBundle, true);
+    assert.equal(plan.daemon.writeVersionFile, true);
+    assert.equal(plan.adapter.writeBundle, true);
+    assert.equal(plan.adapter.writeVersionFile, true);
+    assert.equal(plan.requiresSpawn, true); // no daemon running yet
+
+    const dv = plan.daemon.resultingVersionFile;
+    assert.equal(dv.schema_version, VERSION_FILE_SCHEMA);
+    assert.equal(dv.content_kind, "daemon");
+    assert.equal(dv.content_version, "1.0.0");
+    assert.equal(dv.installed_by.length, 1);
+
+    const av = plan.adapter.resultingVersionFile;
+    assert.equal(av.content_kind, "adapter");
+    assert.equal(av.content_id, "telegram");
+  });
+});
+
+describe("reconcileInstall — idempotency", () => {
+  it("same actor rerun is a no-op (no bundle copy, no version rewrite)", () => {
+    const first = reconcileInstall(actor(), EMPTY_STATE);
+    const state2 = applied(EMPTY_STATE, first);
+
+    // Rerun, but a later timestamp must NOT cause churn on its own.
+    const second = reconcileInstall(actor({ installedAt: "2026-05-20T00:00:00Z" }), state2);
+
+    assert.equal(second.daemon.writeBundle, false);
+    assert.equal(second.daemon.writeVersionFile, false);
+    assert.equal(second.adapter.writeBundle, false);
+    assert.equal(second.adapter.writeVersionFile, false);
+  });
+});
+
+describe("reconcileInstall — second agent, same comm, same versions", () => {
+  it("merges installed_by without rewriting the blob", () => {
+    const first = reconcileInstall(actor({ agent: "claude" }), EMPTY_STATE);
+    const state2 = applied(EMPTY_STATE, first);
+
+    const second = reconcileInstall(actor({ agent: "codex" }), state2);
+
+    assert.equal(second.daemon.writeBundle, false, "same bundle version -> no recopy");
+    assert.equal(second.daemon.writeVersionFile, true, "provenance changed -> rewrite metadata");
+    assert.equal(second.daemon.resultingVersionFile.content_version, "1.0.0");
+    assert.equal(second.daemon.resultingVersionFile.installed_by.length, 2);
+    const agents = second.daemon.resultingVersionFile.installed_by.map((e: any) => e.agent).sort();
+    assert.deepEqual(agents, ["claude", "codex"]);
+  });
+});
+
+describe("reconcileInstall — upgrade", () => {
+  it("newer daemon bundle replaces the installed one", () => {
+    const first = reconcileInstall(actor({ daemonBundleVersion: "1.0.0" }), EMPTY_STATE);
+    const state2 = applied(EMPTY_STATE, first);
+
+    const second = reconcileInstall(actor({ agent: "codex", daemonBundleVersion: "2.0.0" }), state2);
+
+    assert.equal(second.daemon.writeBundle, true);
+    assert.equal(second.daemon.contentReplaced, true);
+    assert.equal(second.daemon.resultingVersionFile.content_version, "2.0.0");
+    assert.equal(second.daemon.resultingVersionFile.content_source.agent, "codex");
+  });
+});
+
+describe("reconcileInstall — no downgrade", () => {
+  it("older daemon bundle does NOT replace a newer installed one", () => {
+    const seeded = reconcileInstall(actor({ daemonBundleVersion: "2.0.0" }), EMPTY_STATE);
+    const state2 = applied(EMPTY_STATE, seeded);
+
+    const older = reconcileInstall(actor({ agent: "codex", daemonBundleVersion: "1.0.0" }), state2);
+
+    assert.equal(older.daemon.writeBundle, false);
+    assert.equal(older.daemon.contentReplaced, false);
+    assert.equal(older.daemon.resultingVersionFile.content_version, "2.0.0");
+    // ...but it still gets recorded as a referencing installer.
+    assert.equal(older.daemon.writeVersionFile, true);
+    assert.equal(older.daemon.resultingVersionFile.installed_by.length, 2);
+  });
+});
+
+describe("reconcileInstall — REGRESSION: plugin_version must not drive blob replacement", () => {
+  it("higher plugin_version carrying an OLDER daemon bundle does not replace the newer daemon", () => {
+    // Installed: matrix plugin@1.2.0 that shipped daemon bundle 2.0.0.
+    const seeded = reconcileInstall(
+      actor({ agent: "claude", comm: "matrix", pluginVersion: "1.2.0", daemonBundleVersion: "2.0.0" }),
+      EMPTY_STATE,
+    );
+    const state2 = applied(EMPTY_STATE, seeded);
+
+    // Incoming: telegram plugin@1.3.0 (HIGHER plugin_version) re-bundling the
+    // OLD daemon 1.0.0. A naive plugin-version-keyed rule would downgrade.
+    const hotfix = reconcileInstall(
+      actor({ agent: "claude", comm: "telegram", pluginVersion: "1.3.0", daemonBundleVersion: "1.0.0" }),
+      state2,
+    );
+
+    assert.equal(hotfix.daemon.writeBundle, false, "must not overwrite the newer daemon blob");
+    assert.equal(hotfix.daemon.contentReplaced, false);
+    assert.equal(hotfix.daemon.resultingVersionFile.content_version, "2.0.0", "blob version is the only replace key");
+
+    // Provenance stays honest: plugin_version and bundle_version diverge.
+    const tgEntry = hotfix.daemon.resultingVersionFile.installed_by.find((e: any) => e.comm === "telegram");
+    assert.ok(tgEntry);
+    assert.equal(tgEntry.plugin_version, "1.3.0");
+    assert.equal(tgEntry.bundle_version, "1.0.0");
+    assert.equal(hotfix.daemon.resultingVersionFile.content_source.bundle_version, "2.0.0");
+  });
+});
+
+describe("reconcileInstall — reference counting keyed on (agent, comm)", () => {
+  it("one agent installing two comm plugins yields two distinct daemon references", () => {
+    const tg = reconcileInstall(actor({ agent: "claude", comm: "telegram" }), EMPTY_STATE);
+    const state2 = applied(EMPTY_STATE, tg);
+
+    const mx = reconcileInstall(actor({ agent: "claude", comm: "matrix" }), state2);
+
+    // claude appears twice in the shared daemon's reference set — once per comm
+    // plugin — so uninstalling one comm plugin can't orphan the daemon that the
+    // other still needs.
+    const refs = mx.daemon.resultingVersionFile.installed_by.map((e: any) => `${e.agent}:${e.comm}`).sort();
+    assert.deepEqual(refs, ["claude:matrix", "claude:telegram"]);
+  });
+});
+
+describe("reconcileInstall — runtime signals under a live daemon", () => {
+  it("flags restart on daemon upgrade and reload on adapter add while running", () => {
+    const seeded = reconcileInstall(actor({ daemonBundleVersion: "1.0.0", adapterBundleVersion: "1.0.0" }), EMPTY_STATE);
+
+    // Daemon is up and the telegram adapter is installed. We're now installing
+    // the *matrix* adapter — CentralState.adapterVersionFile is scoped to the
+    // adapter for the actor's comm, so for matrix it is null (not yet present).
+    const running = {
+      daemonExists: true,
+      daemonVersionFile: seeded.daemon.resultingVersionFile,
+      adapterExists: false,
+      adapterVersionFile: null,
+      daemonRunning: true,
+    };
+
+    // codex adds the matrix adapter and ships a newer daemon, daemon already up.
+    const next = reconcileInstall(
+      actor({ agent: "codex", comm: "matrix", daemonBundleVersion: "2.0.0", adapterBundleVersion: "1.0.0" }),
+      running,
+    );
+
+    assert.equal(next.requiresSpawn, false, "daemon already running");
+    assert.equal(next.requiresDaemonRestart, true, "daemon blob replaced under a live daemon");
+    assert.equal(next.requiresAdapterReload, true, "new matrix adapter added under a live daemon");
+  });
+});

````

---

## `8fdbb66` — Document central install seam and test contract

Doc-only. Adds the **Version metadata policy** and **Testability / simulated
live-install strategy** sections to `install-model.md`: `plugin_version` is
provenance only, bundle versions are the replace keys; no downgrade on older
install; no auto-downgrade on uninstall-of-highest; the four-layer test model
(T1 pure / T2 temp-fs / T3 concurrency / T4 subprocess); and the seam signatures
matching the implementation.

````diff
diff --git a/docs/research/install-model.md b/docs/research/install-model.md
index 587fd77..a8ad5e1 100644
--- a/docs/research/install-model.md
+++ b/docs/research/install-model.md
@@ -109,23 +109,81 @@ prompt the install hooks reinstall the code from plugin install paths.
 Because both `~/.claude/plugins/agents-comm-bus-<comm>/` and
 `~/.codex/plugins/agents-comm-bus-<comm>/` (and any future agent's
 equivalent) may all try to install the same shared file, the metadata
-file is a **list of installers**, not a single string:
+file is a **list of installers**, not a single string.
+
+### Version metadata policy
+
+`plugin_version` is **provenance only**. It identifies the marketplace
+plugin package that carried a bundle, but it is **not** the replacement
+key for the installed bytes.
+
+Replacement decisions key on the installed artifact's **own bundle
+version**:
+
+- `bin/version.json` tracks the daemon bundle's version.
+- `adapters/<comm>.version.json` tracks that adapter bundle's version.
+- `plugin_version` remains in provenance so the system can tell *which
+  plugin package* installed or last refreshed a given entry.
+
+This matters because plugin versions and bundle versions can drift. For
+example, `agents-comm-bus-telegram@1.3.0` could ship an unchanged
+daemon bundle `1.0.0` while `agents-comm-bus-matrix@1.2.0` already
+shipped daemon bundle `2.0.0`. In that case, the Telegram plugin's
+higher `plugin_version` must **not** replace the newer installed daemon
+bundle.
+
+The metadata shape therefore records the installed artifact separately
+from the plugins that contributed provenance:
 
 ```json
 {
-  "version": "1.2.0",
+  "schema_version": 1,
+  "content_kind": "daemon",
+  "content_id": "daemon",
+  "content_version": "2.0.0",
+  "content_source": {
+    "agent": "claude",
+    "comm": "telegram",
+    "plugin_version": "1.2.0",
+    "bundle_version": "2.0.0"
+  },
   "installed_by": [
-    { "agent": "claude", "plugin_version": "1.2.0", "installed_at": "2026-05-18T20:25:00Z" },
-    { "agent": "codex",  "plugin_version": "1.1.5", "installed_at": "2026-05-19T03:18:00Z" }
+    {
+      "agent": "claude",
+      "comm": "telegram",
+      "plugin_version": "1.2.0",
+      "bundle_version": "2.0.0",
+      "installed_at": "2026-05-18T20:25:00Z"
+    },
+    {
+      "agent": "codex",
+      "comm": "telegram",
+      "plugin_version": "1.3.0",
+      "bundle_version": "1.0.0",
+      "installed_at": "2026-05-19T03:18:00Z"
+    }
   ]
 }
 ```
 
-The actual file content reflects the **highest** `plugin_version` across
-all entries. Install hooks **add** their entry on install (replacing any
-prior entry for that same `agent`); uninstall hooks **remove** their
-entry. When the `installed_by` list goes empty, the file is safe to
-clean up (probably with a confirm prompt — see open questions).
+For adapters, `content_kind` is `"adapter"` and `content_id` is the
+comm name (for example `"telegram"`).
+
+Rules:
+
+- `installed_by` entries are keyed on **`(agent, comm)`**, not `agent`
+  alone. `claude+telegram` and `claude+matrix` are independent
+  references to the shared daemon.
+- Install hooks **add or replace** their own provenance entry on install.
+- The installed bytes are replaced only when the incoming
+  `bundle_version` is newer than `content_version`.
+- An older bundle version must **not** downgrade an already-installed
+  newer bundle, even if the incoming `plugin_version` is higher.
+- Uninstall hooks remove their provenance entry, but uninstalling the
+  plugin that most recently provided the installed bytes does **not**
+  auto-downgrade the shared file to the next-highest remaining entry.
+- When `installed_by` becomes empty, the file is safe to clean up
+  (probably with a confirm prompt — see open questions).
 
 Install hooks are themselves agent-specific (Claude Code's hook contract
 differs from Codex's — different env vars, different stdin envelope,
@@ -378,9 +436,9 @@ agents. Not a v1 concern.
    1. Checks `~/.agents-comm-bus/bin/daemon.js` — missing.
    2. Creates `~/.agents-comm-bus/`, copies the plugin's
       `daemon.bundle.js` → `bin/daemon.js`, writes `bin/version.json`
-      with `installed_by` containing this agent's entry.
+      with `installed_by` containing this `(agent, comm)` entry.
    3. Copies the plugin's `<comm>.adapter.bundle.js` → `adapters/<comm>.js`,
-      writes `adapters/<comm>.version.json` with this agent's entry.
+      writes `adapters/<comm>.version.json` with this `(agent, comm)` entry.
    4. Spawns daemon detached (`Start-Process` on Windows, `nohup` on
       Unix).
    5. Polls `~/.agents-comm-bus/port` until present, opens the WS
@@ -395,14 +453,16 @@ agents. Not a v1 concern.
 
 1. User runs `/plugin install agents-comm-bus-<other-comm>` (or the
    same `<comm>` from the second agent's marketplace).
-2. First prompt after install: that plugin's `install-hook.js` fires:
+2. First usable hook invocation after install: that plugin's
+   `install-hook.js` fires:
    1. Reads `~/.agents-comm-bus/bin/version.json` — daemon present.
-      Compares versions; upgrades `bin/daemon.js` if the plugin's
-      bundle is newer (see below). Adds this hook's agent entry to
-      `installed_by` (or updates the existing entry).
-   2. Reads `~/.agents-comm-bus/adapters/<comm>.version.json` —
-      missing or older plugin_version → copies the plugin's adapter,
-      updates `installed_by`.
+      Compares the incoming daemon `bundle_version` against
+      `content_version`; upgrades `bin/daemon.js` only if the incoming
+      bundle is newer (see below). Adds this hook's `(agent, comm)`
+      entry to `installed_by` (or updates the existing entry).
+   2. Reads `~/.agents-comm-bus/adapters/<comm>.version.json` for this
+      actor's comm only — missing or older `content_version` → copies
+      the plugin's adapter, updates `installed_by`.
    3. Sends a `reload-adapters` control message to the daemon over the
       existing WS. **[TBD: v1 may simplify to "next daemon restart"
       and skip hot-reload.]**
@@ -414,9 +474,11 @@ agents. Not a v1 concern.
   same monorepo, but releases drift —
   `agents-comm-bus-telegram@1.0` may ship daemon@1, and
   `agents-comm-bus-matrix@1.2` may ship daemon@2.
-- The install hook compares `plugin's daemon.bundle.js` plugin_version
-  vs the highest `plugin_version` already in `bin/version.json`.
-  **Highest wins.**
+- The install hook compares the incoming daemon bundle's
+  `bundle_version` against `bin/version.json.content_version`.
+  **Highest bundle version wins.** `plugin_version` is provenance only.
+- A plugin with a higher `plugin_version` but an older daemon bundle
+  must **not** replace the newer installed daemon.
 - The **running** daemon does not hot-swap its own binary. It picks up
   a newer `bin/daemon.js` on next restart. **[TBD: trigger choice —
   "next idle period," "next session start," or explicit
@@ -430,12 +492,130 @@ agents. Not a v1 concern.
 - Daemon upgrade: restart required. In-flight long-poll connections
   drop and reconnect.
 
+## Testability / simulated live-install strategy
+
+The tested contract is **first usable hook invocation**, not literal
+`SessionStart`. That matches the current architecture more accurately:
+Claude's `UserPromptSubmit` path and Codex's `UserPromptSubmit` / repair
+paths already participate in daemon bootstrap, while literal session
+start behavior may differ by host.
+
+Marketplace fetch/extract is **out of scope** for these tests. The host
+runtime's `/plugin install` step is treated as a prerequisite that
+produces a populated plugin directory. Tests fixture that populated
+plugin dir and then verify what our install hook and daemon do with it.
+
+To make the behavior testable, central install logic should be split
+into a shared library boundary before writing most tests:
+
+- `reconcileInstall(actor, state) -> plan` (pure decision function)
+- `executeInstallPlan(plan, actor, paths, fs) -> effects`
+
+The actor must carry three distinct versions:
+
+- `pluginVersion` for provenance
+- `daemonBundleVersion` for daemon replacement decisions
+- `adapterBundleVersion` for adapter replacement decisions
+- `pluginInstallDir` for executor-side bundle source resolution when a
+  plan requires copying bytes
+
+Keeping those separate prevents a plugin-only hotfix from accidentally
+downgrading a newer installed daemon or adapter. In the long run, the
+safest wiring is to derive the bundle versions from the bundles (or a
+sidecar/version stamp shipped with them) when constructing the actor, so
+accidentally passing `pluginVersion` as a replacement key becomes
+structurally harder.
+
+### Four test layers
+
+#### T1 — pure reconciliation tests
+
+Most coverage and most value should live here. These tests exercise the
+planning logic without real subprocesses.
+
+Required invariants:
+
+- idempotent reruns do not duplicate provenance entries
+- install order is irrelevant to final settled metadata
+- highest **bundle** version wins for installed bytes
+- older bundle versions never downgrade a newer installed bundle
+- uninstall of the plugin that most recently provided the installed
+  bytes does **not** auto-downgrade the shared file
+
+#### T2 — temp-filesystem integration tests
+
+Run real reconciles against temp directories representing HOME, plugin
+install dirs, and the shared `~/.agents-comm-bus/` root. Spawn/restart
+behavior can still be injected.
+
+These prove the library works against actual filesystem state:
+
+- cold install lays down daemon bundle, adapter bundle, and both metadata
+  files
+- warm install merges `installed_by` without unnecessary rewrites
+- adding a second comm installs only that adapter while preserving the
+  daemon and existing adapters
+- missing file / present metadata and present file / missing metadata
+  recovery converge to a valid state
+- executor rejects a plan that requires bundle copies when
+  `pluginInstallDir` or source bundle paths are unavailable, and writes
+  no metadata in that failure path
+
+#### T3 — concurrency tests (mandatory)
+
+Concurrency is mandatory because mixed-version double-install is the
+highest-risk path in the model. The shared install location is only
+trustworthy if concurrent callers converge cleanly.
+
+Required assertions:
+
+- concurrent cold installs converge on one valid final state
+- mixed-version concurrent installs settle on the highest daemon bundle
+  version
+- `version.json` remains valid JSON with merged provenance
+- no truncated `bin/daemon.js` or adapter bundle files are left behind
+- if bootstrap also starts the daemon, only one spawn occurs and other
+  callers converge on the same result
+
+#### T4 — subprocess hook simulation (gated smoke)
+
+Keep a small number of heavier tests that run the real hook wrappers in
+subprocesses against temp roots. These verify script plumbing rather
+than core reconciliation logic:
+
+- env-var and stdin-envelope handling
+- hook-to-library wiring
+- first-run hint injection
+- real copied daemon startup smoke after install
+
+These should be gated like integration smoke tests, not carry the main
+correctness burden.
+
+### Concrete first-batch matrix
+
+- cold install from empty shared root
+- same plugin rerun is idempotent
+- same comm on a second agent merges provenance without content churn
+- second comm install adds only its adapter
+- newer daemon bundle replaces older installed daemon
+- higher `plugin_version` carrying an older `daemonBundleVersion` does
+  **not** replace the newer installed daemon
+- newer adapter bundle replaces older installed adapter for that comm
+- uninstall removes provenance but does **not** auto-downgrade the
+  installed daemon or adapter
+- partial-state recovery: missing file / missing metadata / corrupt
+  metadata
+- executor guard: plan requires bundle copy but bundle source is
+  unavailable -> reject and write nothing
+- mixed-version concurrent double-install converges on the highest
+  bundle version with valid merged metadata
+
 ## Migration from `claude-code-telegram`
 
 1. User uninstalls the old `claude-code-telegram` plugin.
 2. User installs `agents-comm-bus-telegram` from the Claude marketplace.
-3. First prompt bootstraps the daemon and drops the Telegram adapter
-   (cold-install lifecycle above).
+3. First usable hook invocation bootstraps the daemon and drops the
+   Telegram adapter (cold-install lifecycle above).
 4. User re-runs registration with their existing bot token:
    `/comm-register telegram <token>` (or via the conversational
    `register_account` MCP tool).

````

---

## `5bf7120` — Harden central-install executor against partial-install state

Closes a partial-install hole found in review: `executeInstallPlan` would
silently skip a required bundle copy when `pluginInstallDir` was unset yet still
write the version file — manufacturing metadata that claims a blob never copied.
Now it **fails hard before any write**. Also fixes per-comm state modeling in the
`(agent, comm)` refcount test (a matrix reconcile must start from null adapter
state, not telegram's carried forward).

````diff
diff --git a/hosts/common/install/reconcile-central-install.js b/hosts/common/install/reconcile-central-install.js
index 32375d3..488c95f 100644
--- a/hosts/common/install/reconcile-central-install.js
+++ b/hosts/common/install/reconcile-central-install.js
@@ -303,16 +303,33 @@ function parseVersion(v) {
  * @returns {Promise<ExecutionResult>}
  */
 export async function executeInstallPlan(plan, actor, paths, fs) {
-  const wroteBundles = [];
-  const wroteVersionFiles = [];
   const daemonSrc = actor.pluginInstallDir ? `${actor.pluginInstallDir}/daemon.bundle.js` : null;
   const adapterSrc = actor.pluginInstallDir
     ? `${actor.pluginInstallDir}/${actor.comm}.adapter.bundle.js`
     : null;
 
-  if (plan.daemon.writeBundle && daemonSrc) {
+  // Fail hard BEFORE any write. A `writeBundle` with no source path would
+  // otherwise silently skip the copy yet still write the version file —
+  // manufacturing a partial-install state where the metadata claims a blob
+  // that was never laid down. Validate up front so a rejected plan writes
+  // nothing at all.
+  if (plan.daemon.writeBundle && !daemonSrc) {
+    throw new Error(
+      "executeInstallPlan: daemon bundle write required but actor.pluginInstallDir is unset",
+    );
+  }
+  if (plan.adapter.writeBundle && !adapterSrc) {
+    throw new Error(
+      "executeInstallPlan: adapter bundle write required but actor.pluginInstallDir is unset",
+    );
+  }
+
+  const wroteBundles = [];
+  const wroteVersionFiles = [];
+
+  if (plan.daemon.writeBundle) {
     await fs.mkdirp(dirname(paths.daemonBundle));
-    await fs.copyFile(daemonSrc, paths.daemonBundle);
+    await fs.copyFile(/** @type {string} */ (daemonSrc), paths.daemonBundle);
     wroteBundles.push(paths.daemonBundle);
   }
   if (plan.daemon.writeVersionFile) {
@@ -320,9 +337,9 @@ export async function executeInstallPlan(plan, actor, paths, fs) {
     await fs.writeFile(paths.daemonVersionFile, serialize(plan.daemon.resultingVersionFile));
     wroteVersionFiles.push(paths.daemonVersionFile);
   }
-  if (plan.adapter.writeBundle && adapterSrc) {
+  if (plan.adapter.writeBundle) {
     await fs.mkdirp(dirname(paths.adapterBundle));
-    await fs.copyFile(adapterSrc, paths.adapterBundle);
+    await fs.copyFile(/** @type {string} */ (adapterSrc), paths.adapterBundle);
     wroteBundles.push(paths.adapterBundle);
   }
   if (plan.adapter.writeVersionFile) {
diff --git a/tests/architecture/central-install-reconcile.test.ts b/tests/architecture/central-install-reconcile.test.ts
index ade74e4..a190b3b 100644
--- a/tests/architecture/central-install-reconcile.test.ts
+++ b/tests/architecture/central-install-reconcile.test.ts
@@ -3,6 +3,7 @@ import { describe, it } from "node:test";
 
 import {
   reconcileInstall,
+  executeInstallPlan,
   compareVersions,
   VERSION_FILE_SCHEMA,
 } from "../../hosts/common/install/reconcile-central-install.js";
@@ -181,9 +182,19 @@ describe("reconcileInstall — REGRESSION: plugin_version must not drive blob re
 describe("reconcileInstall — reference counting keyed on (agent, comm)", () => {
   it("one agent installing two comm plugins yields two distinct daemon references", () => {
     const tg = reconcileInstall(actor({ agent: "claude", comm: "telegram" }), EMPTY_STATE);
-    const state2 = applied(EMPTY_STATE, tg);
 
-    const mx = reconcileInstall(actor({ agent: "claude", comm: "matrix" }), state2);
+    // Installing the *matrix* adapter next: carry the shared daemon state
+    // forward, but adapter state is per-comm so matrix's adapter is null (the
+    // telegram adapter file is a different artifact, irrelevant here).
+    const daemonState = {
+      daemonExists: true,
+      daemonVersionFile: tg.daemon.resultingVersionFile,
+      adapterExists: false,
+      adapterVersionFile: null,
+      daemonRunning: false,
+    };
+
+    const mx = reconcileInstall(actor({ agent: "claude", comm: "matrix" }), daemonState);
 
     // claude appears twice in the shared daemon's reference set — once per comm
     // plugin — so uninstalling one comm plugin can't orphan the daemon that the
@@ -193,6 +204,36 @@ describe("reconcileInstall — reference counting keyed on (agent, comm)", () =>
   });
 });
 
+describe("executeInstallPlan — partial-install guard", () => {
+  it("rejects a plan that requires a bundle copy with no pluginInstallDir, writing nothing", async () => {
+    const calls: string[] = [];
+    const fakeFs = {
+      mkdirp: async (d: string) => { calls.push(`mkdirp:${d}`); },
+      copyFile: async (a: string, b: string) => { calls.push(`copy:${a}->${b}`); },
+      writeFile: async (f: string, _data: string) => { calls.push(`write:${f}`); },
+    };
+    const paths = {
+      daemonBundle: "/central/bin/daemon.js",
+      daemonVersionFile: "/central/bin/version.json",
+      adapterBundle: "/central/adapters/telegram.js",
+      adapterVersionFile: "/central/adapters/telegram.version.json",
+    };
+
+    // Cold install plan (writeBundle=true) but actor has no pluginInstallDir.
+    const noSrcActor = { ...actor(), pluginInstallDir: undefined as unknown as string };
+    const plan = reconcileInstall(noSrcActor, EMPTY_STATE);
+    assert.equal(plan.daemon.writeBundle, true);
+
+    await assert.rejects(
+      () => executeInstallPlan(plan, noSrcActor, paths, fakeFs),
+      /pluginInstallDir is unset/,
+    );
+    // The critical property: nothing was written before the throw — no
+    // version file claiming a blob that was never copied.
+    assert.deepEqual(calls, []);
+  });
+});
+
 describe("reconcileInstall — runtime signals under a live daemon", () => {
   it("flags restart on daemon upgrade and reload on adapter add while running", () => {
     const seeded = reconcileInstall(actor({ daemonBundleVersion: "1.0.0", adapterBundleVersion: "1.0.0" }), EMPTY_STATE);

````

---

## `42f458a` — Add T2 temp-fs tests for central-install executor

Adds `node-fs-seam.js` (a real `node:fs`-backed `FsSeam` + `resolveCentralPaths`
for the `~/.agents-comm-bus/{bin,adapters}` layout — real install-hook building
blocks) and 5 T2 scenarios driving `executeInstallPlan` against a real temp state
root with version-stamped payloads, asserting actual bytes-on-disk via the hook's
true flow (read fs -> build state -> reconcile -> execute).

````diff
diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
index b886785..58eb1e0 100644
--- a/agents-comm-bus/package.json
+++ b/agents-comm-bus/package.json
@@ -27,7 +27,7 @@
   "scripts": {
     "build": "tsc && node scripts/copy-assets.js",
     "typecheck": "tsc --noEmit",
-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\""
+    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\""
   },
   "engines": { "node": ">=22" },
   "dependencies": {
diff --git a/hosts/common/install/node-fs-seam.js b/hosts/common/install/node-fs-seam.js
new file mode 100644
index 0000000..e455d1c
--- /dev/null
+++ b/hosts/common/install/node-fs-seam.js
@@ -0,0 +1,46 @@
+/**
+ * Concrete node-backed pieces for central install: the real `FsSeam` that
+ * `executeInstallPlan` writes through, and the path resolver for the shared
+ * `~/.agents-comm-bus/` code layout. Kept in a sibling file so
+ * `reconcile-central-install.js` stays import-free and trivially unit-testable
+ * (T1 needs no fs at all); this is the I/O edge the real install hook uses.
+ */
+import { mkdir, copyFile, writeFile } from "node:fs/promises";
+import path from "node:path";
+
+/**
+ * Real filesystem seam backed by node:fs/promises.
+ * @returns {import("./reconcile-central-install.js").FsSeam}
+ */
+export function createNodeFsSeam() {
+  return {
+    mkdirp: async (dir) => {
+      await mkdir(dir, { recursive: true });
+    },
+    copyFile: async (from, to) => {
+      await copyFile(from, to);
+    },
+    writeFile: async (file, data) => {
+      await writeFile(file, data, "utf8");
+    },
+  };
+}
+
+/**
+ * Resolve the central-install code paths for one comm under a state root.
+ * Separates code (`bin/`, `adapters/`) from daemon state, per install-model.md.
+ *
+ * @param {string} stateRoot   e.g. ~/.agents-comm-bus
+ * @param {string} comm        e.g. "telegram"
+ * @returns {import("./reconcile-central-install.js").CentralPaths}
+ */
+export function resolveCentralPaths(stateRoot, comm) {
+  const bin = path.join(stateRoot, "bin");
+  const adapters = path.join(stateRoot, "adapters");
+  return {
+    daemonBundle: path.join(bin, "daemon.js"),
+    daemonVersionFile: path.join(bin, "version.json"),
+    adapterBundle: path.join(adapters, `${comm}.js`),
+    adapterVersionFile: path.join(adapters, `${comm}.version.json`),
+  };
+}
diff --git a/tests/architecture/central-install-execute.test.ts b/tests/architecture/central-install-execute.test.ts
new file mode 100644
index 0000000..d80dfd0
--- /dev/null
+++ b/tests/architecture/central-install-execute.test.ts
@@ -0,0 +1,173 @@
+import assert from "node:assert/strict";
+import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
+import os from "node:os";
+import path from "node:path";
+import { describe, it } from "node:test";
+
+import { reconcileInstall, executeInstallPlan } from "../../hosts/common/install/reconcile-central-install.js";
+import { createNodeFsSeam, resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";
+
+// ---------------------------------------------------------------------------
+// T2 — executeInstallPlan against a REAL temp state root + real plugin payloads.
+// Each scenario reads central state back from disk between installs, exactly as
+// the install hook will: read fs -> build CentralState -> reconcile -> execute.
+// ---------------------------------------------------------------------------
+
+async function tempRoot(): Promise<string> {
+  return mkdtemp(path.join(os.tmpdir(), "central-install-"));
+}
+
+/** Create a fake plugin install dir carrying version-stamped bundle payloads. */
+async function fakePlugin(comm: string, daemonBytes: string, adapterBytes: string): Promise<string> {
+  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
+  await writeFile(path.join(dir, "daemon.bundle.js"), daemonBytes, "utf8");
+  await writeFile(path.join(dir, `${comm}.adapter.bundle.js`), adapterBytes, "utf8");
+  return dir;
+}
+
+function actor(pluginInstallDir: string, o: Record<string, string> = {}) {
+  return {
+    agent: (o.agent ?? "claude") as "claude" | "codex",
+    comm: o.comm ?? "telegram",
+    pluginVersion: o.pluginVersion ?? "1.0.0",
+    daemonBundleVersion: o.daemonBundleVersion ?? "1.0.0",
+    adapterBundleVersion: o.adapterBundleVersion ?? "1.0.0",
+    pluginInstallDir,
+    installedAt: o.installedAt ?? "2026-05-18T20:25:00Z",
+  };
+}
+
+async function exists(p: string): Promise<boolean> {
+  try {
+    await access(p);
+    return true;
+  } catch {
+    return false;
+  }
+}
+
+async function readJson(p: string): Promise<any> {
+  try {
+    return JSON.parse(await readFile(p, "utf8"));
+  } catch {
+    return null;
+  }
+}
+
+/** Read current central state from disk for a comm, as the hook would. */
+async function readCentralState(stateRoot: string, comm: string) {
+  const paths = resolveCentralPaths(stateRoot, comm);
+  return {
+    daemonExists: await exists(paths.daemonBundle),
+    daemonVersionFile: await readJson(paths.daemonVersionFile),
+    adapterExists: await exists(paths.adapterBundle),
+    adapterVersionFile: await readJson(paths.adapterVersionFile),
+    daemonRunning: false,
+  };
+}
+
+/** Reconcile + execute a single install against the live temp root. */
+async function install(stateRoot: string, a: ReturnType<typeof actor>) {
+  const state = await readCentralState(stateRoot, a.comm);
+  const plan = reconcileInstall(a, state);
+  const paths = resolveCentralPaths(stateRoot, a.comm);
+  const result = await executeInstallPlan(plan, a, paths, createNodeFsSeam());
+  return { plan, paths, result };
+}
+
+describe("T2 executeInstallPlan — cold install on a real temp root", () => {
+  it("lays down daemon + adapter bundles and version files with correct bytes", async () => {
+    const root = await tempRoot();
+    const plugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TELEGRAM_ADAPTER_v1.0.0");
+
+    const { paths } = await install(root, actor(plugin));
+
+    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
+    assert.equal(await readFile(paths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");
+
+    const dv = await readJson(paths.daemonVersionFile);
+    assert.equal(dv.content_version, "1.0.0");
+    assert.equal(dv.content_kind, "daemon");
+    assert.equal(dv.installed_by.length, 1);
+
+    const av = await readJson(paths.adapterVersionFile);
+    assert.equal(av.content_id, "telegram");
+    assert.equal(av.content_version, "1.0.0");
+  });
+});
+
+describe("T2 executeInstallPlan — upgrade replaces the daemon bytes", () => {
+  it("a newer daemon bundle overwrites bin/daemon.js and bumps content_version", async () => {
+    const root = await tempRoot();
+    const v1 = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
+    const v2 = await fakePlugin("telegram", "DAEMON_BUNDLE_v2.0.0", "TG_v2");
+
+    await install(root, actor(v1, { daemonBundleVersion: "1.0.0", adapterBundleVersion: "1.0.0" }));
+    const { paths } = await install(
+      root,
+      actor(v2, { agent: "codex", daemonBundleVersion: "2.0.0", adapterBundleVersion: "2.0.0" }),
+    );
+
+    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v2.0.0");
+    const dv = await readJson(paths.daemonVersionFile);
+    assert.equal(dv.content_version, "2.0.0");
+    assert.equal(dv.content_source.agent, "codex");
+  });
+});
+
+describe("T2 executeInstallPlan — older install cannot downgrade on-disk bytes", () => {
+  it("keeps the newer daemon bytes when an older bundle installs afterward", async () => {
+    const root = await tempRoot();
+    const v2 = await fakePlugin("telegram", "DAEMON_BUNDLE_v2.0.0", "TG_v2");
+    const v1 = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
+
+    await install(root, actor(v2, { daemonBundleVersion: "2.0.0", adapterBundleVersion: "2.0.0" }));
+    const { plan, paths } = await install(
+      root,
+      actor(v1, { agent: "codex", daemonBundleVersion: "1.0.0", adapterBundleVersion: "1.0.0" }),
+    );
+
+    assert.equal(plan.daemon.writeBundle, false);
+    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v2.0.0", "bytes not downgraded");
+    const dv = await readJson(paths.daemonVersionFile);
+    assert.equal(dv.content_version, "2.0.0");
+    // ...but the older installer is still recorded as a reference.
+    assert.equal(dv.installed_by.length, 2);
+  });
+});
+
+describe("T2 executeInstallPlan — idempotent rerun touches nothing", () => {
+  it("a repeat of the same install writes no bundle and no version file", async () => {
+    const root = await tempRoot();
+    const plugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
+
+    await install(root, actor(plugin));
+    const { plan, paths } = await install(root, actor(plugin, { installedAt: "2026-06-01T00:00:00Z" }));
+
+    assert.equal(plan.daemon.writeBundle, false);
+    assert.equal(plan.daemon.writeVersionFile, false);
+    assert.equal(plan.adapter.writeBundle, false);
+    assert.equal(plan.adapter.writeVersionFile, false);
+    // On-disk content unchanged, including the original installed_at timestamp.
+    const dv = await readJson(paths.daemonVersionFile);
+    assert.equal(dv.installed_by[0].installed_at, "2026-05-18T20:25:00Z");
+  });
+});
+
+describe("T2 executeInstallPlan — second agent merges provenance without recopying", () => {
+  it("same bundle version from a second agent rewrites only the version file", async () => {
+    const root = await tempRoot();
+    const claudePlugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
+    const codexPlugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
+
+    await install(root, actor(claudePlugin, { agent: "claude" }));
+    const { plan, paths } = await install(root, actor(codexPlugin, { agent: "codex" }));
+
+    assert.equal(plan.daemon.writeBundle, false, "identical bundle version -> no recopy");
+    assert.equal(plan.daemon.writeVersionFile, true, "provenance changed -> rewrite metadata");
+
+    const dv = await readJson(paths.daemonVersionFile);
+    const agents = dv.installed_by.map((e: any) => e.agent).sort();
+    assert.deepEqual(agents, ["claude", "codex"]);
+  });
+});

````

---

## `ab376ee` — Round out T2 coverage per review checklist

Three more temp-fs cases from the review checklist, the key one being
**missing-bundle recovery** — it covers the `!bundleExists` branch that had no
test: a lost daemon blob whose version file still claims it is restored on the
next install. Plus second-comm install and a real-root variant of the executor
guard.

````diff
diff --git a/tests/architecture/central-install-execute.test.ts b/tests/architecture/central-install-execute.test.ts
index d80dfd0..b21c0f0 100644
--- a/tests/architecture/central-install-execute.test.ts
+++ b/tests/architecture/central-install-execute.test.ts
@@ -1,5 +1,5 @@
 import assert from "node:assert/strict";
-import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
+import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
 import os from "node:os";
 import path from "node:path";
 import { describe, it } from "node:test";
@@ -171,3 +171,71 @@ describe("T2 executeInstallPlan — second agent merges provenance without recop
     assert.deepEqual(agents, ["claude", "codex"]);
   });
 });
+
+describe("T2 executeInstallPlan — second comm install", () => {
+  it("preserves the daemon + existing adapter and writes the new comm's adapter", async () => {
+    const root = await tempRoot();
+    const tgPlugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TELEGRAM_ADAPTER");
+    const mxPlugin = await fakePlugin("matrix", "DAEMON_BUNDLE_v1.0.0", "MATRIX_ADAPTER");
+
+    await install(root, actor(tgPlugin, { comm: "telegram" }));
+    const { paths: mxPaths } = await install(root, actor(mxPlugin, { comm: "matrix" }));
+
+    // Telegram adapter untouched; matrix adapter freshly written.
+    const tgPaths = resolveCentralPaths(root, "telegram");
+    assert.equal(await readFile(tgPaths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER");
+    assert.equal(await readFile(mxPaths.adapterBundle, "utf8"), "MATRIX_ADAPTER");
+
+    // Shared daemon preserved (same version) and now referenced by both comms.
+    assert.equal(await readFile(mxPaths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
+    const dv = await readJson(mxPaths.daemonVersionFile);
+    const refs = dv.installed_by.map((e: any) => `${e.agent}:${e.comm}`).sort();
+    assert.deepEqual(refs, ["claude:matrix", "claude:telegram"]);
+  });
+});
+
+describe("T2 executeInstallPlan — missing-bundle recovery", () => {
+  it("restores a lost daemon blob when the version file still claims it", async () => {
+    const root = await tempRoot();
+    const plugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
+
+    await install(root, actor(plugin));
+
+    // Simulate the blob going missing while metadata still records it.
+    const paths = resolveCentralPaths(root, "telegram");
+    await rm(paths.daemonBundle);
+    assert.equal(await exists(paths.daemonBundle), false);
+
+    // Rerunning the same install must detect daemonExists=false and rewrite
+    // the blob (the !bundleExists recovery branch), leaving metadata valid.
+    const { plan } = await install(root, actor(plugin));
+
+    assert.equal(plan.daemon.writeBundle, true);
+    assert.ok(plan.daemon.reasons.some((r: string) => r.includes("recovery")));
+    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
+    const dv = await readJson(paths.daemonVersionFile);
+    assert.equal(dv.content_version, "1.0.0");
+  });
+});
+
+describe("T2 executeInstallPlan — executor guard on a real root", () => {
+  it("rejects a bundle-requiring plan with no source and creates no files", async () => {
+    const root = await tempRoot();
+    const noSrc = { ...actor("/does/not/matter"), pluginInstallDir: undefined as unknown as string };
+
+    const state = await readCentralState(root, noSrc.comm);
+    const plan = reconcileInstall(noSrc, state);
+    const paths = resolveCentralPaths(root, noSrc.comm);
+
+    await assert.rejects(
+      () => executeInstallPlan(plan, noSrc, paths, createNodeFsSeam()),
+      /pluginInstallDir is unset/,
+    );
+
+    // Nothing landed anywhere under the central root.
+    assert.equal(await exists(paths.daemonBundle), false);
+    assert.equal(await exists(paths.daemonVersionFile), false);
+    assert.equal(await exists(paths.adapterBundle), false);
+    assert.equal(await exists(paths.adapterVersionFile), false);
+  });
+});

````

---

## `d69ba56` — Add T3 central-install serialization: global lock + atomic writes

The serialization layer. `install-lock.js` is a **single global** `install.lock`
(`O_CREAT|O_EXCL` + token-verified release, bounded wait/retry, stale-lock steal)
— global because every install reconciles the shared daemon anyway, so per-artifact
locks add deadlock surface for no real parallelism. `createAtomicNodeFsSeam` writes
via same-dir temp file + atomic rename. `run-central-install.js` is the
orchestrator: acquire -> re-read disk -> reconcile -> execute -> release, with the
authoritative reconcile **inside** the lock so stale pre-lock plans can't win.
7 tests: lock contention/stale-steal/timeout + 4 real `Promise.all` races.
(Windows rename-over-running-daemon was verified safe separately.)

````diff
diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
index 58eb1e0..2beeed4 100644
--- a/agents-comm-bus/package.json
+++ b/agents-comm-bus/package.json
@@ -27,7 +27,7 @@
   "scripts": {
     "build": "tsc && node scripts/copy-assets.js",
     "typecheck": "tsc --noEmit",
-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\""
+    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\""
   },
   "engines": { "node": ">=22" },
   "dependencies": {
diff --git a/hosts/common/install/install-lock.js b/hosts/common/install/install-lock.js
new file mode 100644
index 0000000..da76541
--- /dev/null
+++ b/hosts/common/install/install-lock.js
@@ -0,0 +1,118 @@
+/**
+ * Global central-install lock.
+ *
+ * Serializes the whole read→reconcile→execute critical section so concurrent
+ * installs (e.g. a Claude hook and a Codex hook both firing on first prompt)
+ * cannot interleave bundle copies and metadata writes. A SINGLE global lock is
+ * deliberate: every install reconciles the shared daemon (bin/daemon.js +
+ * version.json), so per-artifact locks would not buy real parallelism — they
+ * would only add lock-ordering and deadlock surface.
+ *
+ * Mirrors the core-daemon spawn-lock idiom (O_CREAT|O_EXCL + token-verified
+ * release) and adds bounded wait/retry plus stale-lock stealing, matching the
+ * ensureDaemon ergonomics.
+ */
+import { constants } from "node:fs";
+import { open, readFile, rm, mkdir, stat } from "node:fs/promises";
+import path from "node:path";
+
+const DEFAULTS = { timeoutMs: 5_000, retryMs: 50, staleMs: 30_000 };
+
+/**
+ * @typedef {Object} InstallLock
+ * @property {string} path
+ * @property {string} token
+ * @property {boolean} stoleStale   true if a stale holder's lock was reclaimed
+ * @property {() => Promise<void>} release
+ *
+ * @typedef {Object} InstallLockOptions
+ * @property {number} [timeoutMs]   max time to wait for the lock before throwing
+ * @property {number} [retryMs]     poll interval while the lock is held
+ * @property {number} [staleMs]     age past which a held lock is considered abandoned
+ * @property {() => number} [now]   injectable clock (tests); defaults to Date.now
+ * @property {(ms: number) => Promise<void>} [sleep]  injectable delay (tests)
+ */
+
+/**
+ * Acquire the install lock, waiting (bounded) if another installer holds it.
+ *
+ * @param {string} lockPath
+ * @param {InstallLockOptions} [options]
+ * @returns {Promise<InstallLock>}
+ */
+export async function acquireInstallLock(lockPath, options = {}) {
+  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
+  const retryMs = options.retryMs ?? DEFAULTS.retryMs;
+  const staleMs = options.staleMs ?? DEFAULTS.staleMs;
+  const now = options.now ?? Date.now;
+  const sleep = options.sleep ?? defaultSleep;
+
+  await mkdir(path.dirname(lockPath), { recursive: true });
+  const token = `${process.pid}:${now()}`;
+  const start = now();
+  let stoleStale = false;
+
+  for (;;) {
+    try {
+      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
+      await handle.writeFile(`${token}\n`, "utf8");
+      await handle.close();
+      return {
+        path: lockPath,
+        token,
+        stoleStale,
+        release: async () => {
+          try {
+            const current = await readFile(lockPath, "utf8");
+            if (current.trim() === token) {
+              await rm(lockPath, { force: true });
+            }
+          } catch {
+            // Best-effort: a later install can treat a leftover lock as stale.
+          }
+        },
+      };
+    } catch (error) {
+      if (!isAlreadyExistsError(error)) throw error;
+
+      // Held by someone else — reclaim it if it looks abandoned.
+      if (await stealIfStale(lockPath, staleMs, now)) {
+        stoleStale = true;
+        continue;
+      }
+      if (now() - start >= timeoutMs) {
+        throw new Error(`central install lock at ${lockPath} is held; timed out after ${timeoutMs}ms`);
+      }
+      await sleep(retryMs);
+    }
+  }
+}
+
+/**
+ * @param {string} lockPath
+ * @param {number} staleMs
+ * @param {() => number} now
+ * @returns {Promise<boolean>}
+ */
+async function stealIfStale(lockPath, staleMs, now) {
+  try {
+    const info = await stat(lockPath);
+    if (now() - info.mtimeMs > staleMs) {
+      await rm(lockPath, { force: true });
+      return true;
+    }
+  } catch {
+    // Disappeared between the failed open and the stat — the next loop retries.
+  }
+  return false;
+}
+
+/** @param {number} ms */
+function defaultSleep(ms) {
+  return new Promise((resolve) => setTimeout(resolve, ms));
+}
+
+/** @param {unknown} error */
+function isAlreadyExistsError(error) {
+  return typeof error === "object" && error !== null && "code" in error && /** @type {any} */ (error).code === "EEXIST";
+}
diff --git a/hosts/common/install/node-fs-seam.js b/hosts/common/install/node-fs-seam.js
index e455d1c..cbadee5 100644
--- a/hosts/common/install/node-fs-seam.js
+++ b/hosts/common/install/node-fs-seam.js
@@ -5,7 +5,7 @@
  * `reconcile-central-install.js` stays import-free and trivially unit-testable
  * (T1 needs no fs at all); this is the I/O edge the real install hook uses.
  */
-import { mkdir, copyFile, writeFile } from "node:fs/promises";
+import { mkdir, copyFile, writeFile, rename, access, readFile } from "node:fs/promises";
 import path from "node:path";
 
 /**
@@ -26,6 +26,77 @@ export function createNodeFsSeam() {
   };
 }
 
+/**
+ * Atomic filesystem seam: every write lands via a same-directory temp file
+ * followed by an atomic rename, so a reader (or a crash) never observes a
+ * half-written bundle or truncated JSON — only old-good or new-good. Verified
+ * safe on Windows even when a running daemon has the target .js imported (node
+ * closes the handle after import, unlike a locked .exe image).
+ *
+ * Safe to use a fixed `.tmp` suffix because runCentralInstall holds the global
+ * install lock, so there is exactly one writer at a time.
+ *
+ * @returns {import("./reconcile-central-install.js").FsSeam}
+ */
+export function createAtomicNodeFsSeam() {
+  return {
+    mkdirp: async (dir) => {
+      await mkdir(dir, { recursive: true });
+    },
+    copyFile: async (from, to) => {
+      const tmp = `${to}.tmp`;
+      await copyFile(from, tmp);
+      await rename(tmp, to);
+    },
+    writeFile: async (file, data) => {
+      const tmp = `${file}.tmp`;
+      await writeFile(tmp, data, "utf8");
+      await rename(tmp, file);
+    },
+  };
+}
+
+/**
+ * Read the current central-install state for one comm from disk, in the shape
+ * reconcileInstall expects. This is the real hook flow's read step: read fs →
+ * build CentralState → reconcile. `daemonRunning` is left false here (it is a
+ * discovery-probe concern, not a filesystem one); the caller overrides it if
+ * it has a live daemon handshake.
+ *
+ * @param {string} stateRoot
+ * @param {string} comm
+ * @returns {Promise<import("./reconcile-central-install.js").CentralState>}
+ */
+export async function readCentralState(stateRoot, comm) {
+  const paths = resolveCentralPaths(stateRoot, comm);
+  return {
+    daemonExists: await pathExists(paths.daemonBundle),
+    daemonVersionFile: await readJsonOrNull(paths.daemonVersionFile),
+    adapterExists: await pathExists(paths.adapterBundle),
+    adapterVersionFile: await readJsonOrNull(paths.adapterVersionFile),
+    daemonRunning: false,
+  };
+}
+
+/** @param {string} p */
+async function pathExists(p) {
+  try {
+    await access(p);
+    return true;
+  } catch {
+    return false;
+  }
+}
+
+/** @param {string} p */
+async function readJsonOrNull(p) {
+  try {
+    return JSON.parse(await readFile(p, "utf8"));
+  } catch {
+    return null;
+  }
+}
+
 /**
  * Resolve the central-install code paths for one comm under a state root.
  * Separates code (`bin/`, `adapters/`) from daemon state, per install-model.md.
diff --git a/hosts/common/install/run-central-install.js b/hosts/common/install/run-central-install.js
new file mode 100644
index 0000000..6a38610
--- /dev/null
+++ b/hosts/common/install/run-central-install.js
@@ -0,0 +1,58 @@
+/**
+ * Central-install orchestrator — the outer ring around the pure seam.
+ *
+ * runCentralInstall is what the per-agent install hook calls. It holds the
+ * global install lock across the ENTIRE read→reconcile→execute section, so the
+ * authoritative reconcile runs against fresh on-disk state inside the lock. A
+ * plan computed before the lock can be stale (another installer may have won a
+ * race and bumped content_version); only the in-lock plan is executed.
+ *
+ * Layering: this file adds orchestration only. reconcileInstall (pure decision)
+ * and executeInstallPlan (effects) are unchanged. Atomicity (temp-file + rename,
+ * bytes-before-metadata) is a property of the injected fs seam, defaulting to
+ * createAtomicNodeFsSeam.
+ */
+import path from "node:path";
+
+import { reconcileInstall, executeInstallPlan } from "./reconcile-central-install.js";
+import { createAtomicNodeFsSeam, resolveCentralPaths, readCentralState } from "./node-fs-seam.js";
+import { acquireInstallLock } from "./install-lock.js";
+
+const INSTALL_LOCK_NAME = "install.lock";
+
+/**
+ * @typedef {Object} RunCentralInstallDeps
+ * @property {import("./reconcile-central-install.js").FsSeam} [fs]  defaults to atomic node seam
+ * @property {import("./install-lock.js").InstallLockOptions} [lock]
+ * @property {boolean} [daemonRunning]  pass-through to reconcile's runtime signals
+ *
+ * @typedef {Object} RunCentralInstallResult
+ * @property {import("./reconcile-central-install.js").ReconcilePlan} plan  the in-lock plan that was executed
+ * @property {import("./reconcile-central-install.js").ExecutionResult} result
+ * @property {boolean} stoleStale  whether a stale lock was reclaimed to proceed
+ */
+
+/**
+ * Acquire the lock, re-read disk state, reconcile, execute, release.
+ *
+ * @param {string} stateRoot
+ * @param {import("./reconcile-central-install.js").InstallActor} actor
+ * @param {RunCentralInstallDeps} [deps]
+ * @returns {Promise<RunCentralInstallResult>}
+ */
+export async function runCentralInstall(stateRoot, actor, deps = {}) {
+  const fs = deps.fs ?? createAtomicNodeFsSeam();
+  const lockPath = path.join(stateRoot, INSTALL_LOCK_NAME);
+  const lock = await acquireInstallLock(lockPath, deps.lock ?? {});
+  try {
+    // Authoritative reconcile: fresh disk state read INSIDE the lock.
+    const state = await readCentralState(stateRoot, actor.comm);
+    state.daemonRunning = deps.daemonRunning ?? false;
+    const plan = reconcileInstall(actor, state);
+    const paths = resolveCentralPaths(stateRoot, actor.comm);
+    const result = await executeInstallPlan(plan, actor, paths, fs);
+    return { plan, result, stoleStale: lock.stoleStale };
+  } finally {
+    await lock.release();
+  }
+}
diff --git a/tests/architecture/central-install-concurrency.test.ts b/tests/architecture/central-install-concurrency.test.ts
new file mode 100644
index 0000000..5b7f84b
--- /dev/null
+++ b/tests/architecture/central-install-concurrency.test.ts
@@ -0,0 +1,207 @@
+import assert from "node:assert/strict";
+import { mkdtemp, writeFile, readFile, access, utimes, stat } from "node:fs/promises";
+import os from "node:os";
+import path from "node:path";
+import { describe, it } from "node:test";
+
+import { runCentralInstall } from "../../hosts/common/install/run-central-install.js";
+import { acquireInstallLock } from "../../hosts/common/install/install-lock.js";
+import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";
+
+// ---------------------------------------------------------------------------
+// T3 — install lock + real-concurrency orchestrator races.
+// Real temp root, real lockfile, real atomic-rename fs, Promise.all. No fake
+// concurrency shortcuts: this is the only way the serialization is proven.
+// ---------------------------------------------------------------------------
+
+async function tempRoot(): Promise<string> {
+  return mkdtemp(path.join(os.tmpdir(), "central-install-conc-"));
+}
+
+async function fakePlugin(comm: string, version: string): Promise<string> {
+  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
+  await writeFile(path.join(dir, "daemon.bundle.js"), `DAEMON_BUNDLE_v${version}`, "utf8");
+  await writeFile(path.join(dir, `${comm}.adapter.bundle.js`), `${comm.toUpperCase()}_ADAPTER_v${version}`, "utf8");
+  return dir;
+}
+
+function actor(pluginInstallDir: string, o: Record<string, string> = {}) {
+  const v = o.version ?? "1.0.0";
+  return {
+    agent: (o.agent ?? "claude") as "claude" | "codex",
+    comm: o.comm ?? "telegram",
+    pluginVersion: o.pluginVersion ?? v,
+    daemonBundleVersion: o.daemonBundleVersion ?? v,
+    adapterBundleVersion: o.adapterBundleVersion ?? v,
+    pluginInstallDir,
+    installedAt: o.installedAt ?? "2026-05-18T20:25:00Z",
+  };
+}
+
+async function readJson(p: string): Promise<any> {
+  return JSON.parse(await readFile(p, "utf8"));
+}
+
+async function exists(p: string): Promise<boolean> {
+  try {
+    await access(p);
+    return true;
+  } catch {
+    return false;
+  }
+}
+
+/** No leftover .tmp files promoted/abandoned under the central root. */
+async function noStrayTemp(stateRoot: string, comm: string) {
+  const paths = resolveCentralPaths(stateRoot, comm);
+  for (const p of Object.values(paths)) {
+    assert.equal(await exists(`${p}.tmp`), false, `stray temp file: ${p}.tmp`);
+  }
+}
+
+// --- lock unit tests --------------------------------------------------------
+
+describe("acquireInstallLock", () => {
+  it("blocks a second acquirer until the first releases", async () => {
+    const root = await tempRoot();
+    const lockPath = path.join(root, "install.lock");
+
+    const first = await acquireInstallLock(lockPath, { timeoutMs: 2_000, retryMs: 10 });
+    let secondAcquired = false;
+    const secondP = acquireInstallLock(lockPath, { timeoutMs: 2_000, retryMs: 10 }).then((l) => {
+      secondAcquired = true;
+      return l;
+    });
+
+    await new Promise((r) => setTimeout(r, 80));
+    assert.equal(secondAcquired, false, "second must wait while first holds");
+
+    await first.release();
+    const second = await secondP;
+    assert.equal(secondAcquired, true);
+    await second.release();
+  });
+
+  it("steals a stale lock past staleMs", async () => {
+    const root = await tempRoot();
+    const lockPath = path.join(root, "install.lock");
+
+    const abandoned = await acquireInstallLock(lockPath, {});
+    // Backdate the lockfile so it looks abandoned, without releasing it.
+    const past = new Date(Date.now() - 120_000);
+    await utimes(lockPath, past, past);
+
+    const reclaimed = await acquireInstallLock(lockPath, { staleMs: 30_000, timeoutMs: 1_000, retryMs: 10 });
+    assert.equal(reclaimed.stoleStale, true);
+    await reclaimed.release();
+    // (abandoned.release would no-op now: token no longer matches.)
+    await abandoned.release();
+  });
+
+  it("times out when the lock stays held and is not stale", async () => {
+    const root = await tempRoot();
+    const lockPath = path.join(root, "install.lock");
+
+    const held = await acquireInstallLock(lockPath, {});
+    await assert.rejects(
+      () => acquireInstallLock(lockPath, { timeoutMs: 120, retryMs: 10, staleMs: 600_000 }),
+      /timed out/,
+    );
+    await held.release();
+  });
+});
+
+// --- orchestrator concurrency races ----------------------------------------
+
+describe("runCentralInstall — concurrent cold installs, same version", () => {
+  it("converges on valid bytes + JSON with all references merged", async () => {
+    const root = await tempRoot();
+    const pA = await fakePlugin("telegram", "1.0.0");
+    const pB = await fakePlugin("telegram", "1.0.0");
+
+    await Promise.all([
+      runCentralInstall(root, actor(pA, { agent: "claude" })),
+      runCentralInstall(root, actor(pB, { agent: "codex" })),
+    ]);
+
+    const paths = resolveCentralPaths(root, "telegram");
+    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
+    const dv = await readJson(paths.daemonVersionFile); // parses => valid JSON
+    assert.equal(dv.content_version, "1.0.0");
+    const agents = dv.installed_by.map((e: any) => e.agent).sort();
+    assert.deepEqual(agents, ["claude", "codex"]);
+    await noStrayTemp(root, "telegram");
+  });
+});
+
+describe("runCentralInstall — concurrent cold installs, mixed daemon versions", () => {
+  it("the highest bundle version wins regardless of completion order, bytes match metadata", async () => {
+    const root = await tempRoot();
+    const pV1 = await fakePlugin("telegram", "1.0.0");
+    const pV2 = await fakePlugin("telegram", "2.0.0");
+
+    await Promise.all([
+      runCentralInstall(root, actor(pV1, { agent: "claude", version: "1.0.0" })),
+      runCentralInstall(root, actor(pV2, { agent: "codex", version: "2.0.0" })),
+    ]);
+
+    const paths = resolveCentralPaths(root, "telegram");
+    const dv = await readJson(paths.daemonVersionFile);
+    assert.equal(dv.content_version, "2.0.0", "highest wins");
+
+    // The decisive cross-check: on-disk bytes must equal the winning version —
+    // metadata is never ahead of bytes.
+    const bytes = await readFile(paths.daemonBundle, "utf8");
+    assert.equal(bytes, "DAEMON_BUNDLE_v2.0.0");
+    assert.ok(bytes.includes(dv.content_version), "bytes correspond to content_version");
+
+    // Both installers recorded as references regardless of who won the content.
+    assert.equal(dv.installed_by.length, 2);
+    await noStrayTemp(root, "telegram");
+  });
+});
+
+describe("runCentralInstall — concurrent installs for different comms", () => {
+  it("writes both adapters and keeps both daemon references", async () => {
+    const root = await tempRoot();
+    const tg = await fakePlugin("telegram", "1.0.0");
+    const mx = await fakePlugin("matrix", "1.0.0");
+
+    await Promise.all([
+      runCentralInstall(root, actor(tg, { agent: "claude", comm: "telegram" })),
+      runCentralInstall(root, actor(mx, { agent: "claude", comm: "matrix" })),
+    ]);
+
+    const tgPaths = resolveCentralPaths(root, "telegram");
+    const mxPaths = resolveCentralPaths(root, "matrix");
+    assert.equal(await readFile(tgPaths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");
+    assert.equal(await readFile(mxPaths.adapterBundle, "utf8"), "MATRIX_ADAPTER_v1.0.0");
+
+    const dv = await readJson(tgPaths.daemonVersionFile);
+    const refs = dv.installed_by.map((e: any) => `${e.agent}:${e.comm}`).sort();
+    assert.deepEqual(refs, ["claude:matrix", "claude:telegram"]);
+    await noStrayTemp(root, "telegram");
+    await noStrayTemp(root, "matrix");
+  });
+});
+
+describe("runCentralInstall — concurrent same-comm installs from different agents", () => {
+  it("adapter + daemon metadata stay valid under same-path contention", async () => {
+    const root = await tempRoot();
+    const pClaude = await fakePlugin("telegram", "1.0.0");
+    const pCodex = await fakePlugin("telegram", "1.0.0");
+
+    await Promise.all([
+      runCentralInstall(root, actor(pClaude, { agent: "claude", comm: "telegram" })),
+      runCentralInstall(root, actor(pCodex, { agent: "codex", comm: "telegram" })),
+    ]);
+
+    const paths = resolveCentralPaths(root, "telegram");
+    assert.equal(await readFile(paths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");
+    const av = await readJson(paths.adapterVersionFile); // valid JSON
+    assert.equal(av.content_id, "telegram");
+    const dv = await readJson(paths.daemonVersionFile);
+    assert.equal(dv.installed_by.length, 2, "both agents merged into daemon provenance");
+    await noStrayTemp(root, "telegram");
+  });
+});

````

---

## `8c26723` — Add central-install mode contract (source/dev vs production)

`ensure-central-install.js` — the mode-aware wrapper hooks will call before
`ensureDaemon`. `resolveInstallMode(env)`: source iff `AGENTS_COMM_BUS_BIN` is set
(authoritative, never inferred); production otherwise. `readInstallStamp` reads a
runtime-readable `install-stamp.json` (distinct from lineage `.stage-manifest.json`).
`ensureCentralInstall`: source mode skips entirely; production mode requires the
stamp and **fails loud** if missing (no silent skip), then builds the InstallActor
and runs `runCentralInstall`. 8 tests. Not wired into live paths.

````diff
diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
index 2beeed4..def451c 100644
--- a/agents-comm-bus/package.json
+++ b/agents-comm-bus/package.json
@@ -27,7 +27,7 @@
   "scripts": {
     "build": "tsc && node scripts/copy-assets.js",
     "typecheck": "tsc --noEmit",
-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\""
+    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\""
   },
   "engines": { "node": ">=22" },
   "dependencies": {
diff --git a/hosts/common/install/ensure-central-install.js b/hosts/common/install/ensure-central-install.js
new file mode 100644
index 0000000..7d59df9
--- /dev/null
+++ b/hosts/common/install/ensure-central-install.js
@@ -0,0 +1,161 @@
+/**
+ * Central-install entry contract — the mode-aware wrapper the per-agent install
+ * hooks (and the MCP shim cold-start path) call BEFORE ensureDaemon.
+ *
+ * Settled mode contract (see install-model.md "Dev mode" + the design thread):
+ *
+ *   source/dev mode  — triggered by an explicit AGENTS_COMM_BUS_BIN env signal.
+ *                      Skip central install entirely; the daemon runs from the
+ *                      source checkout with project-local .agents-comm-bus-dev
+ *                      state. Preserves the current Model A iteration loop.
+ *
+ *   production mode  — no source signal. REQUIRE a runtime-readable install
+ *                      stamp (pluginInstallDir + bundle versions) and fail LOUD
+ *                      if it is missing or invalid. A missing plugin dir in
+ *                      production is a packaging/bootstrap bug we want surfaced,
+ *                      never silently skipped. When present, build the
+ *                      InstallActor from the stamp and run the serialized
+ *                      runCentralInstall.
+ *
+ * The "missing plugin dir => skip" heuristic is deliberately NOT the contract:
+ * explicit env signal is authoritative; absence of production metadata is an
+ * error, not an inferred dev mode.
+ *
+ * This module is the contract + its wiring to runCentralInstall. It is NOT yet
+ * called from the live ensureDaemon paths; that wiring is a separate, deliberate
+ * step that must land together with dev configs setting AGENTS_COMM_BUS_BIN (or
+ * it would hard-fail the current dev loop, which sets none of these vars).
+ */
+import path from "node:path";
+import { readFile } from "node:fs/promises";
+
+import { runCentralInstall as defaultRunCentralInstall } from "./run-central-install.js";
+
+export const INSTALL_STAMP_NAME = "install-stamp.json";
+
+/**
+ * The runtime-readable version stamp expected at the plugin install root in
+ * production. Distinct from .stage-manifest.json (which is build lineage, not
+ * install-actor versions). Emitting this from the stage/assemble scripts is a
+ * follow-up; this module defines its shape and reads it.
+ *
+ * @typedef {Object} InstallStamp
+ * @property {number} schema_version
+ * @property {string} agent
+ * @property {string} comm
+ * @property {string} plugin_version          provenance only
+ * @property {string} daemon_bundle_version   bin/daemon.js replace key
+ * @property {string} adapter_bundle_version  adapters/<comm>.js replace key
+ *
+ * @typedef {"source" | "production"} InstallMode
+ *
+ * @typedef {Object} EnsureCentralInstallOptions
+ * @property {string} stateRoot
+ * @property {string} [agent]                 falls back to the stamp's agent
+ * @property {string} [comm]                  falls back to the stamp's comm
+ * @property {string} [pluginInstallDir]      where the bundles + stamp live (production)
+ * @property {Record<string,string|undefined>} [env]   defaults to process.env
+ * @property {string} [installedAt]           ISO timestamp; defaults to now
+ * @property {boolean} [daemonRunning]        pass-through to runCentralInstall
+ * @property {import("./install-lock.js").InstallLockOptions} [lock]
+ * @property {EnsureCentralInstallDeps} [deps]
+ *
+ * @typedef {Object} EnsureCentralInstallDeps  injectable seams for tests
+ * @property {typeof readFile} [readFile]
+ * @property {typeof defaultRunCentralInstall} [runCentralInstall]
+ * @property {import("./reconcile-central-install.js").FsSeam} [fs]
+ *
+ * @typedef {Object} EnsureCentralInstallResult
+ * @property {InstallMode} mode
+ * @property {boolean} [skipped]              true in source mode
+ * @property {import("./reconcile-central-install.js").InstallActor} [actor]
+ * @property {import("./reconcile-central-install.js").ReconcilePlan} [plan]
+ * @property {import("./reconcile-central-install.js").ExecutionResult} [result]
+ * @property {boolean} [stoleStale]
+ */
+
+/**
+ * Resolve install mode from the environment. PURE. Source mode is triggered
+ * ONLY by an explicit AGENTS_COMM_BUS_BIN signal — never inferred.
+ *
+ * @param {Record<string,string|undefined>} env
+ * @returns {InstallMode}
+ */
+export function resolveInstallMode(env) {
+  return env && env.AGENTS_COMM_BUS_BIN ? "source" : "production";
+}
+
+/**
+ * Read + minimally validate the install stamp under a plugin install dir.
+ * Returns null when absent, unreadable, unparseable, or missing required
+ * version fields.
+ *
+ * @param {string | undefined} pluginInstallDir
+ * @param {EnsureCentralInstallDeps} [deps]
+ * @returns {Promise<InstallStamp | null>}
+ */
+export async function readInstallStamp(pluginInstallDir, deps = {}) {
+  if (!pluginInstallDir) return null;
+  const read = deps.readFile ?? readFile;
+  try {
+    const raw = await read(path.join(pluginInstallDir, INSTALL_STAMP_NAME), "utf8");
+    const parsed = JSON.parse(raw);
+    if (
+      !parsed ||
+      typeof parsed.plugin_version !== "string" ||
+      typeof parsed.daemon_bundle_version !== "string" ||
+      typeof parsed.adapter_bundle_version !== "string"
+    ) {
+      return null;
+    }
+    return parsed;
+  } catch {
+    return null;
+  }
+}
+
+/**
+ * Mode-aware central-install entry point.
+ *
+ * @param {EnsureCentralInstallOptions} options
+ * @returns {Promise<EnsureCentralInstallResult>}
+ */
+export async function ensureCentralInstall(options) {
+  const env = options.env ?? process.env;
+  const mode = resolveInstallMode(env);
+
+  if (mode === "source") {
+    // Daemon runs from source; central install is intentionally bypassed.
+    return { mode: "source", skipped: true };
+  }
+
+  // Production mode is strict: a missing/invalid stamp is a hard error.
+  const stamp = await readInstallStamp(options.pluginInstallDir, options.deps);
+  if (!options.pluginInstallDir || !stamp) {
+    throw new Error(
+      `central install (production mode): missing or invalid plugin install metadata — ` +
+        `expected ${INSTALL_STAMP_NAME} under pluginInstallDir=${options.pluginInstallDir ?? "<unset>"}. ` +
+        `Set AGENTS_COMM_BUS_BIN for source/dev mode, or fix the plugin packaging.`,
+    );
+  }
+
+  /** @type {import("./reconcile-central-install.js").InstallActor} */
+  const actor = {
+    agent: /** @type {any} */ (options.agent ?? stamp.agent),
+    comm: options.comm ?? stamp.comm,
+    pluginVersion: stamp.plugin_version,
+    daemonBundleVersion: stamp.daemon_bundle_version,
+    adapterBundleVersion: stamp.adapter_bundle_version,
+    pluginInstallDir: options.pluginInstallDir,
+    installedAt: options.installedAt ?? new Date().toISOString(),
+  };
+
+  const run = options.deps?.runCentralInstall ?? defaultRunCentralInstall;
+  const outcome = await run(options.stateRoot, actor, {
+    fs: options.deps?.fs,
+    lock: options.lock,
+    daemonRunning: options.daemonRunning ?? false,
+  });
+
+  return { mode: "production", actor, ...outcome };
+}
diff --git a/tests/architecture/central-install-mode.test.ts b/tests/architecture/central-install-mode.test.ts
new file mode 100644
index 0000000..cac208b
--- /dev/null
+++ b/tests/architecture/central-install-mode.test.ts
@@ -0,0 +1,148 @@
+import assert from "node:assert/strict";
+import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
+import os from "node:os";
+import path from "node:path";
+import { describe, it } from "node:test";
+
+import {
+  ensureCentralInstall,
+  resolveInstallMode,
+  readInstallStamp,
+  INSTALL_STAMP_NAME,
+} from "../../hosts/common/install/ensure-central-install.js";
+import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";
+
+// ---------------------------------------------------------------------------
+// Mode contract: AGENTS_COMM_BUS_BIN is the authoritative source-mode switch;
+// production mode is strict and fails loud on missing install metadata.
+// ---------------------------------------------------------------------------
+
+async function tempRoot(): Promise<string> {
+  return mkdtemp(path.join(os.tmpdir(), "central-install-mode-"));
+}
+
+/** A production plugin dir carrying real bundle payloads + an install stamp. */
+async function fixturedPlugin(comm: string, version: string): Promise<string> {
+  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
+  await writeFile(path.join(dir, "daemon.bundle.js"), `DAEMON_BUNDLE_v${version}`, "utf8");
+  await writeFile(path.join(dir, `${comm}.adapter.bundle.js`), `${comm.toUpperCase()}_ADAPTER_v${version}`, "utf8");
+  await writeFile(
+    path.join(dir, INSTALL_STAMP_NAME),
+    JSON.stringify({
+      schema_version: 1,
+      agent: "claude",
+      comm,
+      plugin_version: version,
+      daemon_bundle_version: version,
+      adapter_bundle_version: version,
+    }),
+    "utf8",
+  );
+  return dir;
+}
+
+describe("resolveInstallMode", () => {
+  it("is source only when AGENTS_COMM_BUS_BIN is set, production otherwise", () => {
+    assert.equal(resolveInstallMode({ AGENTS_COMM_BUS_BIN: "/proj/core/index.js" }), "source");
+    assert.equal(resolveInstallMode({}), "production");
+    assert.equal(resolveInstallMode({ AGENTS_COMM_BUS_ROOT: "/proj/.acb-dev" }), "production"); // ROOT alone is not the switch
+  });
+});
+
+describe("readInstallStamp", () => {
+  it("returns null when the stamp is absent", async () => {
+    const dir = await mkdtemp(path.join(os.tmpdir(), "nostamp-"));
+    assert.equal(await readInstallStamp(dir), null);
+  });
+
+  it("returns null when required version fields are missing", async () => {
+    const dir = await mkdtemp(path.join(os.tmpdir(), "badstamp-"));
+    await writeFile(path.join(dir, INSTALL_STAMP_NAME), JSON.stringify({ agent: "claude", comm: "telegram" }), "utf8");
+    assert.equal(await readInstallStamp(dir), null);
+  });
+
+  it("parses a well-formed stamp", async () => {
+    const dir = await fixturedPlugin("telegram", "1.0.0");
+    const stamp = await readInstallStamp(dir);
+    assert.ok(stamp);
+    assert.equal(stamp.daemon_bundle_version, "1.0.0");
+  });
+});
+
+describe("ensureCentralInstall — source mode", () => {
+  it("skips central install and does NOT call runCentralInstall when AGENTS_COMM_BUS_BIN is set", async () => {
+    const root = await tempRoot();
+    let called = false;
+    const spy = async () => {
+      called = true;
+      return { plan: {} as any, result: {} as any, stoleStale: false };
+    };
+
+    const res = await ensureCentralInstall({
+      stateRoot: root,
+      comm: "telegram",
+      pluginInstallDir: "/irrelevant/in/source/mode",
+      env: { AGENTS_COMM_BUS_BIN: "/proj/core/index.js" },
+      deps: { runCentralInstall: spy },
+    });
+
+    assert.equal(res.mode, "source");
+    assert.equal(res.skipped, true);
+    assert.equal(called, false, "source mode must not run central install");
+  });
+});
+
+describe("ensureCentralInstall — production mode, strict", () => {
+  it("fails loud when pluginInstallDir is unset", async () => {
+    const root = await tempRoot();
+    await assert.rejects(
+      () => ensureCentralInstall({ stateRoot: root, comm: "telegram", env: {} }),
+      /missing or invalid plugin install metadata/,
+    );
+  });
+
+  it("fails loud when the install stamp is absent (does not silently skip)", async () => {
+    const root = await tempRoot();
+    const emptyPlugin = await mkdtemp(path.join(os.tmpdir(), "empty-plugin-"));
+    let called = false;
+    const spy = async () => {
+      called = true;
+      return { plan: {} as any, result: {} as any, stoleStale: false };
+    };
+
+    await assert.rejects(
+      () =>
+        ensureCentralInstall({
+          stateRoot: root,
+          comm: "telegram",
+          pluginInstallDir: emptyPlugin,
+          env: {},
+          deps: { runCentralInstall: spy },
+        }),
+      /missing or invalid plugin install metadata/,
+    );
+    assert.equal(called, false, "must not attempt install when metadata is missing");
+  });
+
+  it("builds the actor from the stamp and lands bundles via the real orchestrator", async () => {
+    const root = await tempRoot();
+    const plugin = await fixturedPlugin("telegram", "1.0.0");
+
+    const res = await ensureCentralInstall({
+      stateRoot: root,
+      pluginInstallDir: plugin,
+      env: {},
+      installedAt: "2026-05-29T00:00:00Z",
+    });
+
+    assert.equal(res.mode, "production");
+    assert.equal(res.actor?.daemonBundleVersion, "1.0.0");
+    assert.equal(res.actor?.pluginVersion, "1.0.0");
+
+    // The real runCentralInstall ran end-to-end: bundles + metadata on disk.
+    const paths = resolveCentralPaths(root, "telegram");
+    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
+    const dv = JSON.parse(await readFile(paths.daemonVersionFile, "utf8"));
+    assert.equal(dv.content_version, "1.0.0");
+  });
+});

````

---

## `2de9a21` — Add stamp non-collapse regression test per review

Production-path version of the T1 regression at the stamp->actor boundary: a
hotfix stamp with higher `plugin_version` (3.0.0) shipping an older daemon bundle
(1.0.0) must not downgrade a daemon installed at 2.0.0. Locks the version-key
invariant at both layers (reconcile and the stamp reader).

````diff
diff --git a/tests/architecture/central-install-mode.test.ts b/tests/architecture/central-install-mode.test.ts
index cac208b..15da813 100644
--- a/tests/architecture/central-install-mode.test.ts
+++ b/tests/architecture/central-install-mode.test.ts
@@ -146,3 +146,55 @@ describe("ensureCentralInstall — production mode, strict", () => {
     assert.equal(dv.content_version, "1.0.0");
   });
 });
+
+describe("ensureCentralInstall — stamp keeps provenance separate from content (regression guard)", () => {
+  it("higher plugin_version shipping an older daemon bundle does not downgrade the installed daemon", async () => {
+    const root = await tempRoot();
+
+    // Seed: production install of daemon bundle 2.0.0.
+    const v2 = await fixturedPlugin("telegram", "2.0.0");
+    await ensureCentralInstall({
+      stateRoot: root,
+      pluginInstallDir: v2,
+      env: {},
+      installedAt: "2026-05-29T00:00:00Z",
+    });
+
+    // Incoming hotfix: HIGHER plugin_version (3.0.0) but an OLDER daemon bundle
+    // (1.0.0). A provenance-keyed rule would wrongly treat it as "newer" and
+    // downgrade the daemon. The stamp's three distinct fields prevent that.
+    const hotfix = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
+    await writeFile(path.join(hotfix, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
+    await writeFile(path.join(hotfix, "telegram.adapter.bundle.js"), "TELEGRAM_ADAPTER_v1.0.0", "utf8");
+    await writeFile(
+      path.join(hotfix, INSTALL_STAMP_NAME),
+      JSON.stringify({
+        schema_version: 1,
+        agent: "claude",
+        comm: "telegram",
+        plugin_version: "3.0.0", // higher provenance
+        daemon_bundle_version: "1.0.0", // older content
+        adapter_bundle_version: "1.0.0",
+      }),
+      "utf8",
+    );
+
+    const res = await ensureCentralInstall({
+      stateRoot: root,
+      pluginInstallDir: hotfix,
+      env: {},
+      installedAt: "2026-05-29T01:00:00Z",
+    });
+
+    // The actor is built from three distinct fields, not a collapsed "version".
+    assert.equal(res.actor?.pluginVersion, "3.0.0");
+    assert.equal(res.actor?.daemonBundleVersion, "1.0.0");
+
+    // Install keyed off the daemon BUNDLE version (1.0.0 < installed 2.0.0) →
+    // no downgrade, regardless of the higher plugin_version.
+    const paths = resolveCentralPaths(root, "telegram");
+    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v2.0.0", "daemon not downgraded");
+    const dv = JSON.parse(await readFile(paths.daemonVersionFile, "utf8"));
+    assert.equal(dv.content_version, "2.0.0");
+  });
+});

````

---

## `df6f660` — Validate stamp schema + resolved actor identity (Codex review)

Closes a production-strict hole: the stamp reader validated only the version
fields, so a stamp missing `agent`/`comm` could flow through to
`adapters/undefined.js`. Now `readInstallStamp` requires `schema_version === 1`,
and `ensureCentralInstall` validates the **resolved** identity
(`options.* ?? stamp.*`) and fails loud before building the actor. Identity is
checked at the resolution boundary (not in the reader) so the legitimate
caller-override case still works. 3 tests.

````diff
diff --git a/hosts/common/install/ensure-central-install.js b/hosts/common/install/ensure-central-install.js
index 7d59df9..942974c 100644
--- a/hosts/common/install/ensure-central-install.js
+++ b/hosts/common/install/ensure-central-install.js
@@ -102,6 +102,7 @@ export async function readInstallStamp(pluginInstallDir, deps = {}) {
     const parsed = JSON.parse(raw);
     if (
       !parsed ||
+      parsed.schema_version !== 1 ||
       typeof parsed.plugin_version !== "string" ||
       typeof parsed.daemon_bundle_version !== "string" ||
       typeof parsed.adapter_bundle_version !== "string"
@@ -139,10 +140,29 @@ export async function ensureCentralInstall(options) {
     );
   }
 
+  // Resolve actor identity (caller override wins, else the stamp) and validate
+  // it before building the actor. Production-strict: an unresolved agent/comm
+  // must fail loud, never flow into runCentralInstall and write paths like
+  // adapters/undefined.js or metadata with an undefined comm.
+  const resolvedAgent = options.agent ?? stamp.agent;
+  const resolvedComm = options.comm ?? stamp.comm;
+  if (
+    typeof resolvedAgent !== "string" ||
+    resolvedAgent.length === 0 ||
+    typeof resolvedComm !== "string" ||
+    resolvedComm.length === 0
+  ) {
+    throw new Error(
+      `central install (production mode): install stamp resolved an invalid actor identity ` +
+        `(agent=${JSON.stringify(resolvedAgent)}, comm=${JSON.stringify(resolvedComm)}). ` +
+        `The stamp must carry agent + comm, or the caller must supply them.`,
+    );
+  }
+
   /** @type {import("./reconcile-central-install.js").InstallActor} */
   const actor = {
-    agent: /** @type {any} */ (options.agent ?? stamp.agent),
-    comm: options.comm ?? stamp.comm,
+    agent: /** @type {any} */ (resolvedAgent),
+    comm: resolvedComm,
     pluginVersion: stamp.plugin_version,
     daemonBundleVersion: stamp.daemon_bundle_version,
     adapterBundleVersion: stamp.adapter_bundle_version,
diff --git a/tests/architecture/central-install-mode.test.ts b/tests/architecture/central-install-mode.test.ts
index 15da813..044c3f0 100644
--- a/tests/architecture/central-install-mode.test.ts
+++ b/tests/architecture/central-install-mode.test.ts
@@ -61,6 +61,23 @@ describe("readInstallStamp", () => {
     assert.equal(await readInstallStamp(dir), null);
   });
 
+  it("returns null when schema_version is not 1", async () => {
+    const dir = await mkdtemp(path.join(os.tmpdir(), "badschema-"));
+    await writeFile(
+      path.join(dir, INSTALL_STAMP_NAME),
+      JSON.stringify({
+        schema_version: 2,
+        agent: "claude",
+        comm: "telegram",
+        plugin_version: "1.0.0",
+        daemon_bundle_version: "1.0.0",
+        adapter_bundle_version: "1.0.0",
+      }),
+      "utf8",
+    );
+    assert.equal(await readInstallStamp(dir), null);
+  });
+
   it("parses a well-formed stamp", async () => {
     const dir = await fixturedPlugin("telegram", "1.0.0");
     const stamp = await readInstallStamp(dir);
@@ -124,6 +141,65 @@ describe("ensureCentralInstall — production mode, strict", () => {
     assert.equal(called, false, "must not attempt install when metadata is missing");
   });
 
+  it("fails loud when the stamp lacks agent/comm and the caller supplies none", async () => {
+    const root = await tempRoot();
+    // Valid versions + schema, but NO agent/comm in the stamp.
+    const dir = await mkdtemp(path.join(os.tmpdir(), "noident-"));
+    await writeFile(path.join(dir, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
+    await writeFile(path.join(dir, "telegram.adapter.bundle.js"), "TG", "utf8");
+    await writeFile(
+      path.join(dir, INSTALL_STAMP_NAME),
+      JSON.stringify({
+        schema_version: 1,
+        plugin_version: "1.0.0",
+        daemon_bundle_version: "1.0.0",
+        adapter_bundle_version: "1.0.0",
+      }),
+      "utf8",
+    );
+    let called = false;
+    const spy = async () => {
+      called = true;
+      return { plan: {} as any, result: {} as any, stoleStale: false };
+    };
+
+    await assert.rejects(
+      () => ensureCentralInstall({ stateRoot: root, pluginInstallDir: dir, env: {}, deps: { runCentralInstall: spy } }),
+      /invalid actor identity/,
+    );
+    assert.equal(called, false, "must not run install with an unresolved actor");
+  });
+
+  it("accepts caller-supplied agent/comm overriding a stamp that omits them", async () => {
+    const root = await tempRoot();
+    const dir = await mkdtemp(path.join(os.tmpdir(), "ident-override-"));
+    await writeFile(path.join(dir, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
+    await writeFile(path.join(dir, "telegram.adapter.bundle.js"), "TELEGRAM_ADAPTER_v1.0.0", "utf8");
+    await writeFile(
+      path.join(dir, INSTALL_STAMP_NAME),
+      JSON.stringify({
+        schema_version: 1,
+        plugin_version: "1.0.0",
+        daemon_bundle_version: "1.0.0",
+        adapter_bundle_version: "1.0.0",
+      }),
+      "utf8",
+    );
+
+    const res = await ensureCentralInstall({
+      stateRoot: root,
+      agent: "claude",
+      comm: "telegram",
+      pluginInstallDir: dir,
+      env: {},
+      installedAt: "2026-05-29T00:00:00Z",
+    });
+    assert.equal(res.mode, "production");
+    assert.equal(res.actor?.comm, "telegram");
+    const paths = resolveCentralPaths(root, "telegram");
+    assert.equal(await readFile(paths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");
+  });
+
   it("builds the actor from the stamp and lands bundles via the real orchestrator", async () => {
     const root = await tempRoot();
     const plugin = await fixturedPlugin("telegram", "1.0.0");

````

---

## `34670d8` — Mark InstallStamp agent/comm optional in JSDoc (Codex note)

Doc-only. The implementation intentionally allows the caller to supply
`agent`/`comm`, but the `InstallStamp` typedef marked them required. Loosen the
JSDoc to match the contract; no behavior change.

````diff
diff --git a/hosts/common/install/ensure-central-install.js b/hosts/common/install/ensure-central-install.js
index 942974c..08b0256 100644
--- a/hosts/common/install/ensure-central-install.js
+++ b/hosts/common/install/ensure-central-install.js
@@ -41,8 +41,8 @@ export const INSTALL_STAMP_NAME = "install-stamp.json";
  *
  * @typedef {Object} InstallStamp
  * @property {number} schema_version
- * @property {string} agent
- * @property {string} comm
+ * @property {string} [agent]   identity; may be omitted if the caller supplies options.agent
+ * @property {string} [comm]    identity; may be omitted if the caller supplies options.comm
  * @property {string} plugin_version          provenance only
  * @property {string} daemon_bundle_version   bin/daemon.js replace key
  * @property {string} adapter_bundle_version  adapters/<comm>.js replace key

````

---

## Appendix A — post-`34670d8` commits on `universal-overhaul`

Append-only note: everything above this appendix is intentionally left untouched,
including the existing inline `human comment:` annotations and the original
`6163e96..34670d8` foundation narrative.

These are the follow-on `universal-overhaul` commits that landed after the
original foundation cutoff and before the AGE-13 merge.

### `996a323` — Add annotated unified diff of central-install foundation

Bootstrap commit for this very document. It materialized the annotated
`6163e96..34670d8` write-up as a tracked artifact so later follow-on notes could
append here instead of rewriting the earlier sections.

### `9a8b535` — Instrument Codex wake and steer app server turns

Adds diagnostic visibility around the Codex app-server wake/steer path. This is
operational tracing, not central-install activation, but it landed on the same
branch arc while the daemon/control-plane work was still moving.

### `c562a16` — Set SQLite `busy_timeout` to stop dropped inbound under multi-bot writes

Hardens the daemon's SQLite behavior under concurrent writer pressure. The
practical effect is to wait for the lock instead of failing fast and silently
losing inbound work during overlapping multi-bot activity.

### `04e9fb4` — Scope `comm_check_messages` drain by the caller's owned accounts

Narrows message draining to the accounts actually owned by the caller, so one
agent's inbound poll/drain cannot accidentally consume another agent's queued
messages just because they share a daemon.

### `c38a3c7` — Audit inbound dispatch bridge flow

Follow-up inspection/repair pass on the inbound dispatch path: make the bridge
flow more explicit, easier to reason about, and safer to verify when multi-agent
traffic shares the same daemon.

### `42ab787` — Rebuild daemon dist for `04e9fb4` + `c38a3c7`

Generated-artifact sync commit. Important only because the tracked daemon dist
must match the source-side inbound-drain / bridge-flow changes that landed just
before it.

### `fd36433` — Add `restart-daemon.ps1` to reap ALL stale `serve.js` daemons

Operational cleanup tool for Windows dev/test loops. Gives a deterministic way
to kill stale daemon processes before restart instead of relying on narrower
single-pid assumptions.

### `21d6d44` — Harden daemon pid watchdog cleanup

Strengthens the watchdog path so stale/incorrect process cleanup is less likely
to leave a bad daemon ownership state behind.

### `92a9d34` — Run daemon pid watchdog tests in package suite

Promotes the watchdog coverage into the package test suite so the cleanup logic
stays exercised by the normal verification path rather than drifting as a
one-off script concern.

### `fdcfc17` — Document workspace dev marker for central install

Documents the dev-marker/source-mode contract that AGE-13 depends on: a
workspace-local marker resolves into env-shaped overrides (`AGENTS_COMM_BUS_BIN`
and, when present, the workspace state root) so dev sessions skip the production
central-install path while still exercising the same top-level ensure entry.

---

## Appendix B — AGE-13 branch arc (`age-13-central-install-wiring`)

This branch was reviewed as a separate arc and is now merged into
`universal-overhaul` via `29197e4`. During review it was the "branch / pending
merge" slice; this appendix preserves that chronology while also recording the
actual landing commit.

### `6777606` — AGE-13 step 1: dev-config resolver (gitignored marker -> validated env)

Introduces the repo-local dev marker reader/validator and turns it into the
resolved env overrides that source-mode entrypoints consume. This is the piece
that lets dev installs stay source-backed without pretending a staged central
install exists.

### `c889fb8` — AGE-13 step 2: install-stamp emission (source) — independent adapter version

Adds install-stamp emission as the plugin-side input artifact for production
installs, including separate daemon/adapter bundle version tracking so the
central install can key replacement on the blob's own version rather than the
plugin version.

### `df554f6` — AGE-13 step 3 (part 1): `entryEnsures` — canonical ensure path

Creates the single shared host-edge ensure entrypoint so hooks and MCP shims stop
open-coding `ensureCentralInstall(...)` + `ensureDaemon(...)` themselves.

### `8727ea7` — AGE-13 step 3 (part 1b): entry-path resolver for `entryEnsures`

Adds the symmetric ancestor walk for the dev marker and `install-stamp.json` so
an entrypoint can derive both `projectRoot` and `pluginInstallDir` from its own
location without duplicating path logic.

### `47c5c55` — AGE-13 step 3 (part 2a): dev-marker template + actionable production error

Rounds out the operator experience: example dev marker, clearer production error
when install metadata is missing, and safer handoff between source-mode and
production-mode expectations.

### `6f1d516` — AGE-13 step 3 (final): wire all entrypoints to `entryEnsures` + subprocess proof

Hooks and shims now actually call the canonical ensure path, and the test suite
adds subprocess coverage so the real-wired entrypoint shape is exercised instead
of only unit-level seams.

### `2d4539e` — AGE-13 step 3 (blocker fix): canonical `stateRoot` in `entryEnsures`

Acceptance-review blocker fix. `entryEnsures` now derives one canonical state
root and feeds that SAME root to both `ensureCentralInstall` and `ensureDaemon`:
explicit option first, then resolved `AGENTS_COMM_BUS_ROOT`, then the daemon's
own default-root resolver. This closes the real production crash where
live hooks/shim called `entryEnsures` without an explicit `stateRoot` and the
central-install path hit `path.join(undefined, ...)`.

The corresponding tests now cover:
- env-derived root with no explicit `stateRoot`
- injected daemon-default fallback
- dev-marker-provided root reaching both install + daemon ensure
- subprocess proof in the real wired-hook shape

### `29197e4` — Merge branch `age-13-central-install-wiring` into `universal-overhaul`

Records the branch landing. After this merge, the AGE-13 wiring arc is no longer
just a reviewed side branch; it is part of `universal-overhaul` proper.

---

## Deferred follow-ups noted during review

- Previously-tracked AGE-14 follow-up: deterministic artifact restage /
  toolchain pin work remains intentionally deferred and is not part of the
  branch merge above.
- AGE-16 inbound-attribution follow-up has now been filed separately as issue
  #34: <https://github.com/remingtonspaz/agents-comm-bus/issues/34>.
