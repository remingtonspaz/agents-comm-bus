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

_human comment: what does the last parenthesis mean for the daemon? Does "all adapters share same daemon binary" still hold true?_

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

_human comment: Q: what does the install stamp add that the installed_by section of the metadata in the install model doc doesn't cover? Does the stamp supersede this section?_

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

# Appendix -- central-install work since `34670d8` (added 2026-05-30)

Extends the original `6163e96..34670d8` foundation diff above to cover everything that has since landed on `universal-overhaul`, through `2d4539e`. This spans two groups: (1) post-foundation reliability / operational hardening, and (2) the central-install wiring arc (AGE-13), which was developed on `age-13-central-install-wiring` and **merged to `universal-overhaul` (fast-forward to `2d4539e`) on 2026-05-30** after two-reviewer acceptance. The committed-artifact restage + esbuild bundle rebuild remain deferred to **AGE-14**.

For readability across ~16 commits (several carrying large generated `dist/` rebuilds), each entry shows a `--stat` plus a **source-only** diff (generated `dist/**` and `plugins/**` excluded). The original sections above keep their full per-commit diffs.

## Group 1 -- reliability / operational hardening (post-34670d8)

---

### `996a323` -- Add annotated unified diff of central-install foundation

(see commit subject)

_Files (stat):_

```
 ...29-central-install-foundation-annotated-diff.md | 2571 ++++++++++++++++++++
 1 file changed, 2571 insertions(+)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/docs/2026-05-29-central-install-foundation-annotated-diff.md b/docs/2026-05-29-central-install-foundation-annotated-diff.md
new file mode 100644
index 0000000..2cbe06e
--- /dev/null
+++ b/docs/2026-05-29-central-install-foundation-annotated-diff.md
@@ -0,0 +1,2571 @@
+# Central-install foundation — annotated diff
+
+Unified + annotated diff of every change on `universal-overhaul` since
+`6163e96` (the daemon-token-file doc commit), through `34670d8`.
+
+This range is the **Model B central-install foundation**, built test-design-first
+per the design thread: the reconciliation/execution/locking/mode machinery for
+the future `~/.agents-comm-bus/{bin,adapters}` central install, plus its docs and
+tests. **None of it is wired into the live `ensureDaemon` paths yet** — the dev
+loop is untouched. Dual-reviewed (Codex + Hermes LGTM) as the foundation
+checkpoint before the activation phase.
+
+Remaining (not in this range, deliberate next steps that flip live behavior):
+1. emit `install-stamp.json` from the stage/assemble scripts into real plugin artifacts
+2. wire `ensureCentralInstall(...)` into the `ensureDaemon` callers (hooks + MCP shim),
+   landing together with `AGENTS_COMM_BUS_BIN` set in dev configs so dev sessions
+   take the source-mode skip.
+
+## File inventory
+
+```
+ agents-comm-bus/package.json                       |   2 +-
+ docs/research/install-model.md                     | 226 +++++++++++--
+ hosts/common/install/ensure-central-install.js     | 181 ++++++++++
+ hosts/common/install/install-lock.js               | 118 +++++++
+ hosts/common/install/node-fs-seam.js               | 117 +++++++
+ hosts/common/install/reconcile-central-install.js  | 363 +++++++++++++++++++++
+ hosts/common/install/run-central-install.js        |  58 ++++
+ .../central-install-concurrency.test.ts            | 207 ++++++++++++
+ tests/architecture/central-install-execute.test.ts | 241 ++++++++++++++
+ tests/architecture/central-install-mode.test.ts    | 276 ++++++++++++++++
+ .../architecture/central-install-reconcile.test.ts | 262 +++++++++++++++
+ 11 files changed, 2027 insertions(+), 24 deletions(-)
+```
+
+## How to read this
+
+Organized by commit in chronological order. Each section is one commit:
+a short annotation of **what** it changes and **why**, followed by that commit's
+unified diff in a fenced block. The sum of the per-commit diffs equals the full
+`6163e96..34670d8` range diff. Diffs use four-backtick fences because the
+in-range `install-model.md` diff itself contains triple-backtick code blocks.
+
+## Annotated commits
+
+---
+
+## `3e886b1` — Add central-install reconciliation seam + T1 tests
+
+Introduces the **pure decision layer**. `reconcile-central-install.js` defines
+`reconcileInstall(actor, state) -> plan` (no I/O, fully deterministic) separate
+from `executeInstallPlan(plan, actor, paths, fs)` (effects via an injected fs
+seam) — mirroring the `ensure-daemon.ts` dependency-injection style. Locks the
+core rules: blob replacement keys on the **bundle's own version**
+(`daemonBundleVersion`/`adapterBundleVersion`), never `plugin_version`;
+`installed_by` reference-counting keyed on `(agent, comm)`; idempotent re-run,
+no-downgrade, provenance-merge-only on equal/older. T1 tests include the headline
+regression: a higher-`plugin_version` hotfix carrying an older daemon bundle must
+not replace a newer installed daemon.
+
+````diff
+diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
+index 57f8289..b886785 100644
+--- a/agents-comm-bus/package.json
++++ b/agents-comm-bus/package.json
+@@ -27,7 +27,7 @@
+   "scripts": {
+     "build": "tsc && node scripts/copy-assets.js",
+     "typecheck": "tsc --noEmit",
+-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\""
++    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\""
+   },
+   "engines": { "node": ">=22" },
+   "dependencies": {
+diff --git a/hosts/common/install/reconcile-central-install.js b/hosts/common/install/reconcile-central-install.js
+new file mode 100644
+index 0000000..32375d3
+--- /dev/null
++++ b/hosts/common/install/reconcile-central-install.js
+@@ -0,0 +1,346 @@
++/**
++ * Central-install reconciliation seam (host-edge, agent-agnostic).
++ *
++ * This is the shared library boundary the per-agent install hooks delegate to.
++ * It mirrors the dependency-injection discipline of
++ * `core-daemon/bootstrap/ensure-daemon.ts`: a PURE decision function
++ * (`reconcileInstall`) that takes the installing plugin's identity + the
++ * current on-disk central-install state and returns a *plan*, kept separate
++ * from `executeInstallPlan`, which performs the actual filesystem effects
++ * against an injected `fs` seam. That split is what makes the four-layer test
++ * model cheap:
++ *   - T1: drive `reconcileInstall` with plain objects (this file; no I/O).
++ *   - T2: drive `executeInstallPlan` against a temp state root.
++ *   - T3: race many reconcile+execute pairs against one temp root.
++ *   - T4: run the real install hook in a subprocess against temp HOME.
++ *
++ * Versioning invariant (see install-model.md "Version metadata policy"):
++ * the replace decision for a shared blob keys on that blob's OWN version
++ * (`daemonBundleVersion` / `adapterBundleVersion`), NEVER on `pluginVersion`.
++ * `pluginVersion` is provenance only. This prevents an adapter-side plugin
++ * hotfix (higher plugin_version) that re-bundles an OLDER daemon from silently
++ * downgrading a newer installed daemon.
++ *
++ * Reference counting: a single `bin/daemon.js` is shared across every comm
++ * plugin of every agent. The reference unit is therefore `(agent, comm)`, not
++ * `agent` alone — claude-telegram and claude-matrix are two independent
++ * references to the same daemon blob. `installed_by` entries are keyed on
++ * `(agent, comm)` so uninstalling one comm plugin doesn't drop the daemon's
++ * reference held by another comm plugin of the same agent.
++ *
++ * @typedef {"claude" | "codex"} AgentId
++ * @typedef {"daemon" | "adapter"} ContentKind
++ *
++ * @typedef {Object} InstallActor
++ * @property {AgentId} agent
++ * @property {string} comm                  e.g. "telegram"
++ * @property {string} pluginVersion         provenance only — NOT a replace key
++ * @property {string} daemonBundleVersion   replace key for bin/daemon.js
++ * @property {string} adapterBundleVersion  replace key for adapters/<comm>.js
++ * @property {string} [pluginInstallDir]    source dir for bundle bytes (used by execute)
++ * @property {string} installedAt           ISO timestamp, injected (keeps reconcile pure)
++ *
++ * @typedef {Object} ProvenanceEntry
++ * @property {AgentId} agent
++ * @property {string} comm
++ * @property {string} plugin_version
++ * @property {string} bundle_version
++ * @property {string} installed_at
++ *
++ * @typedef {Object} VersionRecord   the parsed content of a *.version.json file
++ * @property {number} schema_version
++ * @property {string} content_version   the installed blob's own version (highest-wins key)
++ * @property {ContentKind} content_kind
++ * @property {string} [content_id]      <comm> for adapters; absent for the daemon
++ * @property {ProvenanceEntry} content_source   which plugin laid down the current blob
++ * @property {ProvenanceEntry[]} installed_by   reference set, keyed by (agent, comm)
++ *
++ * @typedef {Object} CentralState
++ * @property {boolean} daemonExists                bin/daemon.js present on disk
++ * @property {VersionRecord | null} daemonVersionFile
++ * @property {boolean} adapterExists               adapters/<actor.comm>.js present on disk
++ * @property {VersionRecord | null} adapterVersionFile
++ * @property {boolean} daemonRunning               a live daemon answered discovery
++ *
++ * @typedef {Object} ArtifactPlan
++ * @property {boolean} writeBundle          copy the plugin's bundle into the central path
++ * @property {boolean} writeVersionFile     (re)write the *.version.json metadata
++ * @property {boolean} contentReplaced      the installed blob version changed
++ * @property {string} resultingContentVersion
++ * @property {VersionRecord} resultingVersionFile   metadata to persist (merged provenance)
++ * @property {string[]} reasons
++ *
++ * @typedef {Object} ReconcilePlan
++ * @property {ArtifactPlan} daemon
++ * @property {ArtifactPlan} adapter
++ * @property {boolean} requiresSpawn            no live daemon — caller must spawn
++ * @property {boolean} requiresDaemonRestart    daemon blob changed under a live daemon
++ * @property {boolean} requiresAdapterReload    adapter blob added/changed under a live daemon
++ * @property {string[]} reasons
++ */
++
++export const VERSION_FILE_SCHEMA = 1;
++
++/**
++ * Pure decision function. No I/O. Deterministic given its inputs (timestamps
++ * are supplied via `actor.installedAt`, never read from the clock here).
++ *
++ * @param {InstallActor} actor
++ * @param {CentralState} state
++ * @returns {ReconcilePlan}
++ */
++export function reconcileInstall(actor, state) {
++  const daemon = reconcileArtifact("daemon", actor, state.daemonVersionFile, state.daemonExists, undefined);
++  const adapter = reconcileArtifact("adapter", actor, state.adapterVersionFile, state.adapterExists, actor.comm);
++
++  const requiresSpawn = !state.daemonRunning;
++  const requiresDaemonRestart = state.daemonRunning && daemon.contentReplaced;
++  const requiresAdapterReload = state.daemonRunning && adapter.contentReplaced;
++
++  return {
++    daemon,
++    adapter,
++    requiresSpawn,
++    requiresDaemonRestart,
++    requiresAdapterReload,
++    reasons: [...daemon.reasons, ...adapter.reasons],
++  };
++}
++
++/**
++ * @param {ContentKind} kind
++ * @param {InstallActor} actor
++ * @param {VersionRecord | null} existing
++ * @param {boolean} bundleExists
++ * @param {string | undefined} contentId
++ * @returns {ArtifactPlan}
++ */
++function reconcileArtifact(kind, actor, existing, bundleExists, contentId) {
++  const incomingVersion = kind === "daemon" ? actor.daemonBundleVersion : actor.adapterBundleVersion;
++  const entry = makeEntry(actor, kind);
++
++  // Cold: nothing recorded yet for this artifact.
++  if (!existing) {
++    /** @type {VersionRecord} */
++    const record = {
++      schema_version: VERSION_FILE_SCHEMA,
++      content_version: incomingVersion,
++      content_kind: kind,
++      ...(contentId ? { content_id: contentId } : {}),
++      content_source: entry,
++      installed_by: [entry],
++    };
++    return {
++      writeBundle: true,
++      writeVersionFile: true,
++      contentReplaced: true,
++      resultingContentVersion: incomingVersion,
++      resultingVersionFile: record,
++      reasons: [`cold install: no existing ${kind}`],
++    };
++  }
++
++  const { list, changed } = upsertInstalledBy(existing.installed_by, entry);
++  /** @type {VersionRecord} */
++  const record = { ...existing, installed_by: list };
++  const reasons = [];
++  let writeBundle = false;
++  let contentReplaced = false;
++
++  const cmp = compareVersions(incomingVersion, existing.content_version);
++  if (cmp > 0) {
++    // Genuine upgrade — incoming blob is newer than what's installed.
++    writeBundle = true;
++    contentReplaced = true;
++    record.content_version = incomingVersion;
++    record.content_source = entry;
++    reasons.push(`upgrade ${kind}: incoming ${incomingVersion} > installed ${existing.content_version}`);
++  } else if (cmp === 0) {
++    reasons.push(`no content change: incoming ${kind} equals installed ${incomingVersion}`);
++    if (!bundleExists) {
++      // Metadata says this version is installed but the blob is gone — restore it.
++      writeBundle = true;
++      reasons.push(`recovery: ${kind} blob missing on disk, rewriting at installed version`);
++    }
++  } else {
++    // Older incoming blob. THE REGRESSION GUARD: this branch is reached even
++    // when actor.pluginVersion > content_source.plugin_version, because the
++    // comparison keys on the blob version, not the plugin version.
++    reasons.push(`no downgrade: incoming ${kind} ${incomingVersion} < installed ${existing.content_version}`);
++    if (!bundleExists) {
++      // Recorded-newer blob is missing and we only carry an older one. Restore
++      // the older blob rather than leave the artifact unusable — an explicit,
++      // logged downgrade-on-recovery, distinct from a normal install path.
++      writeBundle = true;
++      contentReplaced = true;
++      record.content_version = incomingVersion;
++      record.content_source = entry;
++      reasons.push(`recovery: ${kind} blob missing and only older bundle available; restoring at ${incomingVersion}`);
++    }
++  }
++
++  return {
++    writeBundle,
++    writeVersionFile: changed || contentReplaced,
++    contentReplaced,
++    resultingContentVersion: record.content_version,
++    resultingVersionFile: record,
++    reasons,
++  };
++}
++
++/**
++ * Upsert a provenance entry keyed on (agent, comm). Returns the new list and
++ * whether anything meaningful changed. An entry whose (plugin_version,
++ * bundle_version) is unchanged is a no-op (its installed_at is preserved) so a
++ * re-run of the same install is idempotent and does not churn the file.
++ *
++ * @param {ProvenanceEntry[]} list
++ * @param {ProvenanceEntry} entry
++ * @returns {{ list: ProvenanceEntry[], changed: boolean }}
++ */
++function upsertInstalledBy(list, entry) {
++  const idx = list.findIndex((e) => e.agent === entry.agent && e.comm === entry.comm);
++  if (idx === -1) {
++    return { list: [...list, entry], changed: true };
++  }
++  const prev = list[idx];
++  if (prev.plugin_version === entry.plugin_version && prev.bundle_version === entry.bundle_version) {
++    return { list, changed: false };
++  }
++  const next = list.slice();
++  next[idx] = entry;
++  return { list: next, changed: true };
++}
++
++/**
++ * @param {InstallActor} actor
++ * @param {ContentKind} kind
++ * @returns {ProvenanceEntry}
++ */
++function makeEntry(actor, kind) {
++  return {
++    agent: actor.agent,
++    comm: actor.comm,
++    plugin_version: actor.pluginVersion,
++    bundle_version: kind === "daemon" ? actor.daemonBundleVersion : actor.adapterBundleVersion,
++    installed_at: actor.installedAt,
++  };
++}
++
++/**
++ * Release-version comparison ("semver-ish"). Compares dotted numeric
++ * components; prerelease suffixes (after `-`) are stripped — full prerelease
++ * ordering is out of scope for v1. Non-numeric components fall back to string
++ * comparison per component.
++ *
++ * @param {string} a
++ * @param {string} b
++ * @returns {-1 | 0 | 1}
++ */
++export function compareVersions(a, b) {
++  const pa = parseVersion(a);
++  const pb = parseVersion(b);
++  const n = Math.max(pa.length, pb.length);
++  for (let i = 0; i < n; i++) {
++    const x = pa[i] ?? 0;
++    const y = pb[i] ?? 0;
++    if (typeof x === "number" && typeof y === "number") {
++      if (x !== y) return x < y ? -1 : 1;
++    } else {
++      const xs = String(x);
++      const ys = String(y);
++      if (xs !== ys) return xs < ys ? -1 : 1;
++    }
++  }
++  return 0;
++}
++
++/**
++ * @param {string} v
++ * @returns {Array<number | string>}
++ */
++function parseVersion(v) {
++  return String(v)
++    .split("-")[0]
++    .split(".")
++    .map((s) => {
++      const num = Number(s);
++      return Number.isInteger(num) ? num : s;
++    });
++}
++
++/**
++ * Minimal filesystem seam used by `executeInstallPlan`. Injectable so tests
++ * can drive execution against a temp root (T2) or a fake (T3) without touching
++ * the real `~/.agents-comm-bus/`.
++ *
++ * @typedef {Object} FsSeam
++ * @property {(dir: string) => Promise<void>} mkdirp
++ * @property {(from: string, to: string) => Promise<void>} copyFile
++ * @property {(file: string, data: string) => Promise<void>} writeFile
++ *
++ * @typedef {Object} CentralPaths
++ * @property {string} daemonBundle        target path for bin/daemon.js
++ * @property {string} daemonVersionFile   target path for bin/version.json
++ * @property {string} adapterBundle       target path for adapters/<comm>.js
++ * @property {string} adapterVersionFile  target path for adapters/<comm>.version.json
++ *
++ * @typedef {Object} ExecutionResult
++ * @property {string[]} wroteBundles
++ * @property {string[]} wroteVersionFiles
++ */
++
++/**
++ * Reference executor for the plan. Kept intentionally thin: it only performs
++ * the writes the plan asked for. Spawn / restart / reload are the caller's
++ * responsibility (they depend on the runtime daemon connection, not the fs).
++ *
++ * @param {ReconcilePlan} plan
++ * @param {InstallActor} actor
++ * @param {CentralPaths} paths
++ * @param {FsSeam} fs
++ * @returns {Promise<ExecutionResult>}
++ */
++export async function executeInstallPlan(plan, actor, paths, fs) {
++  const wroteBundles = [];
++  const wroteVersionFiles = [];
++  const daemonSrc = actor.pluginInstallDir ? `${actor.pluginInstallDir}/daemon.bundle.js` : null;
++  const adapterSrc = actor.pluginInstallDir
++    ? `${actor.pluginInstallDir}/${actor.comm}.adapter.bundle.js`
++    : null;
++
++  if (plan.daemon.writeBundle && daemonSrc) {
++    await fs.mkdirp(dirname(paths.daemonBundle));
++    await fs.copyFile(daemonSrc, paths.daemonBundle);
++    wroteBundles.push(paths.daemonBundle);
++  }
++  if (plan.daemon.writeVersionFile) {
++    await fs.mkdirp(dirname(paths.daemonVersionFile));
++    await fs.writeFile(paths.daemonVersionFile, serialize(plan.daemon.resultingVersionFile));
++    wroteVersionFiles.push(paths.daemonVersionFile);
++  }
++  if (plan.adapter.writeBundle && adapterSrc) {
++    await fs.mkdirp(dirname(paths.adapterBundle));
++    await fs.copyFile(adapterSrc, paths.adapterBundle);
++    wroteBundles.push(paths.adapterBundle);
++  }
++  if (plan.adapter.writeVersionFile) {
++    await fs.mkdirp(dirname(paths.adapterVersionFile));
++    await fs.writeFile(paths.adapterVersionFile, serialize(plan.adapter.resultingVersionFile));
++    wroteVersionFiles.push(paths.adapterVersionFile);
++  }
++
++  return { wroteBundles, wroteVersionFiles };
++}
++
++/** @param {VersionRecord} record */
++function serialize(record) {
++  return `${JSON.stringify(record, null, 2)}\n`;
++}
++
++/** @param {string} p */
++function dirname(p) {
++  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
++  return i === -1 ? "." : p.slice(0, i);
++}
+diff --git a/tests/architecture/central-install-reconcile.test.ts b/tests/architecture/central-install-reconcile.test.ts
+new file mode 100644
+index 0000000..ade74e4
+--- /dev/null
++++ b/tests/architecture/central-install-reconcile.test.ts
+@@ -0,0 +1,221 @@
++import assert from "node:assert/strict";
++import { describe, it } from "node:test";
++
++import {
++  reconcileInstall,
++  compareVersions,
++  VERSION_FILE_SCHEMA,
++} from "../../hosts/common/install/reconcile-central-install.js";
++
++// ---------------------------------------------------------------------------
++// Builders — keep each test readable by defaulting the boring fields.
++// ---------------------------------------------------------------------------
++
++type Agent = "claude" | "codex";
++
++interface ActorOverrides {
++  agent?: Agent;
++  comm?: string;
++  pluginVersion?: string;
++  daemonBundleVersion?: string;
++  adapterBundleVersion?: string;
++  installedAt?: string;
++}
++
++function actor(o: ActorOverrides = {}) {
++  return {
++    agent: o.agent ?? "claude",
++    comm: o.comm ?? "telegram",
++    pluginVersion: o.pluginVersion ?? "1.0.0",
++    daemonBundleVersion: o.daemonBundleVersion ?? "1.0.0",
++    adapterBundleVersion: o.adapterBundleVersion ?? "1.0.0",
++    pluginInstallDir: "/fake/plugin",
++    installedAt: o.installedAt ?? "2026-05-18T20:25:00Z",
++  };
++}
++
++const EMPTY_STATE = {
++  daemonExists: false,
++  daemonVersionFile: null,
++  adapterExists: false,
++  adapterVersionFile: null,
++  daemonRunning: false,
++};
++
++/** Apply a plan's resulting metadata back into a CentralState, as execute would. */
++function applied(state: any, plan: any) {
++  return {
++    daemonExists: state.daemonExists || plan.daemon.writeBundle,
++    daemonVersionFile: plan.daemon.writeVersionFile ? plan.daemon.resultingVersionFile : state.daemonVersionFile,
++    adapterExists: state.adapterExists || plan.adapter.writeBundle,
++    adapterVersionFile: plan.adapter.writeVersionFile ? plan.adapter.resultingVersionFile : state.adapterVersionFile,
++    daemonRunning: state.daemonRunning,
++  };
++}
++
++// ---------------------------------------------------------------------------
++// T1 — pure reconciliation logic
++// ---------------------------------------------------------------------------
++
++describe("compareVersions", () => {
++  it("orders dotted release versions numerically", () => {
++    assert.equal(compareVersions("2.0.0", "1.0.0"), 1);
++    assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
++    assert.equal(compareVersions("1.2.0", "1.10.0"), -1); // numeric, not lexical
++    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
++  });
++});
++
++describe("reconcileInstall — cold install", () => {
++  it("lays down daemon + adapter from empty state", () => {
++    const plan = reconcileInstall(actor(), EMPTY_STATE);
++
++    assert.equal(plan.daemon.writeBundle, true);
++    assert.equal(plan.daemon.writeVersionFile, true);
++    assert.equal(plan.adapter.writeBundle, true);
++    assert.equal(plan.adapter.writeVersionFile, true);
++    assert.equal(plan.requiresSpawn, true); // no daemon running yet
++
++    const dv = plan.daemon.resultingVersionFile;
++    assert.equal(dv.schema_version, VERSION_FILE_SCHEMA);
++    assert.equal(dv.content_kind, "daemon");
++    assert.equal(dv.content_version, "1.0.0");
++    assert.equal(dv.installed_by.length, 1);
++
++    const av = plan.adapter.resultingVersionFile;
++    assert.equal(av.content_kind, "adapter");
++    assert.equal(av.content_id, "telegram");
++  });
++});
++
++describe("reconcileInstall — idempotency", () => {
++  it("same actor rerun is a no-op (no bundle copy, no version rewrite)", () => {
++    const first = reconcileInstall(actor(), EMPTY_STATE);
++    const state2 = applied(EMPTY_STATE, first);
++
++    // Rerun, but a later timestamp must NOT cause churn on its own.
++    const second = reconcileInstall(actor({ installedAt: "2026-05-20T00:00:00Z" }), state2);
++
++    assert.equal(second.daemon.writeBundle, false);
++    assert.equal(second.daemon.writeVersionFile, false);
++    assert.equal(second.adapter.writeBundle, false);
++    assert.equal(second.adapter.writeVersionFile, false);
++  });
++});
++
++describe("reconcileInstall — second agent, same comm, same versions", () => {
++  it("merges installed_by without rewriting the blob", () => {
++    const first = reconcileInstall(actor({ agent: "claude" }), EMPTY_STATE);
++    const state2 = applied(EMPTY_STATE, first);
++
++    const second = reconcileInstall(actor({ agent: "codex" }), state2);
++
++    assert.equal(second.daemon.writeBundle, false, "same bundle version -> no recopy");
++    assert.equal(second.daemon.writeVersionFile, true, "provenance changed -> rewrite metadata");
++    assert.equal(second.daemon.resultingVersionFile.content_version, "1.0.0");
++    assert.equal(second.daemon.resultingVersionFile.installed_by.length, 2);
++    const agents = second.daemon.resultingVersionFile.installed_by.map((e: any) => e.agent).sort();
++    assert.deepEqual(agents, ["claude", "codex"]);
++  });
++});
++
++describe("reconcileInstall — upgrade", () => {
++  it("newer daemon bundle replaces the installed one", () => {
++    const first = reconcileInstall(actor({ daemonBundleVersion: "1.0.0" }), EMPTY_STATE);
++    const state2 = applied(EMPTY_STATE, first);
++
++    const second = reconcileInstall(actor({ agent: "codex", daemonBundleVersion: "2.0.0" }), state2);
++
++    assert.equal(second.daemon.writeBundle, true);
++    assert.equal(second.daemon.contentReplaced, true);
++    assert.equal(second.daemon.resultingVersionFile.content_version, "2.0.0");
++    assert.equal(second.daemon.resultingVersionFile.content_source.agent, "codex");
++  });
++});
++
++describe("reconcileInstall — no downgrade", () => {
++  it("older daemon bundle does NOT replace a newer installed one", () => {
++    const seeded = reconcileInstall(actor({ daemonBundleVersion: "2.0.0" }), EMPTY_STATE);
++    const state2 = applied(EMPTY_STATE, seeded);
++
++    const older = reconcileInstall(actor({ agent: "codex", daemonBundleVersion: "1.0.0" }), state2);
++
++    assert.equal(older.daemon.writeBundle, false);
++    assert.equal(older.daemon.contentReplaced, false);
++    assert.equal(older.daemon.resultingVersionFile.content_version, "2.0.0");
++    // ...but it still gets recorded as a referencing installer.
++    assert.equal(older.daemon.writeVersionFile, true);
++    assert.equal(older.daemon.resultingVersionFile.installed_by.length, 2);
++  });
++});
++
++describe("reconcileInstall — REGRESSION: plugin_version must not drive blob replacement", () => {
++  it("higher plugin_version carrying an OLDER daemon bundle does not replace the newer daemon", () => {
++    // Installed: matrix plugin@1.2.0 that shipped daemon bundle 2.0.0.
++    const seeded = reconcileInstall(
++      actor({ agent: "claude", comm: "matrix", pluginVersion: "1.2.0", daemonBundleVersion: "2.0.0" }),
++      EMPTY_STATE,
++    );
++    const state2 = applied(EMPTY_STATE, seeded);
++
++    // Incoming: telegram plugin@1.3.0 (HIGHER plugin_version) re-bundling the
++    // OLD daemon 1.0.0. A naive plugin-version-keyed rule would downgrade.
++    const hotfix = reconcileInstall(
++      actor({ agent: "claude", comm: "telegram", pluginVersion: "1.3.0", daemonBundleVersion: "1.0.0" }),
++      state2,
++    );
++
++    assert.equal(hotfix.daemon.writeBundle, false, "must not overwrite the newer daemon blob");
++    assert.equal(hotfix.daemon.contentReplaced, false);
++    assert.equal(hotfix.daemon.resultingVersionFile.content_version, "2.0.0", "blob version is the only replace key");
++
++    // Provenance stays honest: plugin_version and bundle_version diverge.
++    const tgEntry = hotfix.daemon.resultingVersionFile.installed_by.find((e: any) => e.comm === "telegram");
++    assert.ok(tgEntry);
++    assert.equal(tgEntry.plugin_version, "1.3.0");
++    assert.equal(tgEntry.bundle_version, "1.0.0");
++    assert.equal(hotfix.daemon.resultingVersionFile.content_source.bundle_version, "2.0.0");
++  });
++});
++
++describe("reconcileInstall — reference counting keyed on (agent, comm)", () => {
++  it("one agent installing two comm plugins yields two distinct daemon references", () => {
++    const tg = reconcileInstall(actor({ agent: "claude", comm: "telegram" }), EMPTY_STATE);
++    const state2 = applied(EMPTY_STATE, tg);
++
++    const mx = reconcileInstall(actor({ agent: "claude", comm: "matrix" }), state2);
++
++    // claude appears twice in the shared daemon's reference set — once per comm
++    // plugin — so uninstalling one comm plugin can't orphan the daemon that the
++    // other still needs.
++    const refs = mx.daemon.resultingVersionFile.installed_by.map((e: any) => `${e.agent}:${e.comm}`).sort();
++    assert.deepEqual(refs, ["claude:matrix", "claude:telegram"]);
++  });
++});
++
++describe("reconcileInstall — runtime signals under a live daemon", () => {
++  it("flags restart on daemon upgrade and reload on adapter add while running", () => {
++    const seeded = reconcileInstall(actor({ daemonBundleVersion: "1.0.0", adapterBundleVersion: "1.0.0" }), EMPTY_STATE);
++
++    // Daemon is up and the telegram adapter is installed. We're now installing
++    // the *matrix* adapter — CentralState.adapterVersionFile is scoped to the
++    // adapter for the actor's comm, so for matrix it is null (not yet present).
++    const running = {
++      daemonExists: true,
++      daemonVersionFile: seeded.daemon.resultingVersionFile,
++      adapterExists: false,
++      adapterVersionFile: null,
++      daemonRunning: true,
++    };
++
++    // codex adds the matrix adapter and ships a newer daemon, daemon already up.
++    const next = reconcileInstall(
++      actor({ agent: "codex", comm: "matrix", daemonBundleVersion: "2.0.0", adapterBundleVersion: "1.0.0" }),
++      running,
++    );
++
++    assert.equal(next.requiresSpawn, false, "daemon already running");
++    assert.equal(next.requiresDaemonRestart, true, "daemon blob replaced under a live daemon");
++    assert.equal(next.requiresAdapterReload, true, "new matrix adapter added under a live daemon");
++  });
++});
+
+````
+
+---
+
+## `8fdbb66` — Document central install seam and test contract
+
+Doc-only. Adds the **Version metadata policy** and **Testability / simulated
+live-install strategy** sections to `install-model.md`: `plugin_version` is
+provenance only, bundle versions are the replace keys; no downgrade on older
+install; no auto-downgrade on uninstall-of-highest; the four-layer test model
+(T1 pure / T2 temp-fs / T3 concurrency / T4 subprocess); and the seam signatures
+matching the implementation.
+
+````diff
+diff --git a/docs/research/install-model.md b/docs/research/install-model.md
+index 587fd77..a8ad5e1 100644
+--- a/docs/research/install-model.md
++++ b/docs/research/install-model.md
+@@ -109,23 +109,81 @@ prompt the install hooks reinstall the code from plugin install paths.
+ Because both `~/.claude/plugins/agents-comm-bus-<comm>/` and
+ `~/.codex/plugins/agents-comm-bus-<comm>/` (and any future agent's
+ equivalent) may all try to install the same shared file, the metadata
+-file is a **list of installers**, not a single string:
++file is a **list of installers**, not a single string.
++
++### Version metadata policy
++
++`plugin_version` is **provenance only**. It identifies the marketplace
++plugin package that carried a bundle, but it is **not** the replacement
++key for the installed bytes.
++
++Replacement decisions key on the installed artifact's **own bundle
++version**:
++
++- `bin/version.json` tracks the daemon bundle's version.
++- `adapters/<comm>.version.json` tracks that adapter bundle's version.
++- `plugin_version` remains in provenance so the system can tell *which
++  plugin package* installed or last refreshed a given entry.
++
++This matters because plugin versions and bundle versions can drift. For
++example, `agents-comm-bus-telegram@1.3.0` could ship an unchanged
++daemon bundle `1.0.0` while `agents-comm-bus-matrix@1.2.0` already
++shipped daemon bundle `2.0.0`. In that case, the Telegram plugin's
++higher `plugin_version` must **not** replace the newer installed daemon
++bundle.
++
++The metadata shape therefore records the installed artifact separately
++from the plugins that contributed provenance:
+ 
+ ```json
+ {
+-  "version": "1.2.0",
++  "schema_version": 1,
++  "content_kind": "daemon",
++  "content_id": "daemon",
++  "content_version": "2.0.0",
++  "content_source": {
++    "agent": "claude",
++    "comm": "telegram",
++    "plugin_version": "1.2.0",
++    "bundle_version": "2.0.0"
++  },
+   "installed_by": [
+-    { "agent": "claude", "plugin_version": "1.2.0", "installed_at": "2026-05-18T20:25:00Z" },
+-    { "agent": "codex",  "plugin_version": "1.1.5", "installed_at": "2026-05-19T03:18:00Z" }
++    {
++      "agent": "claude",
++      "comm": "telegram",
++      "plugin_version": "1.2.0",
++      "bundle_version": "2.0.0",
++      "installed_at": "2026-05-18T20:25:00Z"
++    },
++    {
++      "agent": "codex",
++      "comm": "telegram",
++      "plugin_version": "1.3.0",
++      "bundle_version": "1.0.0",
++      "installed_at": "2026-05-19T03:18:00Z"
++    }
+   ]
+ }
+ ```
+ 
+-The actual file content reflects the **highest** `plugin_version` across
+-all entries. Install hooks **add** their entry on install (replacing any
+-prior entry for that same `agent`); uninstall hooks **remove** their
+-entry. When the `installed_by` list goes empty, the file is safe to
+-clean up (probably with a confirm prompt — see open questions).
++For adapters, `content_kind` is `"adapter"` and `content_id` is the
++comm name (for example `"telegram"`).
++
++Rules:
++
++- `installed_by` entries are keyed on **`(agent, comm)`**, not `agent`
++  alone. `claude+telegram` and `claude+matrix` are independent
++  references to the shared daemon.
++- Install hooks **add or replace** their own provenance entry on install.
++- The installed bytes are replaced only when the incoming
++  `bundle_version` is newer than `content_version`.
++- An older bundle version must **not** downgrade an already-installed
++  newer bundle, even if the incoming `plugin_version` is higher.
++- Uninstall hooks remove their provenance entry, but uninstalling the
++  plugin that most recently provided the installed bytes does **not**
++  auto-downgrade the shared file to the next-highest remaining entry.
++- When `installed_by` becomes empty, the file is safe to clean up
++  (probably with a confirm prompt — see open questions).
+ 
+ Install hooks are themselves agent-specific (Claude Code's hook contract
+ differs from Codex's — different env vars, different stdin envelope,
+@@ -378,9 +436,9 @@ agents. Not a v1 concern.
+    1. Checks `~/.agents-comm-bus/bin/daemon.js` — missing.
+    2. Creates `~/.agents-comm-bus/`, copies the plugin's
+       `daemon.bundle.js` → `bin/daemon.js`, writes `bin/version.json`
+-      with `installed_by` containing this agent's entry.
++      with `installed_by` containing this `(agent, comm)` entry.
+    3. Copies the plugin's `<comm>.adapter.bundle.js` → `adapters/<comm>.js`,
+-      writes `adapters/<comm>.version.json` with this agent's entry.
++      writes `adapters/<comm>.version.json` with this `(agent, comm)` entry.
+    4. Spawns daemon detached (`Start-Process` on Windows, `nohup` on
+       Unix).
+    5. Polls `~/.agents-comm-bus/port` until present, opens the WS
+@@ -395,14 +453,16 @@ agents. Not a v1 concern.
+ 
+ 1. User runs `/plugin install agents-comm-bus-<other-comm>` (or the
+    same `<comm>` from the second agent's marketplace).
+-2. First prompt after install: that plugin's `install-hook.js` fires:
++2. First usable hook invocation after install: that plugin's
++   `install-hook.js` fires:
+    1. Reads `~/.agents-comm-bus/bin/version.json` — daemon present.
+-      Compares versions; upgrades `bin/daemon.js` if the plugin's
+-      bundle is newer (see below). Adds this hook's agent entry to
+-      `installed_by` (or updates the existing entry).
+-   2. Reads `~/.agents-comm-bus/adapters/<comm>.version.json` —
+-      missing or older plugin_version → copies the plugin's adapter,
+-      updates `installed_by`.
++      Compares the incoming daemon `bundle_version` against
++      `content_version`; upgrades `bin/daemon.js` only if the incoming
++      bundle is newer (see below). Adds this hook's `(agent, comm)`
++      entry to `installed_by` (or updates the existing entry).
++   2. Reads `~/.agents-comm-bus/adapters/<comm>.version.json` for this
++      actor's comm only — missing or older `content_version` → copies
++      the plugin's adapter, updates `installed_by`.
+    3. Sends a `reload-adapters` control message to the daemon over the
+       existing WS. **[TBD: v1 may simplify to "next daemon restart"
+       and skip hot-reload.]**
+@@ -414,9 +474,11 @@ agents. Not a v1 concern.
+   same monorepo, but releases drift —
+   `agents-comm-bus-telegram@1.0` may ship daemon@1, and
+   `agents-comm-bus-matrix@1.2` may ship daemon@2.
+-- The install hook compares `plugin's daemon.bundle.js` plugin_version
+-  vs the highest `plugin_version` already in `bin/version.json`.
+-  **Highest wins.**
++- The install hook compares the incoming daemon bundle's
++  `bundle_version` against `bin/version.json.content_version`.
++  **Highest bundle version wins.** `plugin_version` is provenance only.
++- A plugin with a higher `plugin_version` but an older daemon bundle
++  must **not** replace the newer installed daemon.
+ - The **running** daemon does not hot-swap its own binary. It picks up
+   a newer `bin/daemon.js` on next restart. **[TBD: trigger choice —
+   "next idle period," "next session start," or explicit
+@@ -430,12 +492,130 @@ agents. Not a v1 concern.
+ - Daemon upgrade: restart required. In-flight long-poll connections
+   drop and reconnect.
+ 
++## Testability / simulated live-install strategy
++
++The tested contract is **first usable hook invocation**, not literal
++`SessionStart`. That matches the current architecture more accurately:
++Claude's `UserPromptSubmit` path and Codex's `UserPromptSubmit` / repair
++paths already participate in daemon bootstrap, while literal session
++start behavior may differ by host.
++
++Marketplace fetch/extract is **out of scope** for these tests. The host
++runtime's `/plugin install` step is treated as a prerequisite that
++produces a populated plugin directory. Tests fixture that populated
++plugin dir and then verify what our install hook and daemon do with it.
++
++To make the behavior testable, central install logic should be split
++into a shared library boundary before writing most tests:
++
++- `reconcileInstall(actor, state) -> plan` (pure decision function)
++- `executeInstallPlan(plan, actor, paths, fs) -> effects`
++
++The actor must carry three distinct versions:
++
++- `pluginVersion` for provenance
++- `daemonBundleVersion` for daemon replacement decisions
++- `adapterBundleVersion` for adapter replacement decisions
++- `pluginInstallDir` for executor-side bundle source resolution when a
++  plan requires copying bytes
++
++Keeping those separate prevents a plugin-only hotfix from accidentally
++downgrading a newer installed daemon or adapter. In the long run, the
++safest wiring is to derive the bundle versions from the bundles (or a
++sidecar/version stamp shipped with them) when constructing the actor, so
++accidentally passing `pluginVersion` as a replacement key becomes
++structurally harder.
++
++### Four test layers
++
++#### T1 — pure reconciliation tests
++
++Most coverage and most value should live here. These tests exercise the
++planning logic without real subprocesses.
++
++Required invariants:
++
++- idempotent reruns do not duplicate provenance entries
++- install order is irrelevant to final settled metadata
++- highest **bundle** version wins for installed bytes
++- older bundle versions never downgrade a newer installed bundle
++- uninstall of the plugin that most recently provided the installed
++  bytes does **not** auto-downgrade the shared file
++
++#### T2 — temp-filesystem integration tests
++
++Run real reconciles against temp directories representing HOME, plugin
++install dirs, and the shared `~/.agents-comm-bus/` root. Spawn/restart
++behavior can still be injected.
++
++These prove the library works against actual filesystem state:
++
++- cold install lays down daemon bundle, adapter bundle, and both metadata
++  files
++- warm install merges `installed_by` without unnecessary rewrites
++- adding a second comm installs only that adapter while preserving the
++  daemon and existing adapters
++- missing file / present metadata and present file / missing metadata
++  recovery converge to a valid state
++- executor rejects a plan that requires bundle copies when
++  `pluginInstallDir` or source bundle paths are unavailable, and writes
++  no metadata in that failure path
++
++#### T3 — concurrency tests (mandatory)
++
++Concurrency is mandatory because mixed-version double-install is the
++highest-risk path in the model. The shared install location is only
++trustworthy if concurrent callers converge cleanly.
++
++Required assertions:
++
++- concurrent cold installs converge on one valid final state
++- mixed-version concurrent installs settle on the highest daemon bundle
++  version
++- `version.json` remains valid JSON with merged provenance
++- no truncated `bin/daemon.js` or adapter bundle files are left behind
++- if bootstrap also starts the daemon, only one spawn occurs and other
++  callers converge on the same result
++
++#### T4 — subprocess hook simulation (gated smoke)
++
++Keep a small number of heavier tests that run the real hook wrappers in
++subprocesses against temp roots. These verify script plumbing rather
++than core reconciliation logic:
++
++- env-var and stdin-envelope handling
++- hook-to-library wiring
++- first-run hint injection
++- real copied daemon startup smoke after install
++
++These should be gated like integration smoke tests, not carry the main
++correctness burden.
++
++### Concrete first-batch matrix
++
++- cold install from empty shared root
++- same plugin rerun is idempotent
++- same comm on a second agent merges provenance without content churn
++- second comm install adds only its adapter
++- newer daemon bundle replaces older installed daemon
++- higher `plugin_version` carrying an older `daemonBundleVersion` does
++  **not** replace the newer installed daemon
++- newer adapter bundle replaces older installed adapter for that comm
++- uninstall removes provenance but does **not** auto-downgrade the
++  installed daemon or adapter
++- partial-state recovery: missing file / missing metadata / corrupt
++  metadata
++- executor guard: plan requires bundle copy but bundle source is
++  unavailable -> reject and write nothing
++- mixed-version concurrent double-install converges on the highest
++  bundle version with valid merged metadata
++
+ ## Migration from `claude-code-telegram`
+ 
+ 1. User uninstalls the old `claude-code-telegram` plugin.
+ 2. User installs `agents-comm-bus-telegram` from the Claude marketplace.
+-3. First prompt bootstraps the daemon and drops the Telegram adapter
+-   (cold-install lifecycle above).
++3. First usable hook invocation bootstraps the daemon and drops the
++   Telegram adapter (cold-install lifecycle above).
+ 4. User re-runs registration with their existing bot token:
+    `/comm-register telegram <token>` (or via the conversational
+    `register_account` MCP tool).
+
+````
+
+---
+
+## `5bf7120` — Harden central-install executor against partial-install state
+
+Closes a partial-install hole found in review: `executeInstallPlan` would
+silently skip a required bundle copy when `pluginInstallDir` was unset yet still
+write the version file — manufacturing metadata that claims a blob never copied.
+Now it **fails hard before any write**. Also fixes per-comm state modeling in the
+`(agent, comm)` refcount test (a matrix reconcile must start from null adapter
+state, not telegram's carried forward).
+
+````diff
+diff --git a/hosts/common/install/reconcile-central-install.js b/hosts/common/install/reconcile-central-install.js
+index 32375d3..488c95f 100644
+--- a/hosts/common/install/reconcile-central-install.js
++++ b/hosts/common/install/reconcile-central-install.js
+@@ -303,16 +303,33 @@ function parseVersion(v) {
+  * @returns {Promise<ExecutionResult>}
+  */
+ export async function executeInstallPlan(plan, actor, paths, fs) {
+-  const wroteBundles = [];
+-  const wroteVersionFiles = [];
+   const daemonSrc = actor.pluginInstallDir ? `${actor.pluginInstallDir}/daemon.bundle.js` : null;
+   const adapterSrc = actor.pluginInstallDir
+     ? `${actor.pluginInstallDir}/${actor.comm}.adapter.bundle.js`
+     : null;
+ 
+-  if (plan.daemon.writeBundle && daemonSrc) {
++  // Fail hard BEFORE any write. A `writeBundle` with no source path would
++  // otherwise silently skip the copy yet still write the version file —
++  // manufacturing a partial-install state where the metadata claims a blob
++  // that was never laid down. Validate up front so a rejected plan writes
++  // nothing at all.
++  if (plan.daemon.writeBundle && !daemonSrc) {
++    throw new Error(
++      "executeInstallPlan: daemon bundle write required but actor.pluginInstallDir is unset",
++    );
++  }
++  if (plan.adapter.writeBundle && !adapterSrc) {
++    throw new Error(
++      "executeInstallPlan: adapter bundle write required but actor.pluginInstallDir is unset",
++    );
++  }
++
++  const wroteBundles = [];
++  const wroteVersionFiles = [];
++
++  if (plan.daemon.writeBundle) {
+     await fs.mkdirp(dirname(paths.daemonBundle));
+-    await fs.copyFile(daemonSrc, paths.daemonBundle);
++    await fs.copyFile(/** @type {string} */ (daemonSrc), paths.daemonBundle);
+     wroteBundles.push(paths.daemonBundle);
+   }
+   if (plan.daemon.writeVersionFile) {
+@@ -320,9 +337,9 @@ export async function executeInstallPlan(plan, actor, paths, fs) {
+     await fs.writeFile(paths.daemonVersionFile, serialize(plan.daemon.resultingVersionFile));
+     wroteVersionFiles.push(paths.daemonVersionFile);
+   }
+-  if (plan.adapter.writeBundle && adapterSrc) {
++  if (plan.adapter.writeBundle) {
+     await fs.mkdirp(dirname(paths.adapterBundle));
+-    await fs.copyFile(adapterSrc, paths.adapterBundle);
++    await fs.copyFile(/** @type {string} */ (adapterSrc), paths.adapterBundle);
+     wroteBundles.push(paths.adapterBundle);
+   }
+   if (plan.adapter.writeVersionFile) {
+diff --git a/tests/architecture/central-install-reconcile.test.ts b/tests/architecture/central-install-reconcile.test.ts
+index ade74e4..a190b3b 100644
+--- a/tests/architecture/central-install-reconcile.test.ts
++++ b/tests/architecture/central-install-reconcile.test.ts
+@@ -3,6 +3,7 @@ import { describe, it } from "node:test";
+ 
+ import {
+   reconcileInstall,
++  executeInstallPlan,
+   compareVersions,
+   VERSION_FILE_SCHEMA,
+ } from "../../hosts/common/install/reconcile-central-install.js";
+@@ -181,9 +182,19 @@ describe("reconcileInstall — REGRESSION: plugin_version must not drive blob re
+ describe("reconcileInstall — reference counting keyed on (agent, comm)", () => {
+   it("one agent installing two comm plugins yields two distinct daemon references", () => {
+     const tg = reconcileInstall(actor({ agent: "claude", comm: "telegram" }), EMPTY_STATE);
+-    const state2 = applied(EMPTY_STATE, tg);
+ 
+-    const mx = reconcileInstall(actor({ agent: "claude", comm: "matrix" }), state2);
++    // Installing the *matrix* adapter next: carry the shared daemon state
++    // forward, but adapter state is per-comm so matrix's adapter is null (the
++    // telegram adapter file is a different artifact, irrelevant here).
++    const daemonState = {
++      daemonExists: true,
++      daemonVersionFile: tg.daemon.resultingVersionFile,
++      adapterExists: false,
++      adapterVersionFile: null,
++      daemonRunning: false,
++    };
++
++    const mx = reconcileInstall(actor({ agent: "claude", comm: "matrix" }), daemonState);
+ 
+     // claude appears twice in the shared daemon's reference set — once per comm
+     // plugin — so uninstalling one comm plugin can't orphan the daemon that the
+@@ -193,6 +204,36 @@ describe("reconcileInstall — reference counting keyed on (agent, comm)", () =>
+   });
+ });
+ 
++describe("executeInstallPlan — partial-install guard", () => {
++  it("rejects a plan that requires a bundle copy with no pluginInstallDir, writing nothing", async () => {
++    const calls: string[] = [];
++    const fakeFs = {
++      mkdirp: async (d: string) => { calls.push(`mkdirp:${d}`); },
++      copyFile: async (a: string, b: string) => { calls.push(`copy:${a}->${b}`); },
++      writeFile: async (f: string, _data: string) => { calls.push(`write:${f}`); },
++    };
++    const paths = {
++      daemonBundle: "/central/bin/daemon.js",
++      daemonVersionFile: "/central/bin/version.json",
++      adapterBundle: "/central/adapters/telegram.js",
++      adapterVersionFile: "/central/adapters/telegram.version.json",
++    };
++
++    // Cold install plan (writeBundle=true) but actor has no pluginInstallDir.
++    const noSrcActor = { ...actor(), pluginInstallDir: undefined as unknown as string };
++    const plan = reconcileInstall(noSrcActor, EMPTY_STATE);
++    assert.equal(plan.daemon.writeBundle, true);
++
++    await assert.rejects(
++      () => executeInstallPlan(plan, noSrcActor, paths, fakeFs),
++      /pluginInstallDir is unset/,
++    );
++    // The critical property: nothing was written before the throw — no
++    // version file claiming a blob that was never copied.
++    assert.deepEqual(calls, []);
++  });
++});
++
+ describe("reconcileInstall — runtime signals under a live daemon", () => {
+   it("flags restart on daemon upgrade and reload on adapter add while running", () => {
+     const seeded = reconcileInstall(actor({ daemonBundleVersion: "1.0.0", adapterBundleVersion: "1.0.0" }), EMPTY_STATE);
+
+````
+
+---
+
+## `42f458a` — Add T2 temp-fs tests for central-install executor
+
+Adds `node-fs-seam.js` (a real `node:fs`-backed `FsSeam` + `resolveCentralPaths`
+for the `~/.agents-comm-bus/{bin,adapters}` layout — real install-hook building
+blocks) and 5 T2 scenarios driving `executeInstallPlan` against a real temp state
+root with version-stamped payloads, asserting actual bytes-on-disk via the hook's
+true flow (read fs -> build state -> reconcile -> execute).
+
+````diff
+diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
+index b886785..58eb1e0 100644
+--- a/agents-comm-bus/package.json
++++ b/agents-comm-bus/package.json
+@@ -27,7 +27,7 @@
+   "scripts": {
+     "build": "tsc && node scripts/copy-assets.js",
+     "typecheck": "tsc --noEmit",
+-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\""
++    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\""
+   },
+   "engines": { "node": ">=22" },
+   "dependencies": {
+diff --git a/hosts/common/install/node-fs-seam.js b/hosts/common/install/node-fs-seam.js
+new file mode 100644
+index 0000000..e455d1c
+--- /dev/null
++++ b/hosts/common/install/node-fs-seam.js
+@@ -0,0 +1,46 @@
++/**
++ * Concrete node-backed pieces for central install: the real `FsSeam` that
++ * `executeInstallPlan` writes through, and the path resolver for the shared
++ * `~/.agents-comm-bus/` code layout. Kept in a sibling file so
++ * `reconcile-central-install.js` stays import-free and trivially unit-testable
++ * (T1 needs no fs at all); this is the I/O edge the real install hook uses.
++ */
++import { mkdir, copyFile, writeFile } from "node:fs/promises";
++import path from "node:path";
++
++/**
++ * Real filesystem seam backed by node:fs/promises.
++ * @returns {import("./reconcile-central-install.js").FsSeam}
++ */
++export function createNodeFsSeam() {
++  return {
++    mkdirp: async (dir) => {
++      await mkdir(dir, { recursive: true });
++    },
++    copyFile: async (from, to) => {
++      await copyFile(from, to);
++    },
++    writeFile: async (file, data) => {
++      await writeFile(file, data, "utf8");
++    },
++  };
++}
++
++/**
++ * Resolve the central-install code paths for one comm under a state root.
++ * Separates code (`bin/`, `adapters/`) from daemon state, per install-model.md.
++ *
++ * @param {string} stateRoot   e.g. ~/.agents-comm-bus
++ * @param {string} comm        e.g. "telegram"
++ * @returns {import("./reconcile-central-install.js").CentralPaths}
++ */
++export function resolveCentralPaths(stateRoot, comm) {
++  const bin = path.join(stateRoot, "bin");
++  const adapters = path.join(stateRoot, "adapters");
++  return {
++    daemonBundle: path.join(bin, "daemon.js"),
++    daemonVersionFile: path.join(bin, "version.json"),
++    adapterBundle: path.join(adapters, `${comm}.js`),
++    adapterVersionFile: path.join(adapters, `${comm}.version.json`),
++  };
++}
+diff --git a/tests/architecture/central-install-execute.test.ts b/tests/architecture/central-install-execute.test.ts
+new file mode 100644
+index 0000000..d80dfd0
+--- /dev/null
++++ b/tests/architecture/central-install-execute.test.ts
+@@ -0,0 +1,173 @@
++import assert from "node:assert/strict";
++import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
++import os from "node:os";
++import path from "node:path";
++import { describe, it } from "node:test";
++
++import { reconcileInstall, executeInstallPlan } from "../../hosts/common/install/reconcile-central-install.js";
++import { createNodeFsSeam, resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";
++
++// ---------------------------------------------------------------------------
++// T2 — executeInstallPlan against a REAL temp state root + real plugin payloads.
++// Each scenario reads central state back from disk between installs, exactly as
++// the install hook will: read fs -> build CentralState -> reconcile -> execute.
++// ---------------------------------------------------------------------------
++
++async function tempRoot(): Promise<string> {
++  return mkdtemp(path.join(os.tmpdir(), "central-install-"));
++}
++
++/** Create a fake plugin install dir carrying version-stamped bundle payloads. */
++async function fakePlugin(comm: string, daemonBytes: string, adapterBytes: string): Promise<string> {
++  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
++  await writeFile(path.join(dir, "daemon.bundle.js"), daemonBytes, "utf8");
++  await writeFile(path.join(dir, `${comm}.adapter.bundle.js`), adapterBytes, "utf8");
++  return dir;
++}
++
++function actor(pluginInstallDir: string, o: Record<string, string> = {}) {
++  return {
++    agent: (o.agent ?? "claude") as "claude" | "codex",
++    comm: o.comm ?? "telegram",
++    pluginVersion: o.pluginVersion ?? "1.0.0",
++    daemonBundleVersion: o.daemonBundleVersion ?? "1.0.0",
++    adapterBundleVersion: o.adapterBundleVersion ?? "1.0.0",
++    pluginInstallDir,
++    installedAt: o.installedAt ?? "2026-05-18T20:25:00Z",
++  };
++}
++
++async function exists(p: string): Promise<boolean> {
++  try {
++    await access(p);
++    return true;
++  } catch {
++    return false;
++  }
++}
++
++async function readJson(p: string): Promise<any> {
++  try {
++    return JSON.parse(await readFile(p, "utf8"));
++  } catch {
++    return null;
++  }
++}
++
++/** Read current central state from disk for a comm, as the hook would. */
++async function readCentralState(stateRoot: string, comm: string) {
++  const paths = resolveCentralPaths(stateRoot, comm);
++  return {
++    daemonExists: await exists(paths.daemonBundle),
++    daemonVersionFile: await readJson(paths.daemonVersionFile),
++    adapterExists: await exists(paths.adapterBundle),
++    adapterVersionFile: await readJson(paths.adapterVersionFile),
++    daemonRunning: false,
++  };
++}
++
++/** Reconcile + execute a single install against the live temp root. */
++async function install(stateRoot: string, a: ReturnType<typeof actor>) {
++  const state = await readCentralState(stateRoot, a.comm);
++  const plan = reconcileInstall(a, state);
++  const paths = resolveCentralPaths(stateRoot, a.comm);
++  const result = await executeInstallPlan(plan, a, paths, createNodeFsSeam());
++  return { plan, paths, result };
++}
++
++describe("T2 executeInstallPlan — cold install on a real temp root", () => {
++  it("lays down daemon + adapter bundles and version files with correct bytes", async () => {
++    const root = await tempRoot();
++    const plugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TELEGRAM_ADAPTER_v1.0.0");
++
++    const { paths } = await install(root, actor(plugin));
++
++    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
++    assert.equal(await readFile(paths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");
++
++    const dv = await readJson(paths.daemonVersionFile);
++    assert.equal(dv.content_version, "1.0.0");
++    assert.equal(dv.content_kind, "daemon");
++    assert.equal(dv.installed_by.length, 1);
++
++    const av = await readJson(paths.adapterVersionFile);
++    assert.equal(av.content_id, "telegram");
++    assert.equal(av.content_version, "1.0.0");
++  });
++});
++
++describe("T2 executeInstallPlan — upgrade replaces the daemon bytes", () => {
++  it("a newer daemon bundle overwrites bin/daemon.js and bumps content_version", async () => {
++    const root = await tempRoot();
++    const v1 = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
++    const v2 = await fakePlugin("telegram", "DAEMON_BUNDLE_v2.0.0", "TG_v2");
++
++    await install(root, actor(v1, { daemonBundleVersion: "1.0.0", adapterBundleVersion: "1.0.0" }));
++    const { paths } = await install(
++      root,
++      actor(v2, { agent: "codex", daemonBundleVersion: "2.0.0", adapterBundleVersion: "2.0.0" }),
++    );
++
++    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v2.0.0");
++    const dv = await readJson(paths.daemonVersionFile);
++    assert.equal(dv.content_version, "2.0.0");
++    assert.equal(dv.content_source.agent, "codex");
++  });
++});
++
++describe("T2 executeInstallPlan — older install cannot downgrade on-disk bytes", () => {
++  it("keeps the newer daemon bytes when an older bundle installs afterward", async () => {
++    const root = await tempRoot();
++    const v2 = await fakePlugin("telegram", "DAEMON_BUNDLE_v2.0.0", "TG_v2");
++    const v1 = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
++
++    await install(root, actor(v2, { daemonBundleVersion: "2.0.0", adapterBundleVersion: "2.0.0" }));
++    const { plan, paths } = await install(
++      root,
++      actor(v1, { agent: "codex", daemonBundleVersion: "1.0.0", adapterBundleVersion: "1.0.0" }),
++    );
++
++    assert.equal(plan.daemon.writeBundle, false);
++    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v2.0.0", "bytes not downgraded");
++    const dv = await readJson(paths.daemonVersionFile);
++    assert.equal(dv.content_version, "2.0.0");
++    // ...but the older installer is still recorded as a reference.
++    assert.equal(dv.installed_by.length, 2);
++  });
++});
++
++describe("T2 executeInstallPlan — idempotent rerun touches nothing", () => {
++  it("a repeat of the same install writes no bundle and no version file", async () => {
++    const root = await tempRoot();
++    const plugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
++
++    await install(root, actor(plugin));
++    const { plan, paths } = await install(root, actor(plugin, { installedAt: "2026-06-01T00:00:00Z" }));
++
++    assert.equal(plan.daemon.writeBundle, false);
++    assert.equal(plan.daemon.writeVersionFile, false);
++    assert.equal(plan.adapter.writeBundle, false);
++    assert.equal(plan.adapter.writeVersionFile, false);
++    // On-disk content unchanged, including the original installed_at timestamp.
++    const dv = await readJson(paths.daemonVersionFile);
++    assert.equal(dv.installed_by[0].installed_at, "2026-05-18T20:25:00Z");
++  });
++});
++
++describe("T2 executeInstallPlan — second agent merges provenance without recopying", () => {
++  it("same bundle version from a second agent rewrites only the version file", async () => {
++    const root = await tempRoot();
++    const claudePlugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
++    const codexPlugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
++
++    await install(root, actor(claudePlugin, { agent: "claude" }));
++    const { plan, paths } = await install(root, actor(codexPlugin, { agent: "codex" }));
++
++    assert.equal(plan.daemon.writeBundle, false, "identical bundle version -> no recopy");
++    assert.equal(plan.daemon.writeVersionFile, true, "provenance changed -> rewrite metadata");
++
++    const dv = await readJson(paths.daemonVersionFile);
++    const agents = dv.installed_by.map((e: any) => e.agent).sort();
++    assert.deepEqual(agents, ["claude", "codex"]);
++  });
++});
+
+````
+
+---
+
+## `ab376ee` — Round out T2 coverage per review checklist
+
+Three more temp-fs cases from the review checklist, the key one being
+**missing-bundle recovery** — it covers the `!bundleExists` branch that had no
+test: a lost daemon blob whose version file still claims it is restored on the
+next install. Plus second-comm install and a real-root variant of the executor
+guard.
+
+````diff
+diff --git a/tests/architecture/central-install-execute.test.ts b/tests/architecture/central-install-execute.test.ts
+index d80dfd0..b21c0f0 100644
+--- a/tests/architecture/central-install-execute.test.ts
++++ b/tests/architecture/central-install-execute.test.ts
+@@ -1,5 +1,5 @@
+ import assert from "node:assert/strict";
+-import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
++import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
+ import os from "node:os";
+ import path from "node:path";
+ import { describe, it } from "node:test";
+@@ -171,3 +171,71 @@ describe("T2 executeInstallPlan — second agent merges provenance without recop
+     assert.deepEqual(agents, ["claude", "codex"]);
+   });
+ });
++
++describe("T2 executeInstallPlan — second comm install", () => {
++  it("preserves the daemon + existing adapter and writes the new comm's adapter", async () => {
++    const root = await tempRoot();
++    const tgPlugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TELEGRAM_ADAPTER");
++    const mxPlugin = await fakePlugin("matrix", "DAEMON_BUNDLE_v1.0.0", "MATRIX_ADAPTER");
++
++    await install(root, actor(tgPlugin, { comm: "telegram" }));
++    const { paths: mxPaths } = await install(root, actor(mxPlugin, { comm: "matrix" }));
++
++    // Telegram adapter untouched; matrix adapter freshly written.
++    const tgPaths = resolveCentralPaths(root, "telegram");
++    assert.equal(await readFile(tgPaths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER");
++    assert.equal(await readFile(mxPaths.adapterBundle, "utf8"), "MATRIX_ADAPTER");
++
++    // Shared daemon preserved (same version) and now referenced by both comms.
++    assert.equal(await readFile(mxPaths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
++    const dv = await readJson(mxPaths.daemonVersionFile);
++    const refs = dv.installed_by.map((e: any) => `${e.agent}:${e.comm}`).sort();
++    assert.deepEqual(refs, ["claude:matrix", "claude:telegram"]);
++  });
++});
++
++describe("T2 executeInstallPlan — missing-bundle recovery", () => {
++  it("restores a lost daemon blob when the version file still claims it", async () => {
++    const root = await tempRoot();
++    const plugin = await fakePlugin("telegram", "DAEMON_BUNDLE_v1.0.0", "TG_v1");
++
++    await install(root, actor(plugin));
++
++    // Simulate the blob going missing while metadata still records it.
++    const paths = resolveCentralPaths(root, "telegram");
++    await rm(paths.daemonBundle);
++    assert.equal(await exists(paths.daemonBundle), false);
++
++    // Rerunning the same install must detect daemonExists=false and rewrite
++    // the blob (the !bundleExists recovery branch), leaving metadata valid.
++    const { plan } = await install(root, actor(plugin));
++
++    assert.equal(plan.daemon.writeBundle, true);
++    assert.ok(plan.daemon.reasons.some((r: string) => r.includes("recovery")));
++    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
++    const dv = await readJson(paths.daemonVersionFile);
++    assert.equal(dv.content_version, "1.0.0");
++  });
++});
++
++describe("T2 executeInstallPlan — executor guard on a real root", () => {
++  it("rejects a bundle-requiring plan with no source and creates no files", async () => {
++    const root = await tempRoot();
++    const noSrc = { ...actor("/does/not/matter"), pluginInstallDir: undefined as unknown as string };
++
++    const state = await readCentralState(root, noSrc.comm);
++    const plan = reconcileInstall(noSrc, state);
++    const paths = resolveCentralPaths(root, noSrc.comm);
++
++    await assert.rejects(
++      () => executeInstallPlan(plan, noSrc, paths, createNodeFsSeam()),
++      /pluginInstallDir is unset/,
++    );
++
++    // Nothing landed anywhere under the central root.
++    assert.equal(await exists(paths.daemonBundle), false);
++    assert.equal(await exists(paths.daemonVersionFile), false);
++    assert.equal(await exists(paths.adapterBundle), false);
++    assert.equal(await exists(paths.adapterVersionFile), false);
++  });
++});
+
+````
+
+---
+
+## `d69ba56` — Add T3 central-install serialization: global lock + atomic writes
+
+The serialization layer. `install-lock.js` is a **single global** `install.lock`
+(`O_CREAT|O_EXCL` + token-verified release, bounded wait/retry, stale-lock steal)
+— global because every install reconciles the shared daemon anyway, so per-artifact
+locks add deadlock surface for no real parallelism. `createAtomicNodeFsSeam` writes
+via same-dir temp file + atomic rename. `run-central-install.js` is the
+orchestrator: acquire -> re-read disk -> reconcile -> execute -> release, with the
+authoritative reconcile **inside** the lock so stale pre-lock plans can't win.
+7 tests: lock contention/stale-steal/timeout + 4 real `Promise.all` races.
+(Windows rename-over-running-daemon was verified safe separately.)
+
+````diff
+diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
+index 58eb1e0..2beeed4 100644
+--- a/agents-comm-bus/package.json
++++ b/agents-comm-bus/package.json
+@@ -27,7 +27,7 @@
+   "scripts": {
+     "build": "tsc && node scripts/copy-assets.js",
+     "typecheck": "tsc --noEmit",
+-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\""
++    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\""
+   },
+   "engines": { "node": ">=22" },
+   "dependencies": {
+diff --git a/hosts/common/install/install-lock.js b/hosts/common/install/install-lock.js
+new file mode 100644
+index 0000000..da76541
+--- /dev/null
++++ b/hosts/common/install/install-lock.js
+@@ -0,0 +1,118 @@
++/**
++ * Global central-install lock.
++ *
++ * Serializes the whole read→reconcile→execute critical section so concurrent
++ * installs (e.g. a Claude hook and a Codex hook both firing on first prompt)
++ * cannot interleave bundle copies and metadata writes. A SINGLE global lock is
++ * deliberate: every install reconciles the shared daemon (bin/daemon.js +
++ * version.json), so per-artifact locks would not buy real parallelism — they
++ * would only add lock-ordering and deadlock surface.
++ *
++ * Mirrors the core-daemon spawn-lock idiom (O_CREAT|O_EXCL + token-verified
++ * release) and adds bounded wait/retry plus stale-lock stealing, matching the
++ * ensureDaemon ergonomics.
++ */
++import { constants } from "node:fs";
++import { open, readFile, rm, mkdir, stat } from "node:fs/promises";
++import path from "node:path";
++
++const DEFAULTS = { timeoutMs: 5_000, retryMs: 50, staleMs: 30_000 };
++
++/**
++ * @typedef {Object} InstallLock
++ * @property {string} path
++ * @property {string} token
++ * @property {boolean} stoleStale   true if a stale holder's lock was reclaimed
++ * @property {() => Promise<void>} release
++ *
++ * @typedef {Object} InstallLockOptions
++ * @property {number} [timeoutMs]   max time to wait for the lock before throwing
++ * @property {number} [retryMs]     poll interval while the lock is held
++ * @property {number} [staleMs]     age past which a held lock is considered abandoned
++ * @property {() => number} [now]   injectable clock (tests); defaults to Date.now
++ * @property {(ms: number) => Promise<void>} [sleep]  injectable delay (tests)
++ */
++
++/**
++ * Acquire the install lock, waiting (bounded) if another installer holds it.
++ *
++ * @param {string} lockPath
++ * @param {InstallLockOptions} [options]
++ * @returns {Promise<InstallLock>}
++ */
++export async function acquireInstallLock(lockPath, options = {}) {
++  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
++  const retryMs = options.retryMs ?? DEFAULTS.retryMs;
++  const staleMs = options.staleMs ?? DEFAULTS.staleMs;
++  const now = options.now ?? Date.now;
++  const sleep = options.sleep ?? defaultSleep;
++
++  await mkdir(path.dirname(lockPath), { recursive: true });
++  const token = `${process.pid}:${now()}`;
++  const start = now();
++  let stoleStale = false;
++
++  for (;;) {
++    try {
++      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
++      await handle.writeFile(`${token}\n`, "utf8");
++      await handle.close();
++      return {
++        path: lockPath,
++        token,
++        stoleStale,
++        release: async () => {
++          try {
++            const current = await readFile(lockPath, "utf8");
++            if (current.trim() === token) {
++              await rm(lockPath, { force: true });
++            }
++          } catch {
++            // Best-effort: a later install can treat a leftover lock as stale.
++          }
++        },
++      };
++    } catch (error) {
++      if (!isAlreadyExistsError(error)) throw error;
++
++      // Held by someone else — reclaim it if it looks abandoned.
++      if (await stealIfStale(lockPath, staleMs, now)) {
++        stoleStale = true;
++        continue;
++      }
++      if (now() - start >= timeoutMs) {
++        throw new Error(`central install lock at ${lockPath} is held; timed out after ${timeoutMs}ms`);
++      }
++      await sleep(retryMs);
++    }
++  }
++}
++
++/**
++ * @param {string} lockPath
++ * @param {number} staleMs
++ * @param {() => number} now
++ * @returns {Promise<boolean>}
++ */
++async function stealIfStale(lockPath, staleMs, now) {
++  try {
++    const info = await stat(lockPath);
++    if (now() - info.mtimeMs > staleMs) {
++      await rm(lockPath, { force: true });
++      return true;
++    }
++  } catch {
++    // Disappeared between the failed open and the stat — the next loop retries.
++  }
++  return false;
++}
++
++/** @param {number} ms */
++function defaultSleep(ms) {
++  return new Promise((resolve) => setTimeout(resolve, ms));
++}
++
++/** @param {unknown} error */
++function isAlreadyExistsError(error) {
++  return typeof error === "object" && error !== null && "code" in error && /** @type {any} */ (error).code === "EEXIST";
++}
+diff --git a/hosts/common/install/node-fs-seam.js b/hosts/common/install/node-fs-seam.js
+index e455d1c..cbadee5 100644
+--- a/hosts/common/install/node-fs-seam.js
++++ b/hosts/common/install/node-fs-seam.js
+@@ -5,7 +5,7 @@
+  * `reconcile-central-install.js` stays import-free and trivially unit-testable
+  * (T1 needs no fs at all); this is the I/O edge the real install hook uses.
+  */
+-import { mkdir, copyFile, writeFile } from "node:fs/promises";
++import { mkdir, copyFile, writeFile, rename, access, readFile } from "node:fs/promises";
+ import path from "node:path";
+ 
+ /**
+@@ -26,6 +26,77 @@ export function createNodeFsSeam() {
+   };
+ }
+ 
++/**
++ * Atomic filesystem seam: every write lands via a same-directory temp file
++ * followed by an atomic rename, so a reader (or a crash) never observes a
++ * half-written bundle or truncated JSON — only old-good or new-good. Verified
++ * safe on Windows even when a running daemon has the target .js imported (node
++ * closes the handle after import, unlike a locked .exe image).
++ *
++ * Safe to use a fixed `.tmp` suffix because runCentralInstall holds the global
++ * install lock, so there is exactly one writer at a time.
++ *
++ * @returns {import("./reconcile-central-install.js").FsSeam}
++ */
++export function createAtomicNodeFsSeam() {
++  return {
++    mkdirp: async (dir) => {
++      await mkdir(dir, { recursive: true });
++    },
++    copyFile: async (from, to) => {
++      const tmp = `${to}.tmp`;
++      await copyFile(from, tmp);
++      await rename(tmp, to);
++    },
++    writeFile: async (file, data) => {
++      const tmp = `${file}.tmp`;
++      await writeFile(tmp, data, "utf8");
++      await rename(tmp, file);
++    },
++  };
++}
++
++/**
++ * Read the current central-install state for one comm from disk, in the shape
++ * reconcileInstall expects. This is the real hook flow's read step: read fs →
++ * build CentralState → reconcile. `daemonRunning` is left false here (it is a
++ * discovery-probe concern, not a filesystem one); the caller overrides it if
++ * it has a live daemon handshake.
++ *
++ * @param {string} stateRoot
++ * @param {string} comm
++ * @returns {Promise<import("./reconcile-central-install.js").CentralState>}
++ */
++export async function readCentralState(stateRoot, comm) {
++  const paths = resolveCentralPaths(stateRoot, comm);
++  return {
++    daemonExists: await pathExists(paths.daemonBundle),
++    daemonVersionFile: await readJsonOrNull(paths.daemonVersionFile),
++    adapterExists: await pathExists(paths.adapterBundle),
++    adapterVersionFile: await readJsonOrNull(paths.adapterVersionFile),
++    daemonRunning: false,
++  };
++}
++
++/** @param {string} p */
++async function pathExists(p) {
++  try {
++    await access(p);
++    return true;
++  } catch {
++    return false;
++  }
++}
++
++/** @param {string} p */
++async function readJsonOrNull(p) {
++  try {
++    return JSON.parse(await readFile(p, "utf8"));
++  } catch {
++    return null;
++  }
++}
++
+ /**
+  * Resolve the central-install code paths for one comm under a state root.
+  * Separates code (`bin/`, `adapters/`) from daemon state, per install-model.md.
+diff --git a/hosts/common/install/run-central-install.js b/hosts/common/install/run-central-install.js
+new file mode 100644
+index 0000000..6a38610
+--- /dev/null
++++ b/hosts/common/install/run-central-install.js
+@@ -0,0 +1,58 @@
++/**
++ * Central-install orchestrator — the outer ring around the pure seam.
++ *
++ * runCentralInstall is what the per-agent install hook calls. It holds the
++ * global install lock across the ENTIRE read→reconcile→execute section, so the
++ * authoritative reconcile runs against fresh on-disk state inside the lock. A
++ * plan computed before the lock can be stale (another installer may have won a
++ * race and bumped content_version); only the in-lock plan is executed.
++ *
++ * Layering: this file adds orchestration only. reconcileInstall (pure decision)
++ * and executeInstallPlan (effects) are unchanged. Atomicity (temp-file + rename,
++ * bytes-before-metadata) is a property of the injected fs seam, defaulting to
++ * createAtomicNodeFsSeam.
++ */
++import path from "node:path";
++
++import { reconcileInstall, executeInstallPlan } from "./reconcile-central-install.js";
++import { createAtomicNodeFsSeam, resolveCentralPaths, readCentralState } from "./node-fs-seam.js";
++import { acquireInstallLock } from "./install-lock.js";
++
++const INSTALL_LOCK_NAME = "install.lock";
++
++/**
++ * @typedef {Object} RunCentralInstallDeps
++ * @property {import("./reconcile-central-install.js").FsSeam} [fs]  defaults to atomic node seam
++ * @property {import("./install-lock.js").InstallLockOptions} [lock]
++ * @property {boolean} [daemonRunning]  pass-through to reconcile's runtime signals
++ *
++ * @typedef {Object} RunCentralInstallResult
++ * @property {import("./reconcile-central-install.js").ReconcilePlan} plan  the in-lock plan that was executed
++ * @property {import("./reconcile-central-install.js").ExecutionResult} result
++ * @property {boolean} stoleStale  whether a stale lock was reclaimed to proceed
++ */
++
++/**
++ * Acquire the lock, re-read disk state, reconcile, execute, release.
++ *
++ * @param {string} stateRoot
++ * @param {import("./reconcile-central-install.js").InstallActor} actor
++ * @param {RunCentralInstallDeps} [deps]
++ * @returns {Promise<RunCentralInstallResult>}
++ */
++export async function runCentralInstall(stateRoot, actor, deps = {}) {
++  const fs = deps.fs ?? createAtomicNodeFsSeam();
++  const lockPath = path.join(stateRoot, INSTALL_LOCK_NAME);
++  const lock = await acquireInstallLock(lockPath, deps.lock ?? {});
++  try {
++    // Authoritative reconcile: fresh disk state read INSIDE the lock.
++    const state = await readCentralState(stateRoot, actor.comm);
++    state.daemonRunning = deps.daemonRunning ?? false;
++    const plan = reconcileInstall(actor, state);
++    const paths = resolveCentralPaths(stateRoot, actor.comm);
++    const result = await executeInstallPlan(plan, actor, paths, fs);
++    return { plan, result, stoleStale: lock.stoleStale };
++  } finally {
++    await lock.release();
++  }
++}
+diff --git a/tests/architecture/central-install-concurrency.test.ts b/tests/architecture/central-install-concurrency.test.ts
+new file mode 100644
+index 0000000..5b7f84b
+--- /dev/null
++++ b/tests/architecture/central-install-concurrency.test.ts
+@@ -0,0 +1,207 @@
++import assert from "node:assert/strict";
++import { mkdtemp, writeFile, readFile, access, utimes, stat } from "node:fs/promises";
++import os from "node:os";
++import path from "node:path";
++import { describe, it } from "node:test";
++
++import { runCentralInstall } from "../../hosts/common/install/run-central-install.js";
++import { acquireInstallLock } from "../../hosts/common/install/install-lock.js";
++import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";
++
++// ---------------------------------------------------------------------------
++// T3 — install lock + real-concurrency orchestrator races.
++// Real temp root, real lockfile, real atomic-rename fs, Promise.all. No fake
++// concurrency shortcuts: this is the only way the serialization is proven.
++// ---------------------------------------------------------------------------
++
++async function tempRoot(): Promise<string> {
++  return mkdtemp(path.join(os.tmpdir(), "central-install-conc-"));
++}
++
++async function fakePlugin(comm: string, version: string): Promise<string> {
++  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
++  await writeFile(path.join(dir, "daemon.bundle.js"), `DAEMON_BUNDLE_v${version}`, "utf8");
++  await writeFile(path.join(dir, `${comm}.adapter.bundle.js`), `${comm.toUpperCase()}_ADAPTER_v${version}`, "utf8");
++  return dir;
++}
++
++function actor(pluginInstallDir: string, o: Record<string, string> = {}) {
++  const v = o.version ?? "1.0.0";
++  return {
++    agent: (o.agent ?? "claude") as "claude" | "codex",
++    comm: o.comm ?? "telegram",
++    pluginVersion: o.pluginVersion ?? v,
++    daemonBundleVersion: o.daemonBundleVersion ?? v,
++    adapterBundleVersion: o.adapterBundleVersion ?? v,
++    pluginInstallDir,
++    installedAt: o.installedAt ?? "2026-05-18T20:25:00Z",
++  };
++}
++
++async function readJson(p: string): Promise<any> {
++  return JSON.parse(await readFile(p, "utf8"));
++}
++
++async function exists(p: string): Promise<boolean> {
++  try {
++    await access(p);
++    return true;
++  } catch {
++    return false;
++  }
++}
++
++/** No leftover .tmp files promoted/abandoned under the central root. */
++async function noStrayTemp(stateRoot: string, comm: string) {
++  const paths = resolveCentralPaths(stateRoot, comm);
++  for (const p of Object.values(paths)) {
++    assert.equal(await exists(`${p}.tmp`), false, `stray temp file: ${p}.tmp`);
++  }
++}
++
++// --- lock unit tests --------------------------------------------------------
++
++describe("acquireInstallLock", () => {
++  it("blocks a second acquirer until the first releases", async () => {
++    const root = await tempRoot();
++    const lockPath = path.join(root, "install.lock");
++
++    const first = await acquireInstallLock(lockPath, { timeoutMs: 2_000, retryMs: 10 });
++    let secondAcquired = false;
++    const secondP = acquireInstallLock(lockPath, { timeoutMs: 2_000, retryMs: 10 }).then((l) => {
++      secondAcquired = true;
++      return l;
++    });
++
++    await new Promise((r) => setTimeout(r, 80));
++    assert.equal(secondAcquired, false, "second must wait while first holds");
++
++    await first.release();
++    const second = await secondP;
++    assert.equal(secondAcquired, true);
++    await second.release();
++  });
++
++  it("steals a stale lock past staleMs", async () => {
++    const root = await tempRoot();
++    const lockPath = path.join(root, "install.lock");
++
++    const abandoned = await acquireInstallLock(lockPath, {});
++    // Backdate the lockfile so it looks abandoned, without releasing it.
++    const past = new Date(Date.now() - 120_000);
++    await utimes(lockPath, past, past);
++
++    const reclaimed = await acquireInstallLock(lockPath, { staleMs: 30_000, timeoutMs: 1_000, retryMs: 10 });
++    assert.equal(reclaimed.stoleStale, true);
++    await reclaimed.release();
++    // (abandoned.release would no-op now: token no longer matches.)
++    await abandoned.release();
++  });
++
++  it("times out when the lock stays held and is not stale", async () => {
++    const root = await tempRoot();
++    const lockPath = path.join(root, "install.lock");
++
++    const held = await acquireInstallLock(lockPath, {});
++    await assert.rejects(
++      () => acquireInstallLock(lockPath, { timeoutMs: 120, retryMs: 10, staleMs: 600_000 }),
++      /timed out/,
++    );
++    await held.release();
++  });
++});
++
++// --- orchestrator concurrency races ----------------------------------------
++
++describe("runCentralInstall — concurrent cold installs, same version", () => {
++  it("converges on valid bytes + JSON with all references merged", async () => {
++    const root = await tempRoot();
++    const pA = await fakePlugin("telegram", "1.0.0");
++    const pB = await fakePlugin("telegram", "1.0.0");
++
++    await Promise.all([
++      runCentralInstall(root, actor(pA, { agent: "claude" })),
++      runCentralInstall(root, actor(pB, { agent: "codex" })),
++    ]);
++
++    const paths = resolveCentralPaths(root, "telegram");
++    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
++    const dv = await readJson(paths.daemonVersionFile); // parses => valid JSON
++    assert.equal(dv.content_version, "1.0.0");
++    const agents = dv.installed_by.map((e: any) => e.agent).sort();
++    assert.deepEqual(agents, ["claude", "codex"]);
++    await noStrayTemp(root, "telegram");
++  });
++});
++
++describe("runCentralInstall — concurrent cold installs, mixed daemon versions", () => {
++  it("the highest bundle version wins regardless of completion order, bytes match metadata", async () => {
++    const root = await tempRoot();
++    const pV1 = await fakePlugin("telegram", "1.0.0");
++    const pV2 = await fakePlugin("telegram", "2.0.0");
++
++    await Promise.all([
++      runCentralInstall(root, actor(pV1, { agent: "claude", version: "1.0.0" })),
++      runCentralInstall(root, actor(pV2, { agent: "codex", version: "2.0.0" })),
++    ]);
++
++    const paths = resolveCentralPaths(root, "telegram");
++    const dv = await readJson(paths.daemonVersionFile);
++    assert.equal(dv.content_version, "2.0.0", "highest wins");
++
++    // The decisive cross-check: on-disk bytes must equal the winning version —
++    // metadata is never ahead of bytes.
++    const bytes = await readFile(paths.daemonBundle, "utf8");
++    assert.equal(bytes, "DAEMON_BUNDLE_v2.0.0");
++    assert.ok(bytes.includes(dv.content_version), "bytes correspond to content_version");
++
++    // Both installers recorded as references regardless of who won the content.
++    assert.equal(dv.installed_by.length, 2);
++    await noStrayTemp(root, "telegram");
++  });
++});
++
++describe("runCentralInstall — concurrent installs for different comms", () => {
++  it("writes both adapters and keeps both daemon references", async () => {
++    const root = await tempRoot();
++    const tg = await fakePlugin("telegram", "1.0.0");
++    const mx = await fakePlugin("matrix", "1.0.0");
++
++    await Promise.all([
++      runCentralInstall(root, actor(tg, { agent: "claude", comm: "telegram" })),
++      runCentralInstall(root, actor(mx, { agent: "claude", comm: "matrix" })),
++    ]);
++
++    const tgPaths = resolveCentralPaths(root, "telegram");
++    const mxPaths = resolveCentralPaths(root, "matrix");
++    assert.equal(await readFile(tgPaths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");
++    assert.equal(await readFile(mxPaths.adapterBundle, "utf8"), "MATRIX_ADAPTER_v1.0.0");
++
++    const dv = await readJson(tgPaths.daemonVersionFile);
++    const refs = dv.installed_by.map((e: any) => `${e.agent}:${e.comm}`).sort();
++    assert.deepEqual(refs, ["claude:matrix", "claude:telegram"]);
++    await noStrayTemp(root, "telegram");
++    await noStrayTemp(root, "matrix");
++  });
++});
++
++describe("runCentralInstall — concurrent same-comm installs from different agents", () => {
++  it("adapter + daemon metadata stay valid under same-path contention", async () => {
++    const root = await tempRoot();
++    const pClaude = await fakePlugin("telegram", "1.0.0");
++    const pCodex = await fakePlugin("telegram", "1.0.0");
++
++    await Promise.all([
++      runCentralInstall(root, actor(pClaude, { agent: "claude", comm: "telegram" })),
++      runCentralInstall(root, actor(pCodex, { agent: "codex", comm: "telegram" })),
++    ]);
++
++    const paths = resolveCentralPaths(root, "telegram");
++    assert.equal(await readFile(paths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");
++    const av = await readJson(paths.adapterVersionFile); // valid JSON
++    assert.equal(av.content_id, "telegram");
++    const dv = await readJson(paths.daemonVersionFile);
++    assert.equal(dv.installed_by.length, 2, "both agents merged into daemon provenance");
++    await noStrayTemp(root, "telegram");
++  });
++});
+
+````
+
+---
+
+## `8c26723` — Add central-install mode contract (source/dev vs production)
+
+`ensure-central-install.js` — the mode-aware wrapper hooks will call before
+`ensureDaemon`. `resolveInstallMode(env)`: source iff `AGENTS_COMM_BUS_BIN` is set
+(authoritative, never inferred); production otherwise. `readInstallStamp` reads a
+runtime-readable `install-stamp.json` (distinct from lineage `.stage-manifest.json`).
+`ensureCentralInstall`: source mode skips entirely; production mode requires the
+stamp and **fails loud** if missing (no silent skip), then builds the InstallActor
+and runs `runCentralInstall`. 8 tests. Not wired into live paths.
+
+````diff
+diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
+index 2beeed4..def451c 100644
+--- a/agents-comm-bus/package.json
++++ b/agents-comm-bus/package.json
+@@ -27,7 +27,7 @@
+   "scripts": {
+     "build": "tsc && node scripts/copy-assets.js",
+     "typecheck": "tsc --noEmit",
+-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\""
++    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\""
+   },
+   "engines": { "node": ">=22" },
+   "dependencies": {
+diff --git a/hosts/common/install/ensure-central-install.js b/hosts/common/install/ensure-central-install.js
+new file mode 100644
+index 0000000..7d59df9
+--- /dev/null
++++ b/hosts/common/install/ensure-central-install.js
+@@ -0,0 +1,161 @@
++/**
++ * Central-install entry contract — the mode-aware wrapper the per-agent install
++ * hooks (and the MCP shim cold-start path) call BEFORE ensureDaemon.
++ *
++ * Settled mode contract (see install-model.md "Dev mode" + the design thread):
++ *
++ *   source/dev mode  — triggered by an explicit AGENTS_COMM_BUS_BIN env signal.
++ *                      Skip central install entirely; the daemon runs from the
++ *                      source checkout with project-local .agents-comm-bus-dev
++ *                      state. Preserves the current Model A iteration loop.
++ *
++ *   production mode  — no source signal. REQUIRE a runtime-readable install
++ *                      stamp (pluginInstallDir + bundle versions) and fail LOUD
++ *                      if it is missing or invalid. A missing plugin dir in
++ *                      production is a packaging/bootstrap bug we want surfaced,
++ *                      never silently skipped. When present, build the
++ *                      InstallActor from the stamp and run the serialized
++ *                      runCentralInstall.
++ *
++ * The "missing plugin dir => skip" heuristic is deliberately NOT the contract:
++ * explicit env signal is authoritative; absence of production metadata is an
++ * error, not an inferred dev mode.
++ *
++ * This module is the contract + its wiring to runCentralInstall. It is NOT yet
++ * called from the live ensureDaemon paths; that wiring is a separate, deliberate
++ * step that must land together with dev configs setting AGENTS_COMM_BUS_BIN (or
++ * it would hard-fail the current dev loop, which sets none of these vars).
++ */
++import path from "node:path";
++import { readFile } from "node:fs/promises";
++
++import { runCentralInstall as defaultRunCentralInstall } from "./run-central-install.js";
++
++export const INSTALL_STAMP_NAME = "install-stamp.json";
++
++/**
++ * The runtime-readable version stamp expected at the plugin install root in
++ * production. Distinct from .stage-manifest.json (which is build lineage, not
++ * install-actor versions). Emitting this from the stage/assemble scripts is a
++ * follow-up; this module defines its shape and reads it.
++ *
++ * @typedef {Object} InstallStamp
++ * @property {number} schema_version
++ * @property {string} agent
++ * @property {string} comm
++ * @property {string} plugin_version          provenance only
++ * @property {string} daemon_bundle_version   bin/daemon.js replace key
++ * @property {string} adapter_bundle_version  adapters/<comm>.js replace key
++ *
++ * @typedef {"source" | "production"} InstallMode
++ *
++ * @typedef {Object} EnsureCentralInstallOptions
++ * @property {string} stateRoot
++ * @property {string} [agent]                 falls back to the stamp's agent
++ * @property {string} [comm]                  falls back to the stamp's comm
++ * @property {string} [pluginInstallDir]      where the bundles + stamp live (production)
++ * @property {Record<string,string|undefined>} [env]   defaults to process.env
++ * @property {string} [installedAt]           ISO timestamp; defaults to now
++ * @property {boolean} [daemonRunning]        pass-through to runCentralInstall
++ * @property {import("./install-lock.js").InstallLockOptions} [lock]
++ * @property {EnsureCentralInstallDeps} [deps]
++ *
++ * @typedef {Object} EnsureCentralInstallDeps  injectable seams for tests
++ * @property {typeof readFile} [readFile]
++ * @property {typeof defaultRunCentralInstall} [runCentralInstall]
++ * @property {import("./reconcile-central-install.js").FsSeam} [fs]
++ *
++ * @typedef {Object} EnsureCentralInstallResult
++ * @property {InstallMode} mode
++ * @property {boolean} [skipped]              true in source mode
++ * @property {import("./reconcile-central-install.js").InstallActor} [actor]
++ * @property {import("./reconcile-central-install.js").ReconcilePlan} [plan]
++ * @property {import("./reconcile-central-install.js").ExecutionResult} [result]
++ * @property {boolean} [stoleStale]
++ */
++
++/**
++ * Resolve install mode from the environment. PURE. Source mode is triggered
++ * ONLY by an explicit AGENTS_COMM_BUS_BIN signal — never inferred.
++ *
++ * @param {Record<string,string|undefined>} env
++ * @returns {InstallMode}
++ */
++export function resolveInstallMode(env) {
++  return env && env.AGENTS_COMM_BUS_BIN ? "source" : "production";
++}
++
++/**
++ * Read + minimally validate the install stamp under a plugin install dir.
++ * Returns null when absent, unreadable, unparseable, or missing required
++ * version fields.
++ *
++ * @param {string | undefined} pluginInstallDir
++ * @param {EnsureCentralInstallDeps} [deps]
++ * @returns {Promise<InstallStamp | null>}
++ */
++export async function readInstallStamp(pluginInstallDir, deps = {}) {
++  if (!pluginInstallDir) return null;
++  const read = deps.readFile ?? readFile;
++  try {
++    const raw = await read(path.join(pluginInstallDir, INSTALL_STAMP_NAME), "utf8");
++    const parsed = JSON.parse(raw);
++    if (
++      !parsed ||
++      typeof parsed.plugin_version !== "string" ||
++      typeof parsed.daemon_bundle_version !== "string" ||
++      typeof parsed.adapter_bundle_version !== "string"
++    ) {
++      return null;
++    }
++    return parsed;
++  } catch {
++    return null;
++  }
++}
++
++/**
++ * Mode-aware central-install entry point.
++ *
++ * @param {EnsureCentralInstallOptions} options
++ * @returns {Promise<EnsureCentralInstallResult>}
++ */
++export async function ensureCentralInstall(options) {
++  const env = options.env ?? process.env;
++  const mode = resolveInstallMode(env);
++
++  if (mode === "source") {
++    // Daemon runs from source; central install is intentionally bypassed.
++    return { mode: "source", skipped: true };
++  }
++
++  // Production mode is strict: a missing/invalid stamp is a hard error.
++  const stamp = await readInstallStamp(options.pluginInstallDir, options.deps);
++  if (!options.pluginInstallDir || !stamp) {
++    throw new Error(
++      `central install (production mode): missing or invalid plugin install metadata — ` +
++        `expected ${INSTALL_STAMP_NAME} under pluginInstallDir=${options.pluginInstallDir ?? "<unset>"}. ` +
++        `Set AGENTS_COMM_BUS_BIN for source/dev mode, or fix the plugin packaging.`,
++    );
++  }
++
++  /** @type {import("./reconcile-central-install.js").InstallActor} */
++  const actor = {
++    agent: /** @type {any} */ (options.agent ?? stamp.agent),
++    comm: options.comm ?? stamp.comm,
++    pluginVersion: stamp.plugin_version,
++    daemonBundleVersion: stamp.daemon_bundle_version,
++    adapterBundleVersion: stamp.adapter_bundle_version,
++    pluginInstallDir: options.pluginInstallDir,
++    installedAt: options.installedAt ?? new Date().toISOString(),
++  };
++
++  const run = options.deps?.runCentralInstall ?? defaultRunCentralInstall;
++  const outcome = await run(options.stateRoot, actor, {
++    fs: options.deps?.fs,
++    lock: options.lock,
++    daemonRunning: options.daemonRunning ?? false,
++  });
++
++  return { mode: "production", actor, ...outcome };
++}
+diff --git a/tests/architecture/central-install-mode.test.ts b/tests/architecture/central-install-mode.test.ts
+new file mode 100644
+index 0000000..cac208b
+--- /dev/null
++++ b/tests/architecture/central-install-mode.test.ts
+@@ -0,0 +1,148 @@
++import assert from "node:assert/strict";
++import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
++import os from "node:os";
++import path from "node:path";
++import { describe, it } from "node:test";
++
++import {
++  ensureCentralInstall,
++  resolveInstallMode,
++  readInstallStamp,
++  INSTALL_STAMP_NAME,
++} from "../../hosts/common/install/ensure-central-install.js";
++import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";
++
++// ---------------------------------------------------------------------------
++// Mode contract: AGENTS_COMM_BUS_BIN is the authoritative source-mode switch;
++// production mode is strict and fails loud on missing install metadata.
++// ---------------------------------------------------------------------------
++
++async function tempRoot(): Promise<string> {
++  return mkdtemp(path.join(os.tmpdir(), "central-install-mode-"));
++}
++
++/** A production plugin dir carrying real bundle payloads + an install stamp. */
++async function fixturedPlugin(comm: string, version: string): Promise<string> {
++  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
++  await writeFile(path.join(dir, "daemon.bundle.js"), `DAEMON_BUNDLE_v${version}`, "utf8");
++  await writeFile(path.join(dir, `${comm}.adapter.bundle.js`), `${comm.toUpperCase()}_ADAPTER_v${version}`, "utf8");
++  await writeFile(
++    path.join(dir, INSTALL_STAMP_NAME),
++    JSON.stringify({
++      schema_version: 1,
++      agent: "claude",
++      comm,
++      plugin_version: version,
++      daemon_bundle_version: version,
++      adapter_bundle_version: version,
++    }),
++    "utf8",
++  );
++  return dir;
++}
++
++describe("resolveInstallMode", () => {
++  it("is source only when AGENTS_COMM_BUS_BIN is set, production otherwise", () => {
++    assert.equal(resolveInstallMode({ AGENTS_COMM_BUS_BIN: "/proj/core/index.js" }), "source");
++    assert.equal(resolveInstallMode({}), "production");
++    assert.equal(resolveInstallMode({ AGENTS_COMM_BUS_ROOT: "/proj/.acb-dev" }), "production"); // ROOT alone is not the switch
++  });
++});
++
++describe("readInstallStamp", () => {
++  it("returns null when the stamp is absent", async () => {
++    const dir = await mkdtemp(path.join(os.tmpdir(), "nostamp-"));
++    assert.equal(await readInstallStamp(dir), null);
++  });
++
++  it("returns null when required version fields are missing", async () => {
++    const dir = await mkdtemp(path.join(os.tmpdir(), "badstamp-"));
++    await writeFile(path.join(dir, INSTALL_STAMP_NAME), JSON.stringify({ agent: "claude", comm: "telegram" }), "utf8");
++    assert.equal(await readInstallStamp(dir), null);
++  });
++
++  it("parses a well-formed stamp", async () => {
++    const dir = await fixturedPlugin("telegram", "1.0.0");
++    const stamp = await readInstallStamp(dir);
++    assert.ok(stamp);
++    assert.equal(stamp.daemon_bundle_version, "1.0.0");
++  });
++});
++
++describe("ensureCentralInstall — source mode", () => {
++  it("skips central install and does NOT call runCentralInstall when AGENTS_COMM_BUS_BIN is set", async () => {
++    const root = await tempRoot();
++    let called = false;
++    const spy = async () => {
++      called = true;
++      return { plan: {} as any, result: {} as any, stoleStale: false };
++    };
++
++    const res = await ensureCentralInstall({
++      stateRoot: root,
++      comm: "telegram",
++      pluginInstallDir: "/irrelevant/in/source/mode",
++      env: { AGENTS_COMM_BUS_BIN: "/proj/core/index.js" },
++      deps: { runCentralInstall: spy },
++    });
++
++    assert.equal(res.mode, "source");
++    assert.equal(res.skipped, true);
++    assert.equal(called, false, "source mode must not run central install");
++  });
++});
++
++describe("ensureCentralInstall — production mode, strict", () => {
++  it("fails loud when pluginInstallDir is unset", async () => {
++    const root = await tempRoot();
++    await assert.rejects(
++      () => ensureCentralInstall({ stateRoot: root, comm: "telegram", env: {} }),
++      /missing or invalid plugin install metadata/,
++    );
++  });
++
++  it("fails loud when the install stamp is absent (does not silently skip)", async () => {
++    const root = await tempRoot();
++    const emptyPlugin = await mkdtemp(path.join(os.tmpdir(), "empty-plugin-"));
++    let called = false;
++    const spy = async () => {
++      called = true;
++      return { plan: {} as any, result: {} as any, stoleStale: false };
++    };
++
++    await assert.rejects(
++      () =>
++        ensureCentralInstall({
++          stateRoot: root,
++          comm: "telegram",
++          pluginInstallDir: emptyPlugin,
++          env: {},
++          deps: { runCentralInstall: spy },
++        }),
++      /missing or invalid plugin install metadata/,
++    );
++    assert.equal(called, false, "must not attempt install when metadata is missing");
++  });
++
++  it("builds the actor from the stamp and lands bundles via the real orchestrator", async () => {
++    const root = await tempRoot();
++    const plugin = await fixturedPlugin("telegram", "1.0.0");
++
++    const res = await ensureCentralInstall({
++      stateRoot: root,
++      pluginInstallDir: plugin,
++      env: {},
++      installedAt: "2026-05-29T00:00:00Z",
++    });
++
++    assert.equal(res.mode, "production");
++    assert.equal(res.actor?.daemonBundleVersion, "1.0.0");
++    assert.equal(res.actor?.pluginVersion, "1.0.0");
++
++    // The real runCentralInstall ran end-to-end: bundles + metadata on disk.
++    const paths = resolveCentralPaths(root, "telegram");
++    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
++    const dv = JSON.parse(await readFile(paths.daemonVersionFile, "utf8"));
++    assert.equal(dv.content_version, "1.0.0");
++  });
++});
+
+````
+
+---
+
+## `2de9a21` — Add stamp non-collapse regression test per review
+
+Production-path version of the T1 regression at the stamp->actor boundary: a
+hotfix stamp with higher `plugin_version` (3.0.0) shipping an older daemon bundle
+(1.0.0) must not downgrade a daemon installed at 2.0.0. Locks the version-key
+invariant at both layers (reconcile and the stamp reader).
+
+````diff
+diff --git a/tests/architecture/central-install-mode.test.ts b/tests/architecture/central-install-mode.test.ts
+index cac208b..15da813 100644
+--- a/tests/architecture/central-install-mode.test.ts
++++ b/tests/architecture/central-install-mode.test.ts
+@@ -146,3 +146,55 @@ describe("ensureCentralInstall — production mode, strict", () => {
+     assert.equal(dv.content_version, "1.0.0");
+   });
+ });
++
++describe("ensureCentralInstall — stamp keeps provenance separate from content (regression guard)", () => {
++  it("higher plugin_version shipping an older daemon bundle does not downgrade the installed daemon", async () => {
++    const root = await tempRoot();
++
++    // Seed: production install of daemon bundle 2.0.0.
++    const v2 = await fixturedPlugin("telegram", "2.0.0");
++    await ensureCentralInstall({
++      stateRoot: root,
++      pluginInstallDir: v2,
++      env: {},
++      installedAt: "2026-05-29T00:00:00Z",
++    });
++
++    // Incoming hotfix: HIGHER plugin_version (3.0.0) but an OLDER daemon bundle
++    // (1.0.0). A provenance-keyed rule would wrongly treat it as "newer" and
++    // downgrade the daemon. The stamp's three distinct fields prevent that.
++    const hotfix = await mkdtemp(path.join(os.tmpdir(), "plugin-"));
++    await writeFile(path.join(hotfix, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
++    await writeFile(path.join(hotfix, "telegram.adapter.bundle.js"), "TELEGRAM_ADAPTER_v1.0.0", "utf8");
++    await writeFile(
++      path.join(hotfix, INSTALL_STAMP_NAME),
++      JSON.stringify({
++        schema_version: 1,
++        agent: "claude",
++        comm: "telegram",
++        plugin_version: "3.0.0", // higher provenance
++        daemon_bundle_version: "1.0.0", // older content
++        adapter_bundle_version: "1.0.0",
++      }),
++      "utf8",
++    );
++
++    const res = await ensureCentralInstall({
++      stateRoot: root,
++      pluginInstallDir: hotfix,
++      env: {},
++      installedAt: "2026-05-29T01:00:00Z",
++    });
++
++    // The actor is built from three distinct fields, not a collapsed "version".
++    assert.equal(res.actor?.pluginVersion, "3.0.0");
++    assert.equal(res.actor?.daemonBundleVersion, "1.0.0");
++
++    // Install keyed off the daemon BUNDLE version (1.0.0 < installed 2.0.0) →
++    // no downgrade, regardless of the higher plugin_version.
++    const paths = resolveCentralPaths(root, "telegram");
++    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v2.0.0", "daemon not downgraded");
++    const dv = JSON.parse(await readFile(paths.daemonVersionFile, "utf8"));
++    assert.equal(dv.content_version, "2.0.0");
++  });
++});
+
+````
+
+---
+
+## `df6f660` — Validate stamp schema + resolved actor identity (Codex review)
+
+Closes a production-strict hole: the stamp reader validated only the version
+fields, so a stamp missing `agent`/`comm` could flow through to
+`adapters/undefined.js`. Now `readInstallStamp` requires `schema_version === 1`,
+and `ensureCentralInstall` validates the **resolved** identity
+(`options.* ?? stamp.*`) and fails loud before building the actor. Identity is
+checked at the resolution boundary (not in the reader) so the legitimate
+caller-override case still works. 3 tests.
+
+````diff
+diff --git a/hosts/common/install/ensure-central-install.js b/hosts/common/install/ensure-central-install.js
+index 7d59df9..942974c 100644
+--- a/hosts/common/install/ensure-central-install.js
++++ b/hosts/common/install/ensure-central-install.js
+@@ -102,6 +102,7 @@ export async function readInstallStamp(pluginInstallDir, deps = {}) {
+     const parsed = JSON.parse(raw);
+     if (
+       !parsed ||
++      parsed.schema_version !== 1 ||
+       typeof parsed.plugin_version !== "string" ||
+       typeof parsed.daemon_bundle_version !== "string" ||
+       typeof parsed.adapter_bundle_version !== "string"
+@@ -139,10 +140,29 @@ export async function ensureCentralInstall(options) {
+     );
+   }
+ 
++  // Resolve actor identity (caller override wins, else the stamp) and validate
++  // it before building the actor. Production-strict: an unresolved agent/comm
++  // must fail loud, never flow into runCentralInstall and write paths like
++  // adapters/undefined.js or metadata with an undefined comm.
++  const resolvedAgent = options.agent ?? stamp.agent;
++  const resolvedComm = options.comm ?? stamp.comm;
++  if (
++    typeof resolvedAgent !== "string" ||
++    resolvedAgent.length === 0 ||
++    typeof resolvedComm !== "string" ||
++    resolvedComm.length === 0
++  ) {
++    throw new Error(
++      `central install (production mode): install stamp resolved an invalid actor identity ` +
++        `(agent=${JSON.stringify(resolvedAgent)}, comm=${JSON.stringify(resolvedComm)}). ` +
++        `The stamp must carry agent + comm, or the caller must supply them.`,
++    );
++  }
++
+   /** @type {import("./reconcile-central-install.js").InstallActor} */
+   const actor = {
+-    agent: /** @type {any} */ (options.agent ?? stamp.agent),
+-    comm: options.comm ?? stamp.comm,
++    agent: /** @type {any} */ (resolvedAgent),
++    comm: resolvedComm,
+     pluginVersion: stamp.plugin_version,
+     daemonBundleVersion: stamp.daemon_bundle_version,
+     adapterBundleVersion: stamp.adapter_bundle_version,
+diff --git a/tests/architecture/central-install-mode.test.ts b/tests/architecture/central-install-mode.test.ts
+index 15da813..044c3f0 100644
+--- a/tests/architecture/central-install-mode.test.ts
++++ b/tests/architecture/central-install-mode.test.ts
+@@ -61,6 +61,23 @@ describe("readInstallStamp", () => {
+     assert.equal(await readInstallStamp(dir), null);
+   });
+ 
++  it("returns null when schema_version is not 1", async () => {
++    const dir = await mkdtemp(path.join(os.tmpdir(), "badschema-"));
++    await writeFile(
++      path.join(dir, INSTALL_STAMP_NAME),
++      JSON.stringify({
++        schema_version: 2,
++        agent: "claude",
++        comm: "telegram",
++        plugin_version: "1.0.0",
++        daemon_bundle_version: "1.0.0",
++        adapter_bundle_version: "1.0.0",
++      }),
++      "utf8",
++    );
++    assert.equal(await readInstallStamp(dir), null);
++  });
++
+   it("parses a well-formed stamp", async () => {
+     const dir = await fixturedPlugin("telegram", "1.0.0");
+     const stamp = await readInstallStamp(dir);
+@@ -124,6 +141,65 @@ describe("ensureCentralInstall — production mode, strict", () => {
+     assert.equal(called, false, "must not attempt install when metadata is missing");
+   });
+ 
++  it("fails loud when the stamp lacks agent/comm and the caller supplies none", async () => {
++    const root = await tempRoot();
++    // Valid versions + schema, but NO agent/comm in the stamp.
++    const dir = await mkdtemp(path.join(os.tmpdir(), "noident-"));
++    await writeFile(path.join(dir, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
++    await writeFile(path.join(dir, "telegram.adapter.bundle.js"), "TG", "utf8");
++    await writeFile(
++      path.join(dir, INSTALL_STAMP_NAME),
++      JSON.stringify({
++        schema_version: 1,
++        plugin_version: "1.0.0",
++        daemon_bundle_version: "1.0.0",
++        adapter_bundle_version: "1.0.0",
++      }),
++      "utf8",
++    );
++    let called = false;
++    const spy = async () => {
++      called = true;
++      return { plan: {} as any, result: {} as any, stoleStale: false };
++    };
++
++    await assert.rejects(
++      () => ensureCentralInstall({ stateRoot: root, pluginInstallDir: dir, env: {}, deps: { runCentralInstall: spy } }),
++      /invalid actor identity/,
++    );
++    assert.equal(called, false, "must not run install with an unresolved actor");
++  });
++
++  it("accepts caller-supplied agent/comm overriding a stamp that omits them", async () => {
++    const root = await tempRoot();
++    const dir = await mkdtemp(path.join(os.tmpdir(), "ident-override-"));
++    await writeFile(path.join(dir, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
++    await writeFile(path.join(dir, "telegram.adapter.bundle.js"), "TELEGRAM_ADAPTER_v1.0.0", "utf8");
++    await writeFile(
++      path.join(dir, INSTALL_STAMP_NAME),
++      JSON.stringify({
++        schema_version: 1,
++        plugin_version: "1.0.0",
++        daemon_bundle_version: "1.0.0",
++        adapter_bundle_version: "1.0.0",
++      }),
++      "utf8",
++    );
++
++    const res = await ensureCentralInstall({
++      stateRoot: root,
++      agent: "claude",
++      comm: "telegram",
++      pluginInstallDir: dir,
++      env: {},
++      installedAt: "2026-05-29T00:00:00Z",
++    });
++    assert.equal(res.mode, "production");
++    assert.equal(res.actor?.comm, "telegram");
++    const paths = resolveCentralPaths(root, "telegram");
++    assert.equal(await readFile(paths.adapterBundle, "utf8"), "TELEGRAM_ADAPTER_v1.0.0");
++  });
++
+   it("builds the actor from the stamp and lands bundles via the real orchestrator", async () => {
+     const root = await tempRoot();
+     const plugin = await fixturedPlugin("telegram", "1.0.0");
+
+````
+
+---
+
+## `34670d8` — Mark InstallStamp agent/comm optional in JSDoc (Codex note)
+
+Doc-only. The implementation intentionally allows the caller to supply
+`agent`/`comm`, but the `InstallStamp` typedef marked them required. Loosen the
+JSDoc to match the contract; no behavior change.
+
+````diff
+diff --git a/hosts/common/install/ensure-central-install.js b/hosts/common/install/ensure-central-install.js
+index 942974c..08b0256 100644
+--- a/hosts/common/install/ensure-central-install.js
++++ b/hosts/common/install/ensure-central-install.js
+@@ -41,8 +41,8 @@ export const INSTALL_STAMP_NAME = "install-stamp.json";
+  *
+  * @typedef {Object} InstallStamp
+  * @property {number} schema_version
+- * @property {string} agent
+- * @property {string} comm
++ * @property {string} [agent]   identity; may be omitted if the caller supplies options.agent
++ * @property {string} [comm]    identity; may be omitted if the caller supplies options.comm
+  * @property {string} plugin_version          provenance only
+  * @property {string} daemon_bundle_version   bin/daemon.js replace key
+  * @property {string} adapter_bundle_version  adapters/<comm>.js replace key
+
+````

````

---

### `9a8b535` -- Instrument Codex wake and steer app server turns

Codex-side wake/steer app-server turn-control instrumentation (Codex). In-range on universal-overhaul; not central-install.

_Files (stat):_

```
 core-daemon/bridges/codex/adapter.ts               |   8 +-
 core-daemon/bridges/codex/app-server.ts            |  85 ++++++-
 core-daemon/bridges/codex/bridge.ts                |  65 +++++
 core-daemon/daemon.ts                              |   2 +-
 core-daemon/runtime/agent-bridge.ts                |   2 +
 packages/core-contracts/src/storage/audit-store.ts |   4 +
 tests/architecture/codex-agent-adapter.test.ts     |  18 +-
 tests/architecture/codex-session-owner.test.ts     | 267 ++++++++++++++++++++-
 tests/architecture/codex-turn-control.test.ts      |  13 +
 9 files changed, 453 insertions(+), 11 deletions(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/core-daemon/bridges/codex/adapter.ts b/core-daemon/bridges/codex/adapter.ts
index b499168..9b03b0c 100644
--- a/core-daemon/bridges/codex/adapter.ts
+++ b/core-daemon/bridges/codex/adapter.ts
@@ -126,6 +126,10 @@ export class CodexAgentAdapter implements AgentAdapter {
     if (state && url) state.appServerUrl = url;
   }
 
+  appServerUrlFor(session: SessionId): string {
+    return this.sessions.get(session)?.appServerUrl ?? this.defaultAppServerUrl;
+  }
+
   async deliverInbound(session: SessionId, message: Message): Promise<void> {
     const state = this.requireSession(session);
     state.queuedInbound.push(message);
@@ -199,7 +203,9 @@ export class CodexAgentAdapter implements AgentAdapter {
       fallback_from: steerResult,
     });
     throwIfTurnFailed(wakeResult);
-    return wakeResult;
+    return wakeResult.ok
+      ? { ...wakeResult, fallbackFrom: steerResult }
+      : wakeResult;
   }
 
   async steer(session: SessionId, payload: unknown): Promise<void> {
diff --git a/core-daemon/bridges/codex/app-server.ts b/core-daemon/bridges/codex/app-server.ts
index 4181ad2..a9edb2f 100644
--- a/core-daemon/bridges/codex/app-server.ts
+++ b/core-daemon/bridges/codex/app-server.ts
@@ -10,14 +10,20 @@ const CLIENT_INFO = {
 export interface CodexAppServerClient {
   call(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
   listLoadedThreads(): Promise<unknown>;
+  listThreadTurns(threadId: string): Promise<unknown>;
   startTurn(threadId: string, text: string): Promise<unknown>;
-  steerTurn(threadId: string, text: string): Promise<unknown>;
+  steerTurn(threadId: string, text: string, expectedTurnId: string): Promise<unknown>;
   wakeMostRecentThread(text?: string): Promise<CodexTurnResult>;
   steerMostRecentThread(text: string): Promise<CodexTurnResult>;
 }
 
 export type CodexTurnResult =
-  | { ok: true; threadId: string; method: "turn/start" | "turn/steer" }
+  | {
+      ok: true;
+      threadId: string;
+      method: "turn/start" | "turn/steer";
+      fallbackFrom?: { ok: false; reason: string; error?: string; threadId?: string; raw?: string; url?: string };
+    }
   | { ok: false; reason: string; error?: string; threadId?: string; raw?: string; url?: string };
 
 export class WebSocketCodexAppServerClient implements CodexAppServerClient {
@@ -31,6 +37,10 @@ export class WebSocketCodexAppServerClient implements CodexAppServerClient {
     return this.call("thread/loaded/list", {});
   }
 
+  listThreadTurns(threadId: string): Promise<unknown> {
+    return this.call("thread/turns/list", { threadId });
+  }
+
   startTurn(threadId: string, text: string): Promise<unknown> {
     return this.call("turn/start", {
       threadId,
@@ -38,9 +48,10 @@ export class WebSocketCodexAppServerClient implements CodexAppServerClient {
     });
   }
 
-  steerTurn(threadId: string, text: string): Promise<unknown> {
+  steerTurn(threadId: string, text: string, expectedTurnId: string): Promise<unknown> {
     return this.call("turn/steer", {
       threadId,
+      expectedTurnId,
       input: [{ type: "text", text }],
     });
   }
@@ -64,8 +75,10 @@ export class WebSocketCodexAppServerClient implements CodexAppServerClient {
   async steerMostRecentThread(text: string): Promise<CodexTurnResult> {
     const thread = await this.mostRecentThread();
     if (!thread.ok) return thread;
+    const turn = await this.activeTurn(thread.threadId);
+    if (!turn.ok) return turn;
     try {
-      await this.steerTurn(thread.threadId, text);
+      await this.steerTurn(thread.threadId, text, turn.turnId);
       return { ok: true, threadId: thread.threadId, method: "turn/steer" };
     } catch (error) {
       return {
@@ -113,6 +126,46 @@ export class WebSocketCodexAppServerClient implements CodexAppServerClient {
     }
     return { ok: true, threadId };
   }
+
+  private async activeTurn(threadId: string): Promise<
+    | { ok: true; turnId: string }
+    | { ok: false; reason: string; error?: string; threadId?: string; raw?: string; url?: string }
+  > {
+    let result: unknown;
+    try {
+      result = await this.listThreadTurns(threadId);
+    } catch (error) {
+      return {
+        ok: false,
+        reason: "listThreadTurns-failed",
+        error: error instanceof Error ? error.message : String(error),
+        threadId,
+        url: this.url,
+      };
+    }
+
+    const turns = listedTurns(result);
+    if (turns.length === 0) {
+      return {
+        ok: false,
+        reason: "no-turns-loaded",
+        raw: stringifyShort(result),
+        threadId,
+      };
+    }
+
+    const active = turns.find((turn) => turnStatus(turn) === "inProgress") ?? turns[0];
+    const turnId = turnIdFrom(active);
+    if (!turnId) {
+      return {
+        ok: false,
+        reason: "no-turn-id-in-response",
+        raw: stringifyShort(active),
+        threadId,
+      };
+    }
+    return { ok: true, turnId };
+  }
 }
 
 function callOnce(
@@ -157,7 +210,7 @@ function callOnce(
         jsonrpc: "2.0",
         id: initId,
         method: "initialize",
-        params: { clientInfo: CLIENT_INFO },
+        params: { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } },
       }));
     });
 
@@ -201,6 +254,14 @@ function loadedThreads(result: unknown): unknown[] {
   return Array.isArray(candidate) ? candidate : [];
 }
 
+function listedTurns(result: unknown): unknown[] {
+  if (Array.isArray(result)) return result;
+  if (!result || typeof result !== "object") return [];
+  const record = result as Record<string, unknown>;
+  const candidate = record.data ?? record.turns ?? record.items;
+  return Array.isArray(candidate) ? candidate : [];
+}
+
 function compareThreadRecency(a: unknown, b: unknown): number {
   if (typeof a === "string" || typeof b === "string") return 0;
   const left = Date.parse(String((a as Record<string, unknown>)?.lastActiveAt
@@ -222,6 +283,20 @@ function threadIdFrom(value: unknown): string | null {
   return typeof id === "string" && id.length > 0 ? id : null;
 }
 
+function turnIdFrom(value: unknown): string | null {
+  if (typeof value === "string" && value.length > 0) return value;
+  if (!value || typeof value !== "object") return null;
+  const record = value as Record<string, unknown>;
+  const id = record.turnId ?? record.id;
+  return typeof id === "string" && id.length > 0 ? id : null;
+}
+
+function turnStatus(value: unknown): string | null {
+  if (!value || typeof value !== "object") return null;
+  const status = (value as Record<string, unknown>).status;
+  return typeof status === "string" ? status : null;
+}
+
 function parseJsonMessage(data: RawData): Record<string, any> | null {
   try {
     const value = JSON.parse(data.toString());
diff --git a/core-daemon/bridges/codex/bridge.ts b/core-daemon/bridges/codex/bridge.ts
index 81bb17b..ad38c6b 100644
--- a/core-daemon/bridges/codex/bridge.ts
+++ b/core-daemon/bridges/codex/bridge.ts
@@ -4,6 +4,7 @@ import {
   SCHEMA_VERSION_SESSION,
   type AccountId,
   type AgentId,
+  type AuditStore,
   type CallbackEvent,
   type ChatRef,
   type CommAdapter,
@@ -26,6 +27,7 @@ import type {
 import type { PendingInboundEntry } from "../../runtime/pending-inbound.js";
 import {
   CodexAgentAdapter,
+  type CodexAgentAdapterOptions,
   codexDecisionFromResolution,
   codexHookDecision,
 } from "./adapter.js";
@@ -34,8 +36,10 @@ import { cleanupManagedCodexAppServer } from "./app-server-lifecycle.js";
 export interface CodexBridgeOptions {
   storage: Storage;
   bus: MessageBus;
+  audit?: AuditStore;
   pendingInbound: PendingInboundEntry[];
   defaultAppServerUrl?: string;
+  appServerClientFactory?: CodexAgentAdapterOptions["appServerClientFactory"];
   queryPollTimeoutMs?: number;
   appServerCleanupDelayMs?: number;
   sessionOwnerCheckIntervalMs?: number;
@@ -77,6 +81,11 @@ const DEFAULT_TTL_SECONDS = 3600;
 const DEFAULT_QUERY_POLL_TIMEOUT_MS = 9 * 60 * 1000;
 const DEFAULT_APP_SERVER_CLEANUP_DELAY_MS = 3_000;
 const DEFAULT_SESSION_OWNER_CHECK_INTERVAL_MS = 10_000;
+type CodexWakeAuditKind =
+  | "agent_wake_attempt"
+  | "agent_wake_succeeded"
+  | "agent_wake_failed"
+  | "agent_wake_skipped";
 
 const CODEX_IPC_METHODS = new Set<string>([
   "codex_bootstrap_status",
@@ -100,6 +109,7 @@ export class CodexBridge implements AgentBridge {
   constructor(private readonly options: CodexBridgeOptions) {
     this.adapter = new CodexAgentAdapter({
       defaultAppServerUrl: options.defaultAppServerUrl ?? process.env.CODEX_APP_SERVER_URL,
+      appServerClientFactory: options.appServerClientFactory,
     });
   }
 
@@ -137,21 +147,45 @@ export class CodexBridge implements AgentBridge {
     const sessions = this.sessionsByProject.get(conversation.project);
     const session = sessions?.values().next().value as SessionId | undefined;
     if (!session) {
+      await this.auditWake("agent_wake_skipped", conversation, undefined, {
+        reason: "no_codex_session_for_project",
+      });
       return;
     }
     const pendingForSession = await this.pendingInboundForConversation(conversation);
     const mostRecentConversationId =
       pendingForSession.at(-1)?.conversation.conversation_id ?? conversation.conversation_id;
     await this.options.storage.setSessionMostRecentInbound(session, mostRecentConversationId);
+    await this.auditWake("agent_wake_attempt", conversation, session, {
+      app_server_url: this.adapter.appServerUrlFor(session),
+      pending_count: pendingForSession.length,
+      pending_message_ids: pendingForSession.map((entry) => entry.message.message_id),
+      pending_conversation_ids: [...new Set(pendingForSession.map((entry) => entry.conversation.conversation_id))],
+    });
     try {
       const result = await this.adapter.wakeOrSteer(
         session,
         formatInboundMessagesForTurn(pendingForSession),
       );
       if (result.ok) {
+        await this.auditWake("agent_wake_succeeded", conversation, session, {
+          app_server_url: this.adapter.appServerUrlFor(session),
+          method: result.method,
+          thread_id: result.threadId,
+          fallback_reason: result.fallbackFrom?.reason,
+          fallback_error: result.fallbackFrom?.error,
+          fallback_thread_id: result.fallbackFrom?.threadId,
+          pending_count: pendingForSession.length,
+          removed_pending_count: pendingForSession.length,
+        });
         this.removePendingInbound(pendingForSession);
       }
     } catch (error) {
+      await this.auditWake("agent_wake_failed", conversation, session, {
+        app_server_url: this.adapter.appServerUrlFor(session),
+        pending_count: pendingForSession.length,
+        error: error instanceof Error ? error.message : String(error),
+      });
       console.error(
         `agents-comm-bus: failed to wake Codex for ${conversation.conversation_id}: ` +
           `${error instanceof Error ? error.message : String(error)}`,
@@ -584,6 +618,36 @@ export class CodexBridge implements AgentBridge {
     };
   }
 
+  private async auditWake(
+    kind: CodexWakeAuditKind,
+    conversation: Conversation,
+    session: SessionId | undefined,
+    detail: Record<string, unknown>,
+  ): Promise<void> {
+    try {
+      await this.options.audit?.append({
+        timestamp: Date.now(),
+        kind,
+        agent: this.agentId,
+        session,
+        conversation_id: conversation.conversation_id,
+        detail: {
+          comm: conversation.comm,
+          account_label: conversation.account_label,
+          chat_native_id: conversation.chat_native_id,
+          thread_native_id: conversation.thread_native_id ?? undefined,
+          project: conversation.project,
+          ...detail,
+        },
+      });
+    } catch (error) {
+      console.error(
+        `agents-comm-bus: failed to audit Codex wake event for ${conversation.conversation_id}: ` +
+          `${error instanceof Error ? error.message : String(error)}`,
+      );
+    }
+  }
+
   private async pendingInboundForConversation(
     conversation: Conversation,
   ): Promise<PendingInboundEntry[]> {
@@ -787,6 +851,7 @@ export class CodexBridgeFactory implements AgentBridgeFactory {
     return new CodexBridge({
       storage: context.storage,
       bus: context.bus,
+      audit: context.audit,
       pendingInbound: context.pendingInbound,
     });
   }
diff --git a/core-daemon/daemon.ts b/core-daemon/daemon.ts
index 7ad2f9e..c15a96e 100644
--- a/core-daemon/daemon.ts
+++ b/core-daemon/daemon.ts
@@ -109,7 +109,7 @@ export async function runDaemon(options: RunDaemonOptions): Promise<void> {
   });
 
   const bridges: AgentBridge[] = options.agentBridgeFactories.map((factory) =>
-    factory.create({ storage, bus, pendingInbound }),
+    factory.create({ storage, bus, audit, pendingInbound }),
   );
 
   bus.setDispatchSink({
diff --git a/core-daemon/runtime/agent-bridge.ts b/core-daemon/runtime/agent-bridge.ts
index 27d3c0c..db4fe2c 100644
--- a/core-daemon/runtime/agent-bridge.ts
+++ b/core-daemon/runtime/agent-bridge.ts
@@ -1,6 +1,7 @@
 import type {
   AccountId,
   AgentId,
+  AuditStore,
   CommAdapter,
   CommId,
   Conversation,
@@ -14,6 +15,7 @@ import type { PendingInboundEntry } from "./pending-inbound.js";
 export interface AgentBridgeContext {
   storage: Storage;
   bus: MessageBus;
+  audit: AuditStore;
   pendingInbound: PendingInboundEntry[];
 }
 
diff --git a/packages/core-contracts/src/storage/audit-store.ts b/packages/core-contracts/src/storage/audit-store.ts
index 9e153db..09cc6ca 100644
--- a/packages/core-contracts/src/storage/audit-store.ts
+++ b/packages/core-contracts/src/storage/audit-store.ts
@@ -15,6 +15,10 @@ export type AuditEventKind =
   | "query_rejected_stale"
   | "session_lease_acquired"
   | "session_lease_released"
+  | "agent_wake_attempt"
+  | "agent_wake_succeeded"
+  | "agent_wake_failed"
+  | "agent_wake_skipped"
   | "registration_added"
   | "registration_removed"
   | "loop_prevention_drop";
diff --git a/tests/architecture/codex-agent-adapter.test.ts b/tests/architecture/codex-agent-adapter.test.ts
index d0f6154..1eb09ae 100644
--- a/tests/architecture/codex-agent-adapter.test.ts
+++ b/tests/architecture/codex-agent-adapter.test.ts
@@ -82,7 +82,17 @@ describe("CodexAgentAdapter", () => {
 
     const result = await adapter.wakeOrSteer(session, { text: "new Telegram guidance" });
 
-    assert.deepEqual(result, { ok: true, threadId: "thread-1", method: "turn/start" });
+    assert.deepEqual(result, {
+      ok: true,
+      threadId: "thread-1",
+      method: "turn/start",
+      fallbackFrom: {
+        ok: false,
+        reason: "steerTurn-failed",
+        error: "no active turn",
+        threadId: "thread-1",
+      },
+    });
     assert.equal(control.sent.at(-2)?.type, "turn.steer");
     assert.equal(control.sent.at(-1)?.type, "turn.wake");
     assert.deepEqual(fake.calls, [
@@ -214,12 +224,16 @@ class FakeCodexClient {
     return { data: ["thread-1"] };
   }
 
+  async listThreadTurns(): Promise<unknown> {
+    return { data: [{ id: "turn-1", status: "inProgress" }] };
+  }
+
   async startTurn(_threadId: string, text: string): Promise<unknown> {
     this.calls.push(["turn/start", text]);
     return {};
   }
 
-  async steerTurn(_threadId: string, text: string): Promise<unknown> {
+  async steerTurn(_threadId: string, text: string, _expectedTurnId: string): Promise<unknown> {
     this.calls.push(["turn/steer", text]);
     return {};
   }
diff --git a/tests/architecture/codex-session-owner.test.ts b/tests/architecture/codex-session-owner.test.ts
index c8fd712..040ba7b 100644
--- a/tests/architecture/codex-session-owner.test.ts
+++ b/tests/architecture/codex-session-owner.test.ts
@@ -6,14 +6,47 @@ import assert from "node:assert/strict";
 
 import { CodexBridge } from "../../core-daemon/bridges/codex/bridge.js";
 import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
-import type { SessionId } from "../../packages/core-contracts/src/types.js";
+import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";
+import type {
+  AccountRegistration,
+  AuditEvent,
+  Conversation,
+  Message,
+  Session,
+  Storage,
+} from "../../packages/core-contracts/src/index.js";
+import {
+  SCHEMA_VERSION_ACCOUNT,
+  SCHEMA_VERSION_CONVERSATION,
+  SCHEMA_VERSION_MESSAGE,
+  type AccountId,
+  type AgentId,
+  type CommId,
+  type ConversationId,
+  type MessageId,
+  type SessionId,
+} from "../../packages/core-contracts/src/types.js";
 
 async function withStorage<T>(test: (dbPath: string) => Promise<T>): Promise<T> {
   const dir = await mkdtemp(join(tmpdir(), "acb-codex-owner-"));
   try {
     return await test(join(dir, "storage.db"));
   } finally {
-    await rm(dir, { recursive: true, force: true });
+    await removeTempDir(dir);
+  }
+}
+
+async function removeTempDir(dir: string): Promise<void> {
+  for (let attempt = 0; attempt < 20; attempt += 1) {
+    try {
+      await rm(dir, { recursive: true, force: true });
+      return;
+    } catch (error) {
+      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 19) {
+        throw error;
+      }
+      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
+    }
   }
 }
 
@@ -46,4 +79,234 @@ describe("Codex session owner liveness", () => {
       await storage.close();
     });
   });
+
+  it("audits Codex wake attempts and app-server results", async () => {
+    {
+      const storage = new RecordingStorage([registrationRecord()]);
+      const pendingInbound: PendingInboundEntry[] = [];
+      const audit = new RecordingAuditStore();
+      const fakeClient = new FakeCodexClient();
+      const bridge = new CodexBridge({
+        storage,
+        bus: {} as never,
+        audit,
+        pendingInbound,
+        appServerClientFactory: () => fakeClient,
+      });
+
+      const session = "codex-session" as SessionId;
+      const socket = new FakeSocket();
+      await bridge.registerSession({
+        session,
+        project: "project-a",
+        app_server_url: "ws://127.0.0.1:4509",
+      }, socket);
+
+      const conversation = conversationRecord();
+      pendingInbound.push({ message: messageRecord(), conversation });
+
+      await bridge.onInboundConversation(conversation);
+
+      assert.deepEqual(fakeClient.calls, [
+        ["turn/steer", "thread-1"],
+      ]);
+      assert.equal(pendingInbound.length, 0);
+
+      const attempt = audit.events.find((event) => event.kind === "agent_wake_attempt");
+      assert.ok(attempt);
+      assert.equal(attempt.session, session);
+      assert.equal(attempt.conversation_id, conversation.conversation_id);
+      assert.equal(attempt.detail?.app_server_url, "ws://127.0.0.1:4509");
+      assert.deepEqual(attempt.detail?.pending_message_ids, ["telegram:1"]);
+
+      const succeeded = audit.events.find((event) => event.kind === "agent_wake_succeeded");
+      assert.ok(succeeded);
+      assert.equal(succeeded.session, session);
+      assert.equal(succeeded.detail?.method, "turn/steer");
+      assert.equal(succeeded.detail?.thread_id, "thread-1");
+
+      socket.close();
+      await waitForLeaseRelease(storage, session);
+      await storage.close();
+    }
+  });
 });
+
+async function waitForLeaseRelease(
+  storage: Awaited<ReturnType<typeof openSqliteStorage>>,
+  session: SessionId,
+): Promise<void> {
+  for (let attempt = 0; attempt < 20; attempt += 1) {
+    const record = await storage.getSession(session);
+    if (record?.lease_holder_connection_id === null) return;
+    await new Promise((resolve) => setTimeout(resolve, 10));
+  }
+}
+
+function registrationRecord(): AccountRegistration {
+  return {
+    schema_version: SCHEMA_VERSION_ACCOUNT,
+    project: "project-a",
+    agent: "codex" as AgentId,
+    comm: "telegram" as CommId,
+    account_label: "main",
+    bot_user_id: "bot-1",
+    credentials_ref: "file:/dev/null",
+    created_at: 1,
+    updated_at: 1,
+  };
+}
+
+function conversationRecord(): Conversation {
+  return {
+    schema_version: SCHEMA_VERSION_CONVERSATION,
+    project: "project-a",
+    agent: "codex" as AgentId,
+    comm: "telegram" as CommId,
+    account_label: "main",
+    chat_native_id: "-100group",
+    thread_native_id: null,
+    conversation_id: "conv-test" as ConversationId,
+    last_inbound_at: 10,
+    last_outbound_at: null,
+    last_message_id: "telegram:1" as MessageId,
+    created_at: 10,
+  };
+}
+
+function messageRecord(): Message {
+  return {
+    schema_version: SCHEMA_VERSION_MESSAGE,
+    message_id: "telegram:1" as MessageId,
+    chat: {
+      comm: "telegram" as CommId,
+      account: "bot-1" as AccountId,
+      chat_native_id: "-100group",
+    },
+    sender: {
+      id: "user-1",
+      display_name: "Satrio",
+      isBot: false,
+      isForeignBot: false,
+    },
+    origin: { comm: "telegram" as CommId },
+    text: "group wake probe",
+    attachments: [],
+    platform_message_id: "1",
+    hop_count: 0,
+    received_at: 10,
+  };
+}
+
+class RecordingAuditStore {
+  readonly events: AuditEvent[] = [];
+
+  async append(event: AuditEvent): Promise<void> {
+    this.events.push(event);
+  }
+}
+
+class RecordingStorage implements Partial<Storage> {
+  private readonly sessions = new Map<SessionId, Session>();
+
+  constructor(private readonly registrations: AccountRegistration[]) {}
+
+  async listAccountRegistrations(): Promise<AccountRegistration[]> {
+    return this.registrations;
+  }
+
+  async upsertSession(rec: Session): Promise<void> {
+    this.sessions.set(rec.session_id, rec);
+  }
+
+  async acquireSessionLease(
+    session: SessionId,
+    connectionId: string,
+    at: number,
+  ): Promise<boolean> {
+    const record = this.sessions.get(session);
+    if (!record) return false;
+    this.sessions.set(session, {
+      ...record,
+      lease_holder_connection_id: connectionId,
+      lease_acquired_at: at,
+    });
+    return true;
+  }
+
+  async releaseSessionLease(session: SessionId, connectionId: string, at: number): Promise<void> {
+    const record = this.sessions.get(session);
+    if (!record || record.lease_holder_connection_id !== connectionId) return;
+    this.sessions.set(session, {
+      ...record,
+      lease_holder_connection_id: null,
+      lease_released_at: at,
+    });
+  }
+
+  async setSessionMostRecentInbound(
+    session: SessionId,
+    conversationId: ConversationId,
+  ): Promise<void> {
+    const record = this.sessions.get(session);
+    if (!record) return;
+    this.sessions.set(session, {
+      ...record,
+      most_recent_inbound_conversation_id: conversationId,
+    });
+  }
+
+  async getSession(session: SessionId): Promise<Session | null> {
+    return this.sessions.get(session) ?? null;
+  }
+
+  async close(): Promise<void> {}
+}
+
+class FakeCodexClient {
+  readonly calls: Array<[string, string]> = [];
+
+  async call(): Promise<unknown> {
+    return {};
+  }
+
+  async listLoadedThreads(): Promise<unknown> {
+    return { data: ["thread-1"] };
+  }
+
+  async listThreadTurns(): Promise<unknown> {
+    return { data: [{ id: "turn-1", status: "inProgress" }] };
+  }
+
+  async startTurn(threadId: string): Promise<unknown> {
+    this.calls.push(["turn/start", threadId]);
+    return {};
+  }
+
+  async steerTurn(threadId: string, _text: string, _expectedTurnId: string): Promise<unknown> {
+    this.calls.push(["turn/steer", threadId]);
+    return {};
+  }
+
+  async wakeMostRecentThread(): Promise<any> {
+    await this.startTurn("thread-1");
+    return { ok: true, threadId: "thread-1", method: "turn/start" };
+  }
+
+  async steerMostRecentThread(): Promise<any> {
+    await this.steerTurn("thread-1");
+    return { ok: true, threadId: "thread-1", method: "turn/steer" };
+  }
+}
+
+class FakeSocket {
+  private closeHandler: (() => void) | null = null;
+
+  once(event: "close", handler: () => void): void {
+    if (event === "close") this.closeHandler = handler;
+  }
+
+  close(): void {
+    this.closeHandler?.();
+  }
+}
diff --git a/tests/architecture/codex-turn-control.test.ts b/tests/architecture/codex-turn-control.test.ts
index 73566e3..48f463a 100644
--- a/tests/architecture/codex-turn-control.test.ts
+++ b/tests/architecture/codex-turn-control.test.ts
@@ -17,6 +17,7 @@ describe("Codex app-server turn control", () => {
     socket.on("message", (data) => {
       const request = JSON.parse(data.toString());
       if (request.method === "initialize") {
+        assert.equal(request.params?.capabilities?.experimentalApi, true);
         socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
         return;
       }
@@ -29,6 +30,17 @@ describe("Codex app-server turn control", () => {
         }));
         return;
       }
+      if (request.method === "thread/turns/list") {
+        socket.send(JSON.stringify({
+          jsonrpc: "2.0",
+          id: request.id,
+          result: { data: [{ id: "turn-1", status: "inProgress" }] },
+        }));
+        return;
+      }
+      if (request.method === "turn/steer") {
+        assert.equal(request.params?.expectedTurnId, "turn-1");
+      }
       socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }));
     });
   });
@@ -47,6 +59,7 @@ describe("Codex app-server turn control", () => {
       "thread/loaded/list",
       "turn/start",
       "thread/loaded/list",
+      "thread/turns/list",
       "turn/steer",
     ]);
   });

````

---

### `c562a16` -- Set SQLite busy_timeout to stop dropped inbound under multi-bot writes

Reliability fix: PRAGMA busy_timeout=5000 so concurrent multi-bot writers wait for the SQLite lock instead of dropping with 'database is locked' (root cause of dropped group inbound).

_Files (stat):_

```
 core-daemon/storage/sqlite.ts | 8 ++++++++
 1 file changed, 8 insertions(+)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/core-daemon/storage/sqlite.ts b/core-daemon/storage/sqlite.ts
index e5135e4..c92ff32 100644
--- a/core-daemon/storage/sqlite.ts
+++ b/core-daemon/storage/sqlite.ts
@@ -50,6 +50,14 @@ export class SqliteStorage implements Storage {
   static async open(path: string): Promise<SqliteStorage> {
     const db = new DatabaseSync(path);
     db.exec("PRAGMA foreign_keys = ON");
+    // Wait for the write lock instead of failing instantly with SQLITE_BUSY.
+    // The daemon is multi-writer: with one Telegram bot per agent, the same
+    // group message arrives at both bots near-simultaneously and both record
+    // inbound at once. Without busy_timeout the loser of that race gets
+    // "database is locked" and the write is dropped — the symptom being a group
+    // message that reaches only one agent. WAL keeps readers off writers but
+    // does not serialize two concurrent writers.
+    db.exec("PRAGMA busy_timeout = 5000");
     await runStorageMigrations(db);
     return new SqliteStorage(db);
   }

````

---

### `04e9fb4` -- Scope comm_check_messages drain by the caller's owned accounts

Reliability fix: the generic drain now scopes by the caller session's owned (comm,bot) accounts, so one agent's comm_check_messages can't cannibalize another agent's pending inbound.

_Files (stat):_

```
 core-daemon/daemon.ts                            | 62 ++++++++++++++++++----
 tests/architecture/drain-pending-inbound.test.ts | 66 ++++++++++++++++++++++++
 2 files changed, 118 insertions(+), 10 deletions(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/core-daemon/daemon.ts b/core-daemon/daemon.ts
index c15a96e..87f19e8 100644
--- a/core-daemon/daemon.ts
+++ b/core-daemon/daemon.ts
@@ -5,6 +5,7 @@ import {
   type AccountRegistration,
   type CommAdapter,
   type CommId,
+  type SessionId,
   type Storage,
 } from "agents-comm-bus-core";
 import { DAEMON_VERSION } from "./config.js";
@@ -148,9 +149,14 @@ export async function runDaemon(options: RunDaemonOptions): Promise<void> {
   // Generic drain of the shared pendingInbound queue. Used by the MCP shim's
   // `comm_check_messages` tool so the shim doesn't have to know any per-comm
   // IPC method names.
-  ipcMethods.set("drain_pending_inbound", async (params) =>
-    drainPendingInbound(pendingInbound, params),
-  );
+  ipcMethods.set("drain_pending_inbound", async (params) => {
+    const base = params ?? {};
+    // Scope the drain to the calling session's owned bot accounts so one
+    // agent's `comm_check_messages` cannot cannibalize another agent's pending
+    // inbound (Claude + Codex share comm="telegram" with different bots).
+    const ownedAccountKeys = await resolveOwnedAccountKeys(storage, base.session);
+    return drainPendingInbound(pendingInbound, { ...base, ownedAccountKeys });
+  });
   const bridgesByMethod = new Map<string, AgentBridge>();
   for (const bridge of bridges) {
     for (const method of bridge.ipcMethods) {
@@ -444,8 +450,18 @@ export async function reloadAdapters(input: {
  * would destructively drain ALL comms and the caller would merely filter
  * client-side, losing the other comms' pending entries as collateral.
  *
- * When `comm` is omitted (or empty / non-string), the behavior is the
- * historical global drain: the entire queue is spliced.
+ * When `ownedAccountKeys` is supplied (a Set of `${comm}:${account}` keys),
+ * the drain is additionally scoped to those accounts â€” only entries the caller
+ * actually owns are removed. This is essential in a multi-bot setup where two
+ * agents share a comm (Claude + Codex both on telegram with different bot
+ * accounts): without account scoping a `comm_check_messages` from one agent
+ * destructively drains the OTHER agent's pending inbound as collateral, so the
+ * other agent's wake-driven drain then finds an empty queue and never injects
+ * the message. An empty Set drains nothing.
+ *
+ * When neither `comm` nor `ownedAccountKeys` is supplied, the behavior is the
+ * historical global drain: the entire queue is spliced (internal/legacy callers
+ * without a session).
  *
  * Returned entries preserve queue order (oldest first).
  */
@@ -455,19 +471,45 @@ export function drainPendingInbound(
 ): PendingInboundEntry[] {
   const raw = params?.comm;
   const commFilter = typeof raw === "string" && raw.length > 0 ? raw : null;
-  if (!commFilter) {
+  const owned = params?.ownedAccountKeys instanceof Set
+    ? (params.ownedAccountKeys as Set<string>)
+    : null;
+  if (!commFilter && owned === null) {
     return queue.splice(0);
   }
   const drained: PendingInboundEntry[] = [];
   for (let i = queue.length - 1; i >= 0; i -= 1) {
-    if (queue[i].message.chat.comm === commFilter) {
-      drained.unshift(queue[i]);
-      queue.splice(i, 1);
-    }
+    const entry = queue[i];
+    if (commFilter && entry.message.chat.comm !== commFilter) continue;
+    if (owned !== null && !owned.has(pendingAccountKey(entry))) continue;
+    drained.unshift(entry);
+    queue.splice(i, 1);
   }
   return drained;
 }
 
+function pendingAccountKey(entry: PendingInboundEntry): string {
+  return `${entry.message.chat.comm}:${entry.message.chat.account}`;
+}
+
+/**
+ * Resolve the bot accounts a calling session owns, as `${comm}:${account}`
+ * keys, for scoping a generic drain. Mirrors the per-agent ownership the
+ * bridges use. Returns undefined when there is no session (legacy caller â†’
+ * fall back to comm/global), and an empty Set when the session is unknown
+ * (scope to nothing rather than global-wipe).
+ */
+async function resolveOwnedAccountKeys(
+  storage: Storage,
+  session: unknown,
+): Promise<Set<string> | undefined> {
+  if (typeof session !== "string" || session.length === 0) return undefined;
+  const sess = await storage.getSession(session as SessionId);
+  if (!sess) return new Set<string>();
+  const regs = await storage.listAccountRegistrations({ agent: sess.agent });
+  return new Set(regs.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
+}
+
 function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
   if (a.length !== b.length) return false;
   const set = new Set(a);
diff --git a/tests/architecture/drain-pending-inbound.test.ts b/tests/architecture/drain-pending-inbound.test.ts
index f37b0e2..2bca91a 100644
--- a/tests/architecture/drain-pending-inbound.test.ts
+++ b/tests/architecture/drain-pending-inbound.test.ts
@@ -157,3 +157,69 @@ describe("drainPendingInbound (scoped drain)", () => {
     assert.equal(queue.length, 2, "no entries removed when filter matches nothing");
   });
 });
+
+function entryAcct(id: string, comm: CommId, account: string): PendingInboundEntry {
+  const e = entry(id, comm);
+  e.message.chat.account = account as AccountId;
+  return e;
+}
+
+describe("drainPendingInbound (account-scoped drain)", () => {
+  it("removes only the caller's owned-account entries, leaving another agent's entries", () => {
+    // Claude + Codex share comm=telegram with different bot accounts. A Claude
+    // check must not cannibalize Codex's pending inbound, and vice versa.
+    const queue: PendingInboundEntry[] = [
+      entryAcct("1", TELEGRAM, "claude-bot"),
+      entryAcct("2", TELEGRAM, "codex-bot"),
+      entryAcct("3", TELEGRAM, "claude-bot"),
+    ];
+
+    const drained = drainPendingInbound(queue, {
+      ownedAccountKeys: new Set(["telegram:claude-bot"]),
+    });
+
+    assert.deepEqual(
+      drained.map((e) => e.message.platform_message_id),
+      ["1", "3"],
+      "only claude-owned entries drain",
+    );
+    assert.deepEqual(
+      queue.map((e) => e.message.platform_message_id),
+      ["2"],
+      "the codex-bot entry must survive the claude check",
+    );
+  });
+
+  it("drains nothing for an empty owned set (unknown session must not global-wipe)", () => {
+    const queue: PendingInboundEntry[] = [entryAcct("1", TELEGRAM, "claude-bot")];
+
+    const drained = drainPendingInbound(queue, { ownedAccountKeys: new Set<string>() });
+
+    assert.equal(drained.length, 0);
+    assert.equal(queue.length, 1, "empty owned set must NOT fall through to a global drain");
+  });
+
+  it("combines the comm filter with account ownership", () => {
+    const queue: PendingInboundEntry[] = [
+      entryAcct("1", TELEGRAM, "claude-bot"),
+      entryAcct("2", MATRIX, "claude-bot"),
+      entryAcct("3", TELEGRAM, "codex-bot"),
+    ];
+
+    const drained = drainPendingInbound(queue, {
+      comm: "telegram",
+      ownedAccountKeys: new Set(["telegram:claude-bot", "matrix:claude-bot"]),
+    });
+
+    assert.deepEqual(
+      drained.map((e) => e.message.platform_message_id),
+      ["1"],
+      "must match BOTH the comm filter and account ownership",
+    );
+    assert.deepEqual(
+      queue.map((e) => e.message.platform_message_id),
+      ["2", "3"],
+      "matrix-owned and codex-owned entries remain",
+    );
+  });
+});

````

---

### `c38a3c7` -- Audit inbound dispatch bridge flow

Observability (Codex): inbound_dispatch_{enqueued,bridge_invoked,bridge_completed,bridge_failed} audit events around the dispatch->bridge wake path.

_Files (stat):_

```
 core-daemon/daemon.ts                              | 50 ++++++++++++++++++++++
 packages/core-contracts/src/storage/audit-store.ts |  4 ++
 2 files changed, 54 insertions(+)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/core-daemon/daemon.ts b/core-daemon/daemon.ts
index 87f19e8..f4cbb0a 100644
--- a/core-daemon/daemon.ts
+++ b/core-daemon/daemon.ts
@@ -119,11 +119,61 @@ export async function runDaemon(options: RunDaemonOptions): Promise<void> {
       if (pendingInbound.length > 100) {
         pendingInbound.splice(0, pendingInbound.length - 100);
       }
+      await audit.append({
+        timestamp: Date.now(),
+        kind: "inbound_dispatch_enqueued",
+        agent: conversation.agent,
+        conversation_id: conversation.conversation_id,
+        detail: {
+          comm: message.chat.comm,
+          account: message.chat.account,
+          account_label: conversation.account_label,
+          platform_message_id: message.platform_message_id,
+          message_id: message.message_id,
+          queue_length: pendingInbound.length,
+        },
+      });
       for (const bridge of bridges) {
         if (bridge.onInboundConversation) {
           try {
+            await audit.append({
+              timestamp: Date.now(),
+              kind: "inbound_dispatch_bridge_invoked",
+              agent: bridge.agentId,
+              conversation_id: conversation.conversation_id,
+              detail: {
+                conversation_agent: conversation.agent,
+                platform_message_id: message.platform_message_id,
+                message_id: message.message_id,
+                queue_length: pendingInbound.length,
+              },
+            });
             await bridge.onInboundConversation(conversation);
+            await audit.append({
+              timestamp: Date.now(),
+              kind: "inbound_dispatch_bridge_completed",
+              agent: bridge.agentId,
+              conversation_id: conversation.conversation_id,
+              detail: {
+                conversation_agent: conversation.agent,
+                platform_message_id: message.platform_message_id,
+                message_id: message.message_id,
+                queue_length: pendingInbound.length,
+              },
+            });
           } catch (error) {
+            await audit.append({
+              timestamp: Date.now(),
+              kind: "inbound_dispatch_bridge_failed",
+              agent: bridge.agentId,
+              conversation_id: conversation.conversation_id,
+              detail: {
+                conversation_agent: conversation.agent,
+                platform_message_id: message.platform_message_id,
+                message_id: message.message_id,
+                error: error instanceof Error ? error.message : String(error),
+              },
+            });
             console.error(
               `agents-comm-bus: bridge ${bridge.agentId} onInboundConversation failed: ` +
                 `${error instanceof Error ? error.message : String(error)}`,
diff --git a/packages/core-contracts/src/storage/audit-store.ts b/packages/core-contracts/src/storage/audit-store.ts
index 09cc6ca..3294717 100644
--- a/packages/core-contracts/src/storage/audit-store.ts
+++ b/packages/core-contracts/src/storage/audit-store.ts
@@ -19,6 +19,10 @@ export type AuditEventKind =
   | "agent_wake_succeeded"
   | "agent_wake_failed"
   | "agent_wake_skipped"
+  | "inbound_dispatch_enqueued"
+  | "inbound_dispatch_bridge_invoked"
+  | "inbound_dispatch_bridge_completed"
+  | "inbound_dispatch_bridge_failed"
   | "registration_added"
   | "registration_removed"
   | "loop_prevention_drop";

````

---

### `42ab787` -- Rebuild daemon dist for 04e9fb4 + c38a3c7

Build artifact: dist rebuild reflecting the drain + dispatch source commits (deferred-then-landed jointly). Stat only below.

_Files (stat):_

```
```

_Source diff (dist/plugins excluded):_

````diff

````

---

### `fd36433` -- Add restart-daemon.ps1 to reap ALL stale serve.js daemons

Ops: restart-daemon.ps1 reaps ALL of this repo's serve.js daemons (not just daemon.pid's) before respawn, closing the orphan-accumulation hole. Sibling to the AGE-12 watchdog.

_Files (stat):_

```
 core-daemon/bootstrap/pid-watchdog.ts              | 221 +++++++++++++++++++++
 core-daemon/daemon.ts                              |  18 ++
 packages/core-contracts/src/storage/audit-store.ts |   3 +
 scripts/restart-daemon.ps1                         | 143 +++++++++++++
 tests/architecture/daemon-pid-watchdog.test.ts     | 180 +++++++++++++++++
 5 files changed, 565 insertions(+)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/core-daemon/bootstrap/pid-watchdog.ts b/core-daemon/bootstrap/pid-watchdog.ts
new file mode 100644
index 0000000..f5fd659
--- /dev/null
+++ b/core-daemon/bootstrap/pid-watchdog.ts
@@ -0,0 +1,221 @@
+import { readFile } from "node:fs/promises";
+
+import type { AuditStore } from "agents-comm-bus-core";
+import { writeDaemonDiscoveryFiles } from "./ensure-daemon.js";
+
+export type DaemonPidWatchdogResult =
+  | { status: "current"; selfPid: number }
+  | { status: "superseded"; selfPid: number; ownerPid: number }
+  | { status: "reclaimed"; selfPid: number; reason: "missing" | "dead_owner"; ownerPid?: number }
+  | { status: "stayed_alive"; selfPid: number; reason: "invalid_pid" | "read_error" | "liveness_error"; ownerPid?: number; error?: string };
+
+export type PidFileRead =
+  | { status: "pid"; pid: number }
+  | { status: "missing" }
+  | { status: "invalid"; raw: string }
+  | { status: "error"; error: unknown };
+
+export interface DaemonPidWatchdogCheckOptions {
+  stateRoot?: string;
+  pidFile: string;
+  port: number;
+  selfPid?: number;
+  readPidFile?: (pidFile: string) => Promise<PidFileRead>;
+  isPidAlive?: (pid: number) => boolean;
+  writeDiscoveryFiles?: typeof writeDaemonDiscoveryFiles;
+}
+
+export interface DaemonPidWatchdogTickOptions extends DaemonPidWatchdogCheckOptions {
+  audit?: AuditStore;
+  stopDaemon?: () => Promise<void> | void;
+  exitProcess?: (code: number) => void;
+}
+
+export interface StartDaemonPidWatchdogOptions extends DaemonPidWatchdogTickOptions {
+  intervalMs?: number;
+  initialDelayMs?: number;
+}
+
+export interface DaemonPidWatchdogHandle {
+  stop(): void;
+}
+
+export function startDaemonPidWatchdog(
+  options: StartDaemonPidWatchdogOptions,
+): DaemonPidWatchdogHandle {
+  const intervalMs = options.intervalMs ?? 30_000;
+  const initialDelayMs = options.initialDelayMs ?? 5_000;
+  let stopped = false;
+  let running = false;
+  let interval: NodeJS.Timeout | undefined;
+
+  const run = (): void => {
+    if (stopped || running) return;
+    running = true;
+    void runDaemonPidWatchdogTick(options)
+      .catch((error) => {
+        console.error(
+          `agents-comm-bus: daemon pid watchdog failed: ` +
+            `${error instanceof Error ? error.message : String(error)}`,
+        );
+      })
+      .finally(() => {
+        running = false;
+      });
+  };
+
+  const timeout = setTimeout(() => {
+    run();
+    interval = setInterval(run, intervalMs);
+  }, initialDelayMs);
+
+  return {
+    stop() {
+      stopped = true;
+      clearTimeout(timeout);
+      if (interval) clearInterval(interval);
+    },
+  };
+}
+
+export async function runDaemonPidWatchdogTick(
+  options: DaemonPidWatchdogTickOptions,
+): Promise<DaemonPidWatchdogResult> {
+  const result = await checkDaemonPidOwnership(options);
+
+  if (result.status === "superseded") {
+    await appendAudit(options.audit, {
+      kind: "daemon_superseded",
+      detail: {
+        self_pid: result.selfPid,
+        canonical_pid: result.ownerPid,
+      },
+    });
+    await options.stopDaemon?.();
+    (options.exitProcess ?? ((code: number) => process.exit(code)))(0);
+    return result;
+  }
+
+  if (result.status === "reclaimed") {
+    await appendAudit(options.audit, {
+      kind: "daemon_discovery_reclaimed",
+      detail: {
+        self_pid: result.selfPid,
+        reason: result.reason,
+        previous_pid: result.ownerPid,
+      },
+    });
+  } else if (result.status === "stayed_alive") {
+    await appendAudit(options.audit, {
+      kind: "daemon_pid_watchdog_error",
+      detail: {
+        self_pid: result.selfPid,
+        reason: result.reason,
+        owner_pid: result.ownerPid,
+        error: result.error,
+      },
+    });
+  }
+
+  return result;
+}
+
+export async function checkDaemonPidOwnership(
+  options: DaemonPidWatchdogCheckOptions,
+): Promise<DaemonPidWatchdogResult> {
+  const selfPid = options.selfPid ?? process.pid;
+  const read = options.readPidFile ?? readPidFile;
+  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
+  const writeDiscovery = options.writeDiscoveryFiles ?? writeDaemonDiscoveryFiles;
+
+  const pidFile = await read(options.pidFile);
+  if (pidFile.status === "missing") {
+    await writeDiscovery({ stateRoot: options.stateRoot, pid: selfPid, port: options.port });
+    return { status: "reclaimed", selfPid, reason: "missing" };
+  }
+
+  if (pidFile.status === "invalid") {
+    return {
+      status: "stayed_alive",
+      selfPid,
+      reason: "invalid_pid",
+      error: `invalid pid file content: ${JSON.stringify(pidFile.raw)}`,
+    };
+  }
+
+  if (pidFile.status === "error") {
+    return {
+      status: "stayed_alive",
+      selfPid,
+      reason: "read_error",
+      error: errorMessage(pidFile.error),
+    };
+  }
+
+  if (pidFile.pid === selfPid) {
+    return { status: "current", selfPid };
+  }
+
+  let ownerAlive: boolean;
+  try {
+    ownerAlive = isPidAlive(pidFile.pid);
+  } catch (error) {
+    return {
+      status: "stayed_alive",
+      selfPid,
+      reason: "liveness_error",
+      ownerPid: pidFile.pid,
+      error: errorMessage(error),
+    };
+  }
+
+  if (ownerAlive) {
+    return { status: "superseded", selfPid, ownerPid: pidFile.pid };
+  }
+
+  await writeDiscovery({ stateRoot: options.stateRoot, pid: selfPid, port: options.port });
+  return {
+    status: "reclaimed",
+    selfPid,
+    reason: "dead_owner",
+    ownerPid: pidFile.pid,
+  };
+}
+
+async function readPidFile(pidFile: string): Promise<PidFileRead> {
+  try {
+    const raw = (await readFile(pidFile, "utf8")).trim();
+    const pid = Number(raw);
+    if (Number.isInteger(pid) && pid > 0) return { status: "pid", pid };
+    return { status: "invalid", raw };
+  } catch (error) {
+    if (isFileNotFound(error)) return { status: "missing" };
+    return { status: "error", error };
+  }
+}
+
+function defaultIsPidAlive(pid: number): boolean {
+  try {
+    process.kill(pid, 0);
+    return true;
+  } catch {
+    return false;
+  }
+}
+
+async function appendAudit(
+  audit: AuditStore | undefined,
+  event: { kind: "daemon_superseded" | "daemon_discovery_reclaimed" | "daemon_pid_watchdog_error"; detail: Record<string, unknown> },
+): Promise<void> {
+  if (!audit) return;
+  await audit.append({ timestamp: Date.now(), ...event });
+}
+
+function isFileNotFound(error: unknown): boolean {
+  return typeof error === "object" && error !== null && "code" in error &&
+    (error as { code?: unknown }).code === "ENOENT";
+}
+
+function errorMessage(error: unknown): string {
+  return error instanceof Error ? error.message : String(error);
+}
diff --git a/core-daemon/daemon.ts b/core-daemon/daemon.ts
index f4cbb0a..f3c6fa6 100644
--- a/core-daemon/daemon.ts
+++ b/core-daemon/daemon.ts
@@ -13,6 +13,7 @@ import { resolveStatePaths } from "./paths.js";
 import { startIpcServer } from "./ipc/server.js";
 import type { IpcRequest } from "./ipc/protocol.js";
 import { writeDaemonDiscoveryFiles } from "./bootstrap/ensure-daemon.js";
+import { startDaemonPidWatchdog } from "./bootstrap/pid-watchdog.js";
 import { MessageBus } from "./bus.js";
 import { openSqliteStorage } from "./storage/sqlite.js";
 import { JsonlTranscriptStore } from "./storage/transcripts.js";
@@ -243,6 +244,23 @@ export async function runDaemon(options: RunDaemonOptions): Promise<void> {
     throw error;
   }
   await bus.start();
+  startDaemonPidWatchdog({
+    stateRoot: paths.root,
+    pidFile: paths.pidFile,
+    port: server.port,
+    audit,
+    stopDaemon: async () => {
+      try {
+        await bus.stop();
+      } catch (error) {
+        console.error(
+          `agents-comm-bus: failed to stop comm adapters during daemon retirement: ` +
+            `${error instanceof Error ? error.message : String(error)}`,
+        );
+      }
+      await server.close();
+    },
+  });
 
   console.error(`agents-comm-bus ${DAEMON_VERSION} listening on ${server.url}`);
 }
diff --git a/packages/core-contracts/src/storage/audit-store.ts b/packages/core-contracts/src/storage/audit-store.ts
index 3294717..c8fc0df 100644
--- a/packages/core-contracts/src/storage/audit-store.ts
+++ b/packages/core-contracts/src/storage/audit-store.ts
@@ -23,6 +23,9 @@ export type AuditEventKind =
   | "inbound_dispatch_bridge_invoked"
   | "inbound_dispatch_bridge_completed"
   | "inbound_dispatch_bridge_failed"
+  | "daemon_superseded"
+  | "daemon_discovery_reclaimed"
+  | "daemon_pid_watchdog_error"
   | "registration_added"
   | "registration_removed"
   | "loop_prevention_drop";
diff --git a/scripts/restart-daemon.ps1 b/scripts/restart-daemon.ps1
new file mode 100644
index 0000000..04eb191
--- /dev/null
+++ b/scripts/restart-daemon.ps1
@@ -0,0 +1,143 @@
+<#
+.SYNOPSIS
+  Reap stale agents-comm-bus daemons for THIS repo and clear discovery files.
+
+.DESCRIPTION
+  Finds ALL node processes running this repo's core-daemon/serve.js -- not just the
+  PID recorded in ~/.agents-comm-bus/daemon.pid -- and kills them, then clears the
+  daemon.pid + port discovery files. This closes the orphan-accumulation hole in
+  the old ad-hoc restart (Stop-Process on daemon.pid only): a daemon that wasn't
+  the recorded PID (from a spawn-race or a prior restart that didn't write the pid
+  file) survived every restart and kept polling the same Telegram bots, producing
+  409 getUpdates conflicts and intermittent message loss.
+
+  This is the operational, explicit-developer-restart sibling to the runtime
+  self-retirement watchdog (Linear AGE-12). The watchdog auto-retires a superseded
+  daemon using the narrow "daemon.pid names a different live PID" rule; this script
+  is the broad hammer: kill EVERY serve.js daemon for this repo path. The two are
+  complementary and intentionally use different detection predicates.
+
+  Matching is scoped to this repo's serve.js absolute path, so daemons for other
+  projects/checkouts are never touched. The daemon is per-user and bootstraps
+  lazily, so by default this does NOT respawn -- the next hook/MCP call spawns a
+  fresh single daemon. Pass -Respawn to start one immediately.
+
+  SAFETY: default is a DRY RUN. Pass -Exec to actually kill + clear.
+
+.EXAMPLE
+  powershell scripts/restart-daemon.ps1
+  # Preview: list every serve.js daemon for this repo that WOULD be reaped.
+
+.EXAMPLE
+  powershell scripts/restart-daemon.ps1 -Exec
+  # Reap all this-repo serve.js daemons and clear daemon.pid + port.
+
+.EXAMPLE
+  powershell scripts/restart-daemon.ps1 -Exec -Respawn
+  # ...and immediately start one fresh daemon.
+
+.EXAMPLE
+  powershell scripts/restart-daemon.ps1 -Json
+  # Machine-readable plan (combine with -Exec for a machine-readable result).
+#>
+param(
+    [string]$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
+    [string]$StateRoot = (Join-Path $env:USERPROFILE ".agents-comm-bus"),
+    [switch]$Exec,
+    [switch]$Respawn,
+    [switch]$Json
+)
+
+$ErrorActionPreference = "Stop"
+
+$servePath = Join-Path $RepoDir "agents-comm-bus\dist\core-daemon\serve.js"
+# Command lines may use either slash direction; match both forms of this repo's
+# serve.js so we only ever reap daemons belonging to THIS checkout.
+$needleBack = $servePath
+$needleFwd = $servePath -replace '\\', '/'
+
+$daemons = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
+    $_.CommandLine -and ($_.CommandLine -like '*serve.js*') -and
+    (($_.CommandLine -like "*$needleBack*") -or ($_.CommandLine -like "*$needleFwd*"))
+}
+
+$found = @($daemons | Sort-Object CreationDate | ForEach-Object {
+        [PSCustomObject]@{
+            Pid         = $_.ProcessId
+            Started     = $_.CreationDate
+            CommandLine = $_.CommandLine
+        }
+    })
+
+$pidFile = Join-Path $StateRoot "daemon.pid"
+$portFile = Join-Path $StateRoot "port"
+$recordedPid = if (Test-Path $pidFile) { (Get-Content $pidFile -Raw).Trim() } else { $null }
+
+$result = [ordered]@{
+    repoDir          = $RepoDir
+    stateRoot        = $StateRoot
+    servePath        = $servePath
+    recordedPid      = $recordedPid
+    found            = $found
+    killed           = @()
+    clearedDiscovery = $false
+    respawnedPid     = $null
+    dryRun           = (-not $Exec)
+}
+
+if (-not $Exec) {
+    if ($Json) {
+        $result | ConvertTo-Json -Depth 5
+    }
+    else {
+        Write-Output "DRY RUN (pass -Exec to reap). serve.js = $servePath"
+        Write-Output "Recorded daemon.pid = $recordedPid"
+        if ($found.Count -eq 0) {
+            Write-Output "No matching daemons running."
+        }
+        else {
+            Write-Output "Would kill $($found.Count) daemon(s):"
+            $found | ForEach-Object { Write-Output ("  PID {0}  started {1}{2}" -f $_.Pid, $_.Started, ($(if ("$($_.Pid)" -eq "$recordedPid") { '  <- recorded' } else { '' }))) }
+        }
+    }
+    return
+}
+
+# --- Exec: reap every matching daemon ---
+$killed = @()
+foreach ($d in $found) {
+    try {
+        Stop-Process -Id $d.Pid -Force -ErrorAction Stop
+        $killed += $d.Pid
+        Write-Output ("Killed daemon PID {0} (started {1})" -f $d.Pid, $d.Started)
+    }
+    catch {
+        Write-Warning "failed to kill PID $($d.Pid): $_"
+    }
+}
+$result.killed = $killed
+
+# Clear discovery only after the kills -- all of this repo's daemons are now dead,
+# so removing the files cannot strand a live canonical daemon's discovery.
+Remove-Item $pidFile -ErrorAction SilentlyContinue
+Remove-Item $portFile -ErrorAction SilentlyContinue
+$result.clearedDiscovery = $true
+
+if ($Respawn) {
+    $proc = Start-Process -FilePath "node" -ArgumentList @($servePath, "serve") -PassThru -WindowStyle Hidden
+    $result.respawnedPid = $proc.Id
+}
+
+if ($Json) {
+    $result | ConvertTo-Json -Depth 5
+}
+else {
+    Write-Output ("Reaped {0} daemon(s): {1}" -f $killed.Count, ($(if ($killed.Count) { $killed -join ', ' } else { 'none' })))
+    Write-Output "Cleared daemon.pid + port."
+    if ($Respawn) {
+        Write-Output "Respawned fresh daemon PID $($result.respawnedPid)"
+    }
+    else {
+        Write-Output "No respawn -- the daemon will bootstrap lazily on the next hook/MCP call."
+    }
+}
diff --git a/tests/architecture/daemon-pid-watchdog.test.ts b/tests/architecture/daemon-pid-watchdog.test.ts
new file mode 100644
index 0000000..19eb110
--- /dev/null
+++ b/tests/architecture/daemon-pid-watchdog.test.ts
@@ -0,0 +1,180 @@
+import { describe, it } from "node:test";
+import assert from "node:assert/strict";
+
+import type { AuditEvent, AuditStore } from "agents-comm-bus-core";
+import {
+  checkDaemonPidOwnership,
+  runDaemonPidWatchdogTick,
+  type PidFileRead,
+} from "../../core-daemon/bootstrap/pid-watchdog.js";
+
+function auditRecorder(): { audit: AuditStore; events: AuditEvent[] } {
+  const events: AuditEvent[] = [];
+  return {
+    events,
+    audit: {
+      append: async (event) => {
+        events.push(event);
+      },
+    },
+  };
+}
+
+describe("daemon pid watchdog", () => {
+  it("retires only when daemon.pid names a different live daemon", async () => {
+    const order: string[] = [];
+    const { audit, events } = auditRecorder();
+
+    const result = await runDaemonPidWatchdogTick({
+      pidFile: "daemon.pid",
+      port: 45_001,
+      selfPid: 100,
+      audit,
+      readPidFile: async () => ({ status: "pid", pid: 200 }),
+      isPidAlive: (pid) => pid === 200,
+      stopDaemon: async () => {
+        order.push("stop");
+      },
+      exitProcess: (code) => {
+        order.push(`exit:${code}`);
+      },
+    });
+
+    assert.deepEqual(result, { status: "superseded", selfPid: 100, ownerPid: 200 });
+    assert.deepEqual(order, ["stop", "exit:0"]);
+    assert.equal(events.length, 1);
+    assert.equal(events[0].kind, "daemon_superseded");
+    assert.deepEqual(events[0].detail, { self_pid: 100, canonical_pid: 200 });
+  });
+
+  it("reclaims discovery when daemon.pid is missing", async () => {
+    const writes: Array<{ pid?: number; port: number }> = [];
+    const { audit, events } = auditRecorder();
+
+    const result = await checkDaemonPidOwnership({
+      stateRoot: "state",
+      pidFile: "daemon.pid",
+      port: 45_002,
+      selfPid: 101,
+      readPidFile: async () => ({ status: "missing" }),
+      writeDiscoveryFiles: async (input) => {
+        writes.push({ pid: input.pid, port: input.port });
+      },
+    });
+
+    assert.deepEqual(result, { status: "reclaimed", selfPid: 101, reason: "missing" });
+    assert.deepEqual(writes, [{ pid: 101, port: 45_002 }]);
+
+    await runDaemonPidWatchdogTick({
+      stateRoot: "state",
+      pidFile: "daemon.pid",
+      port: 45_002,
+      selfPid: 101,
+      audit,
+      readPidFile: async () => ({ status: "missing" }),
+      writeDiscoveryFiles: async () => {},
+    });
+    assert.equal(events[0].kind, "daemon_discovery_reclaimed");
+    assert.equal(events[0].detail?.reason, "missing");
+  });
+
+  it("reclaims discovery when daemon.pid names a dead owner", async () => {
+    const writes: Array<{ pid?: number; port: number }> = [];
+    const { audit, events } = auditRecorder();
+
+    const result = await runDaemonPidWatchdogTick({
+      stateRoot: "state",
+      pidFile: "daemon.pid",
+      port: 45_003,
+      selfPid: 102,
+      audit,
+      readPidFile: async () => ({ status: "pid", pid: 202 }),
+      isPidAlive: () => false,
+      writeDiscoveryFiles: async (input) => {
+        writes.push({ pid: input.pid, port: input.port });
+      },
+      stopDaemon: async () => {
+        throw new Error("must not stop when reclaiming");
+      },
+    });
+
+    assert.deepEqual(result, {
+      status: "reclaimed",
+      selfPid: 102,
+      reason: "dead_owner",
+      ownerPid: 202,
+    });
+    assert.deepEqual(writes, [{ pid: 102, port: 45_003 }]);
+    assert.equal(events[0].kind, "daemon_discovery_reclaimed");
+    assert.equal(events[0].detail?.previous_pid, 202);
+  });
+
+  it("stays alive on invalid pid file content", async () => {
+    const { audit, events } = auditRecorder();
+
+    const result = await runDaemonPidWatchdogTick({
+      pidFile: "daemon.pid",
+      port: 45_004,
+      selfPid: 103,
+      audit,
+      readPidFile: async () => ({ status: "invalid", raw: "not-ready" }),
+      writeDiscoveryFiles: async () => {
+        throw new Error("must not rewrite invalid pid races");
+      },
+      stopDaemon: async () => {
+        throw new Error("must not retire on invalid pid");
+      },
+    });
+
+    assert.equal(result.status, "stayed_alive");
+    assert.equal(result.reason, "invalid_pid");
+    assert.equal(events[0].kind, "daemon_pid_watchdog_error");
+    assert.equal(events[0].detail?.reason, "invalid_pid");
+  });
+
+  it("stays alive on transient read errors", async () => {
+    const { audit, events } = auditRecorder();
+
+    const result = await runDaemonPidWatchdogTick({
+      pidFile: "daemon.pid",
+      port: 45_005,
+      selfPid: 104,
+      audit,
+      readPidFile: async (): Promise<PidFileRead> => ({
+        status: "error",
+        error: new Error("permission denied"),
+      }),
+      stopDaemon: async () => {
+        throw new Error("must not retire on read error");
+      },
+    });
+
+    assert.equal(result.status, "stayed_alive");
+    assert.equal(result.reason, "read_error");
+    assert.equal(events[0].kind, "daemon_pid_watchdog_error");
+    assert.equal(events[0].detail?.error, "permission denied");
+  });
+
+  it("stays alive when liveness probing fails", async () => {
+    const { audit, events } = auditRecorder();
+
+    const result = await runDaemonPidWatchdogTick({
+      pidFile: "daemon.pid",
+      port: 45_006,
+      selfPid: 105,
+      audit,
+      readPidFile: async () => ({ status: "pid", pid: 205 }),
+      isPidAlive: () => {
+        throw new Error("probe failed");
+      },
+      stopDaemon: async () => {
+        throw new Error("must not retire on probe failure");
+      },
+    });
+
+    assert.equal(result.status, "stayed_alive");
+    assert.equal(result.reason, "liveness_error");
+    assert.equal(result.ownerPid, 205);
+    assert.equal(events[0].kind, "daemon_pid_watchdog_error");
+  });
+});

````

---

### `21d6d44` -- Harden daemon pid watchdog cleanup

AGE-12: pid-watchdog hardening -- reclaim-write failures stay alive + audit; retirement cleanup uses best-effort timeouts so a stuck close can't block exit.

_Files (stat):_

```
 core-daemon/bootstrap/pid-watchdog.ts          | 39 ++++++++++++++------
 core-daemon/daemon.ts                          | 49 +++++++++++++++++++++-----
 tests/architecture/daemon-pid-watchdog.test.ts | 26 ++++++++++++++
 3 files changed, 95 insertions(+), 19 deletions(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/core-daemon/bootstrap/pid-watchdog.ts b/core-daemon/bootstrap/pid-watchdog.ts
index f5fd659..5f8903e 100644
--- a/core-daemon/bootstrap/pid-watchdog.ts
+++ b/core-daemon/bootstrap/pid-watchdog.ts
@@ -7,7 +7,7 @@ export type DaemonPidWatchdogResult =
   | { status: "current"; selfPid: number }
   | { status: "superseded"; selfPid: number; ownerPid: number }
   | { status: "reclaimed"; selfPid: number; reason: "missing" | "dead_owner"; ownerPid?: number }
-  | { status: "stayed_alive"; selfPid: number; reason: "invalid_pid" | "read_error" | "liveness_error"; ownerPid?: number; error?: string };
+  | { status: "stayed_alive"; selfPid: number; reason: "invalid_pid" | "read_error" | "liveness_error" | "reclaim_error"; ownerPid?: number; error?: string };
 
 export type PidFileRead =
   | { status: "pid"; pid: number }
@@ -130,8 +130,17 @@ export async function checkDaemonPidOwnership(
 
   const pidFile = await read(options.pidFile);
   if (pidFile.status === "missing") {
-    await writeDiscovery({ stateRoot: options.stateRoot, pid: selfPid, port: options.port });
-    return { status: "reclaimed", selfPid, reason: "missing" };
+    try {
+      await writeDiscovery({ stateRoot: options.stateRoot, pid: selfPid, port: options.port });
+      return { status: "reclaimed", selfPid, reason: "missing" };
+    } catch (error) {
+      return {
+        status: "stayed_alive",
+        selfPid,
+        reason: "reclaim_error",
+        error: errorMessage(error),
+      };
+    }
   }
 
   if (pidFile.status === "invalid") {
@@ -173,13 +182,23 @@ export async function checkDaemonPidOwnership(
     return { status: "superseded", selfPid, ownerPid: pidFile.pid };
   }
 
-  await writeDiscovery({ stateRoot: options.stateRoot, pid: selfPid, port: options.port });
-  return {
-    status: "reclaimed",
-    selfPid,
-    reason: "dead_owner",
-    ownerPid: pidFile.pid,
-  };
+  try {
+    await writeDiscovery({ stateRoot: options.stateRoot, pid: selfPid, port: options.port });
+    return {
+      status: "reclaimed",
+      selfPid,
+      reason: "dead_owner",
+      ownerPid: pidFile.pid,
+    };
+  } catch (error) {
+    return {
+      status: "stayed_alive",
+      selfPid,
+      reason: "reclaim_error",
+      ownerPid: pidFile.pid,
+      error: errorMessage(error),
+    };
+  }
 }
 
 async function readPidFile(pidFile: string): Promise<PidFileRead> {
diff --git a/core-daemon/daemon.ts b/core-daemon/daemon.ts
index f3c6fa6..3e9539d 100644
--- a/core-daemon/daemon.ts
+++ b/core-daemon/daemon.ts
@@ -250,21 +250,52 @@ export async function runDaemon(options: RunDaemonOptions): Promise<void> {
     port: server.port,
     audit,
     stopDaemon: async () => {
-      try {
-        await bus.stop();
-      } catch (error) {
-        console.error(
-          `agents-comm-bus: failed to stop comm adapters during daemon retirement: ` +
-            `${error instanceof Error ? error.message : String(error)}`,
-        );
-      }
-      await server.close();
+      await bestEffortWithTimeout(
+        () => bus.stop(),
+        5_000,
+        "stop comm adapters during daemon retirement",
+      );
+      await bestEffortWithTimeout(
+        () => server.close(),
+        1_000,
+        "close IPC server during daemon retirement",
+      );
     },
   });
 
   console.error(`agents-comm-bus ${DAEMON_VERSION} listening on ${server.url}`);
 }
 
+async function bestEffortWithTimeout(
+  action: () => Promise<void>,
+  timeoutMs: number,
+  label: string,
+): Promise<void> {
+  let timeout: NodeJS.Timeout | undefined;
+  let timedOut = false;
+  try {
+    await Promise.race([
+      action(),
+      new Promise<void>((resolve) => {
+        timeout = setTimeout(() => {
+          timedOut = true;
+          resolve();
+        }, timeoutMs);
+      }),
+    ]);
+    if (timedOut) {
+      console.error(`agents-comm-bus: timed out trying to ${label}`);
+    }
+  } catch (error) {
+    console.error(
+      `agents-comm-bus: failed to ${label}: ` +
+        `${error instanceof Error ? error.message : String(error)}`,
+    );
+  } finally {
+    if (timeout) clearTimeout(timeout);
+  }
+}
+
 async function loadCommAdapters(input: {
   factories: CommAdapterFactory[];
   storage: Awaited<ReturnType<typeof openSqliteStorage>>;
diff --git a/tests/architecture/daemon-pid-watchdog.test.ts b/tests/architecture/daemon-pid-watchdog.test.ts
index 19eb110..86b1e40 100644
--- a/tests/architecture/daemon-pid-watchdog.test.ts
+++ b/tests/architecture/daemon-pid-watchdog.test.ts
@@ -177,4 +177,30 @@ describe("daemon pid watchdog", () => {
     assert.equal(result.ownerPid, 205);
     assert.equal(events[0].kind, "daemon_pid_watchdog_error");
   });
+
+  it("stays alive when reclaiming discovery fails", async () => {
+    const { audit, events } = auditRecorder();
+
+    const result = await runDaemonPidWatchdogTick({
+      stateRoot: "state",
+      pidFile: "daemon.pid",
+      port: 45_007,
+      selfPid: 106,
+      audit,
+      readPidFile: async () => ({ status: "pid", pid: 206 }),
+      isPidAlive: () => false,
+      writeDiscoveryFiles: async () => {
+        throw new Error("port belongs to a live daemon");
+      },
+      stopDaemon: async () => {
+        throw new Error("must not retire on reclaim failure");
+      },
+    });
+
+    assert.equal(result.status, "stayed_alive");
+    assert.equal(result.reason, "reclaim_error");
+    assert.equal(result.ownerPid, 206);
+    assert.equal(events[0].kind, "daemon_pid_watchdog_error");
+    assert.equal(events[0].detail?.reason, "reclaim_error");
+  });
 });

````

---

### `92a9d34` -- Run daemon pid watchdog tests in package suite

AGE-12: wires daemon-pid-watchdog.test.ts into the package test suite (coverage gap Claude flagged).

_Files (stat):_

```
 agents-comm-bus/package.json | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
index def451c..1b0560e 100644
--- a/agents-comm-bus/package.json
+++ b/agents-comm-bus/package.json
@@ -27,7 +27,7 @@
   "scripts": {
     "build": "tsc && node scripts/copy-assets.js",
     "typecheck": "tsc --noEmit",
-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\""
+    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/daemon-pid-watchdog.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\""
   },
   "engines": { "node": ">=22" },
   "dependencies": {

````

---

### `fdcfc17` -- Document workspace dev marker for central install

Docs: install-model.md dev-mode section -- gitignored marker -> shared dev-config resolver -> explicit AGENTS_COMM_BUS_* env; resolveInstallMode stays env-only. The prose plan AGE-13 implements.

_Files (stat):_

```
 .gitignore                     |  3 +++
 docs/research/install-model.md | 49 +++++++++++++++++++++++++++++++++++++++---
 2 files changed, 49 insertions(+), 3 deletions(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/.gitignore b/.gitignore
index 28846ac..8ad1046 100644
--- a/.gitignore
+++ b/.gitignore
@@ -13,6 +13,9 @@ node_modules/
 .mcp.json
 !plugins/codex/telegram/.mcp.json
 
+# Local source-mode switch for central-install development
+.agents-comm-bus-dev.json
+
 # Local team scratchpad: the canvas + its seed sidecar are local-only
 docs/Command Center.html
 docs/command-center-notes.js
diff --git a/docs/research/install-model.md b/docs/research/install-model.md
index a8ad5e1..e3c1679 100644
--- a/docs/research/install-model.md
+++ b/docs/research/install-model.md
@@ -652,6 +652,46 @@ state.
 | `AGENTS_COMM_BUS_BIN=<project>/core/index.js` | Overrides the daemon entry point. Install hook skips the "copy bundle to shared location" step when set. Daemon runs from raw project source — no esbuild round-trip per iteration. |
 | `AGENTS_COMM_BUS_ADAPTERS_DIR=<project>/adapters/` | Overrides the adapter discovery directory. Daemon loads from project source rather than the shared `adapters/` dir. |
 
+`AGENTS_COMM_BUS_BIN` remains the authoritative source-mode switch.
+`resolveInstallMode(env)` should stay env-only: if that variable is set,
+the caller is in source/dev mode; if it is absent, the caller is in
+strict production/plugin mode and missing plugin metadata is a hard
+packaging error.
+
+### Workspace-wide dev marker
+
+MCP server env blocks are not enough by themselves: they reach the MCP
+shim process, but hook processes are launched by the host agent and do
+not necessarily inherit the MCP server's environment. Setting the same
+three variables separately on every Claude hook, Codex hook, and MCP
+shim is fragile.
+
+The dev setup should therefore support a gitignored repo-local marker
+or config file, for example:
+
+```text
+<project>/.agents-comm-bus-dev.json
+```
+
+This marker is a workspace convenience, not a second runtime mode
+switch. Production/plugin artifacts must not ship it and production
+bootstrap must not treat the marker's mere presence as permission to
+skip central install. Instead, all runtime entrypoints should call a
+shared dev-config resolver before central-install reconciliation:
+
+1. Resolve the project/worktree root for the current hook or shim.
+2. If the gitignored dev marker/config exists, read it and validate that
+   the referenced source daemon entry exists inside that project root.
+3. Populate the same env-shaped values used by the strict contract:
+   `AGENTS_COMM_BUS_BIN`, `AGENTS_COMM_BUS_ROOT`, and
+   `AGENTS_COMM_BUS_ADAPTERS_DIR`.
+4. Pass those resolved values to the common central-install wrapper.
+
+That keeps the safety property intact: the install-mode decision is
+still made from explicit env-shaped values, while the workspace gets one
+local switch that applies consistently to both shims and all hook
+entrypoints.
+
 Plus the existing pattern from today's codebase:
 
 - Project-local `.mcp.json` (gitignored) declares the MCP server with
@@ -686,9 +726,12 @@ server with the env vars in `env`:
 ```
 
 Same env block goes on the hook entry in `.claude/settings.local.json`
-or analogous Codex config. A bootstrap script (`npm run dev`) can
-template these paths automatically against the dev's checkout
-location.
+or analogous Codex config when the host supports hook env directly. When
+it does not, the shared dev-config resolver is the preferred path: the
+hook command stays simple, and the hook reads the gitignored marker from
+the project root to populate the same env-shaped values before calling
+the central-install wrapper. A bootstrap script (`npm run dev`) can
+template these paths automatically against the dev's checkout location.
 
 ### Coexistence with production daemon
 

````

## Group 2 -- central-install wiring (AGE-13, merged 2d4539e)

---

### `6777606` -- AGE-13 step 1: dev-config resolver (gitignored marker -> validated env)

AGE-13 step 1: resolveDevConfig -- gitignored .agents-comm-bus-dev.json -> validated env-shaped overrides (escape-root/missing/unparseable rejected); applyDevConfig merges without mutating base env.

_Files (stat):_

```
 agents-comm-bus/package.json                   |   2 +-
 hosts/common/install/dev-config-resolver.js    | 121 +++++++++++++++++++++
 tests/architecture/dev-config-resolver.test.ts | 141 +++++++++++++++++++++++++
 3 files changed, 263 insertions(+), 1 deletion(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
index 1b0560e..deaa279 100644
--- a/agents-comm-bus/package.json
+++ b/agents-comm-bus/package.json
@@ -27,7 +27,7 @@
   "scripts": {
     "build": "tsc && node scripts/copy-assets.js",
     "typecheck": "tsc --noEmit",
-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/daemon-pid-watchdog.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\""
+    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/daemon-pid-watchdog.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\" \"../tests/architecture/dev-config-resolver.test.ts\""
   },
   "engines": { "node": ">=22" },
   "dependencies": {
diff --git a/hosts/common/install/dev-config-resolver.js b/hosts/common/install/dev-config-resolver.js
new file mode 100644
index 0000000..8aa605a
--- /dev/null
+++ b/hosts/common/install/dev-config-resolver.js
@@ -0,0 +1,121 @@
+/**
+ * Dev-config resolver — the workspace-convenience layer ABOVE the strict
+ * source-mode contract (see install-model.md "Workspace-wide dev marker").
+ *
+ * `resolveInstallMode(env)` stays env-only and strict: source mode is triggered
+ * solely by an explicit `AGENTS_COMM_BUS_BIN`. This resolver does NOT introduce
+ * a second mode switch — it reads a gitignored, repo-local marker and turns it
+ * into the SAME env-shaped values the strict contract already reads, which the
+ * caller then merges into the env it passes to ensureCentralInstall. So the
+ * marker resolves *into* the env contract; it is never itself a "skip central
+ * install" signal.
+ *
+ * Safety (Codex review bars):
+ *   - returns explicit env-shaped overrides; never mutates global process.env.
+ *   - a marker that is missing, unparseable, lacks `daemonBin`, points OUTSIDE
+ *     the project root, or references a non-existent daemon entry yields NO
+ *     overrides (status "none"/"rejected") — a stale/wrong marker must not
+ *     silently enable dev mode.
+ *
+ * The marker (`.agents-comm-bus-dev.json`, gitignored) at the project root:
+ *   {
+ *     "daemonBin":   "agents-comm-bus/dist/core-daemon/serve.js",  // required, repo-relative or absolute-inside-root
+ *     "stateRoot":   ".agents-comm-bus-dev",                       // optional
+ *     "adaptersDir": "adapters"                                     // optional
+ *   }
+ */
+import { readFileSync, existsSync } from "node:fs";
+import path from "node:path";
+
+export const DEV_MARKER_NAME = ".agents-comm-bus-dev.json";
+
+/**
+ * @typedef {Object} DevConfigResult
+ * @property {Record<string,string>} env       env-shaped overrides to merge (empty unless a valid marker applied)
+ * @property {"none"|"applied"|"rejected"} status
+ * @property {string[]} reasons
+ *
+ * @typedef {Object} DevConfigDeps
+ * @property {(p: string) => boolean} [exists]
+ * @property {(p: string) => string} [readFile]
+ */
+
+/**
+ * @param {string} projectRoot  absolute repo/worktree root for the calling hook/shim
+ * @param {DevConfigDeps} [deps]
+ * @returns {DevConfigResult}
+ */
+export function resolveDevConfig(projectRoot, deps = {}) {
+  const exists = deps.exists ?? existsSync;
+  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
+  const markerPath = path.join(projectRoot, DEV_MARKER_NAME);
+
+  if (!exists(markerPath)) {
+    return { env: {}, status: "none", reasons: [`no dev marker at ${markerPath}`] };
+  }
+
+  let parsed;
+  try {
+    parsed = JSON.parse(readFile(markerPath));
+  } catch (error) {
+    // Present but unparseable: reject — never enable dev mode on a broken marker.
+    return {
+      env: {},
+      status: "rejected",
+      reasons: [`dev marker unparseable: ${error instanceof Error ? error.message : String(error)}`],
+    };
+  }
+
+  const daemonBinRaw = parsed && typeof parsed.daemonBin === "string" ? parsed.daemonBin : null;
+  if (!daemonBinRaw) {
+    return { env: {}, status: "rejected", reasons: ["dev marker missing string field `daemonBin`"] };
+  }
+
+  const daemonBin = path.resolve(projectRoot, daemonBinRaw);
+  if (!isInside(projectRoot, daemonBin)) {
+    return { env: {}, status: "rejected", reasons: [`dev marker daemonBin escapes project root: ${daemonBinRaw}`] };
+  }
+  if (!exists(daemonBin)) {
+    return { env: {}, status: "rejected", reasons: [`dev marker daemonBin does not exist: ${daemonBin}`] };
+  }
+
+  /** @type {Record<string,string>} */
+  const env = { AGENTS_COMM_BUS_BIN: daemonBin };
+  const reasons = [`dev marker applied from ${markerPath}`];
+
+  // Optional overrides — each validated inside the project root or ignored.
+  if (typeof parsed.stateRoot === "string" && parsed.stateRoot.length > 0) {
+    const stateRoot = path.resolve(projectRoot, parsed.stateRoot);
+    if (isInside(projectRoot, stateRoot)) env.AGENTS_COMM_BUS_ROOT = stateRoot;
+    else reasons.push(`ignoring stateRoot outside project root: ${parsed.stateRoot}`);
+  }
+  if (typeof parsed.adaptersDir === "string" && parsed.adaptersDir.length > 0) {
+    const adaptersDir = path.resolve(projectRoot, parsed.adaptersDir);
+    if (isInside(projectRoot, adaptersDir)) env.AGENTS_COMM_BUS_ADAPTERS_DIR = adaptersDir;
+    else reasons.push(`ignoring adaptersDir outside project root: ${parsed.adaptersDir}`);
+  }
+
+  return { env, status: "applied", reasons };
+}
+
+/**
+ * Merge resolved dev overrides onto a base env WITHOUT mutating the base.
+ * Callers pass the result as ensureCentralInstall's `env`. The strict
+ * `resolveInstallMode(env)` then reads AGENTS_COMM_BUS_BIN as usual.
+ *
+ * @param {Record<string, string | undefined>} baseEnv
+ * @param {string} projectRoot
+ * @param {DevConfigDeps} [deps]
+ * @returns {{ env: Record<string, string | undefined>, devConfig: DevConfigResult }}
+ */
+export function applyDevConfig(baseEnv, projectRoot, deps = {}) {
+  const devConfig = resolveDevConfig(projectRoot, deps);
+  return { env: { ...baseEnv, ...devConfig.env }, devConfig };
+}
+
+/** True if `candidate` is `root` or strictly inside it. */
+function isInside(root, candidate) {
+  const rel = path.relative(root, candidate);
+  if (rel === "") return true;
+  return !rel.startsWith("..") && !path.isAbsolute(rel);
+}
diff --git a/tests/architecture/dev-config-resolver.test.ts b/tests/architecture/dev-config-resolver.test.ts
new file mode 100644
index 0000000..8be1b8d
--- /dev/null
+++ b/tests/architecture/dev-config-resolver.test.ts
@@ -0,0 +1,141 @@
+import assert from "node:assert/strict";
+import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
+import os from "node:os";
+import path from "node:path";
+import { describe, it } from "node:test";
+
+import {
+  resolveDevConfig,
+  applyDevConfig,
+  DEV_MARKER_NAME,
+} from "../../hosts/common/install/dev-config-resolver.js";
+
+// ---------------------------------------------------------------------------
+// Dev-config resolver: gitignored marker -> validated env-shaped overrides.
+// resolveInstallMode stays env-only; this layer only produces the env values.
+// ---------------------------------------------------------------------------
+
+async function tempRoot(): Promise<string> {
+  return mkdtemp(path.join(os.tmpdir(), "acb-devcfg-"));
+}
+
+/** Write a project root with a real source daemon entry + a marker. */
+async function project(
+  marker: Record<string, unknown> | string | null,
+  opts: { daemonBin?: string } = {},
+): Promise<string> {
+  const root = await tempRoot();
+  const binRel = opts.daemonBin ?? "agents-comm-bus/dist/core-daemon/serve.js";
+  await mkdir(path.join(root, path.dirname(binRel)), { recursive: true });
+  await writeFile(path.join(root, binRel), "// fake daemon entry\n", "utf8");
+  if (marker !== null) {
+    const body = typeof marker === "string" ? marker : JSON.stringify(marker);
+    await writeFile(path.join(root, DEV_MARKER_NAME), body, "utf8");
+  }
+  return root;
+}
+
+describe("resolveDevConfig — no marker", () => {
+  it("returns status 'none' and no env when the marker is absent", async () => {
+    const root = await project(null);
+    const r = resolveDevConfig(root);
+    assert.equal(r.status, "none");
+    assert.deepEqual(r.env, {});
+  });
+});
+
+describe("resolveDevConfig — valid marker", () => {
+  it("resolves daemonBin to an absolute AGENTS_COMM_BUS_BIN inside the root", async () => {
+    const root = await project({ daemonBin: "agents-comm-bus/dist/core-daemon/serve.js" });
+    const r = resolveDevConfig(root);
+    assert.equal(r.status, "applied");
+    assert.equal(r.env.AGENTS_COMM_BUS_BIN, path.join(root, "agents-comm-bus/dist/core-daemon/serve.js"));
+  });
+
+  it("includes optional stateRoot / adaptersDir when they resolve inside the root", async () => {
+    const root = await project({
+      daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
+      stateRoot: ".agents-comm-bus-dev",
+      adaptersDir: "adapters",
+    });
+    const r = resolveDevConfig(root);
+    assert.equal(r.status, "applied");
+    assert.equal(r.env.AGENTS_COMM_BUS_ROOT, path.join(root, ".agents-comm-bus-dev"));
+    assert.equal(r.env.AGENTS_COMM_BUS_ADAPTERS_DIR, path.join(root, "adapters"));
+  });
+
+  it("ignores optional overrides that escape the root, but still applies daemonBin", async () => {
+    const root = await project({
+      daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
+      stateRoot: "../escaping-state",
+    });
+    const r = resolveDevConfig(root);
+    assert.equal(r.status, "applied");
+    assert.ok(r.env.AGENTS_COMM_BUS_BIN);
+    assert.equal(r.env.AGENTS_COMM_BUS_ROOT, undefined, "escaping stateRoot must be dropped");
+  });
+});
+
+describe("resolveDevConfig — rejected (negative cases)", () => {
+  it("rejects a daemonBin that escapes the project root", async () => {
+    const root = await project({ daemonBin: "../../evil/serve.js" });
+    const r = resolveDevConfig(root);
+    assert.equal(r.status, "rejected");
+    assert.deepEqual(r.env, {});
+  });
+
+  it("rejects a daemonBin that points inside the root but does not exist", async () => {
+    const root = await project({ daemonBin: "agents-comm-bus/dist/core-daemon/does-not-exist.js" });
+    const r = resolveDevConfig(root);
+    assert.equal(r.status, "rejected");
+    assert.deepEqual(r.env, {});
+  });
+
+  it("rejects a marker missing the daemonBin field", async () => {
+    const root = await project({ stateRoot: ".agents-comm-bus-dev" });
+    const r = resolveDevConfig(root);
+    assert.equal(r.status, "rejected");
+    assert.deepEqual(r.env, {});
+  });
+
+  it("rejects an unparseable marker", async () => {
+    const root = await project("{ not valid json");
+    const r = resolveDevConfig(root);
+    assert.equal(r.status, "rejected");
+    assert.deepEqual(r.env, {});
+  });
+});
+
+describe("applyDevConfig — merge without mutation", () => {
+  it("merges overrides onto a copy and never mutates the base env", async () => {
+    const root = await project({ daemonBin: "agents-comm-bus/dist/core-daemon/serve.js" });
+    const base = { PATH: "/usr/bin", EXISTING: "keep" };
+    const { env, devConfig } = applyDevConfig(base, root);
+
+    assert.equal(devConfig.status, "applied");
+    assert.equal(env.AGENTS_COMM_BUS_BIN, path.join(root, "agents-comm-bus/dist/core-daemon/serve.js"));
+    assert.equal(env.EXISTING, "keep");
+    // base must be untouched (no implicit process.env-style mutation)
+    assert.equal((base as Record<string, unknown>).AGENTS_COMM_BUS_BIN, undefined);
+    assert.deepEqual(base, { PATH: "/usr/bin", EXISTING: "keep" });
+  });
+
+  it("leaves the env unchanged when there is no marker", async () => {
+    const root = await project(null);
+    const base = { PATH: "/usr/bin" };
+    const { env } = applyDevConfig(base, root);
+    assert.deepEqual(env, { PATH: "/usr/bin" });
+  });
+});
+
+describe("resolveDevConfig — caller parity", () => {
+  it("returns identical env for the same (root, marker) regardless of caller", async () => {
+    const root = await project({ daemonBin: "agents-comm-bus/dist/core-daemon/serve.js" });
+    // Two independent calls model a hook process and a shim process resolving
+    // the same workspace marker — they must agree on source-mode options.
+    const fromHook = resolveDevConfig(root);
+    const fromShim = resolveDevConfig(root);
+    assert.deepEqual(fromHook.env, fromShim.env);
+    assert.equal(fromHook.status, fromShim.status);
+  });
+});

````

---

### `c889fb8` -- AGE-13 step 2: install-stamp emission (source) — independent adapter version

AGE-13 step 2: buildInstallStamp + independent ADAPTER_VERSION; stage-plugins.js sources the three versions independently (daemon<-DAEMON_VERSION, adapter<-ADAPTER_VERSION, plugin<-manifest).

_Files (stat):_

```
 .claude-plugin/plugin.json               |  1 +
 adapters/telegram/version.ts             | 16 +++++++
 agents-comm-bus/package.json             |  2 +-
 hosts/common/install/install-stamp.js    | 52 +++++++++++++++++++++
 scripts/stage-plugins.js                 | 53 ++++++++++++++++++++++
 tests/architecture/install-stamp.test.ts | 77 ++++++++++++++++++++++++++++++++
 6 files changed, 200 insertions(+), 1 deletion(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/.claude-plugin/plugin.json b/.claude-plugin/plugin.json
index 7a98f69..a3ed953 100644
--- a/.claude-plugin/plugin.json
+++ b/.claude-plugin/plugin.json
@@ -1,5 +1,6 @@
 {
   "name": "telegram",
+  "version": "0.1.0",
   "description": "Telegram messaging for Claude Code through the agents-comm-bus daemon",
   "author": {
     "name": "Satrio"
diff --git a/adapters/telegram/version.ts b/adapters/telegram/version.ts
new file mode 100644
index 0000000..53e3205
--- /dev/null
+++ b/adapters/telegram/version.ts
@@ -0,0 +1,16 @@
+/**
+ * Telegram adapter bundle version.
+ *
+ * This is an INDEPENDENT content-version source for the Telegram CommAdapter —
+ * deliberately separate from the daemon version (`DAEMON_VERSION`) and the
+ * plugin package version. The central-install stamp (`install-stamp.json`)
+ * records `adapter_bundle_version` from here so adapter-only changes can bump
+ * independently of the daemon, and so a plugin-version bump never masquerades
+ * as an adapter content change (the conflation the stamp's three-field
+ * separation exists to prevent).
+ *
+ * Bump this when the Telegram adapter's shipped behavior changes. Version bump
+ * policy can be formalized later; the invariant is that this is its own named
+ * source, never derived from plugin_version or DAEMON_VERSION.
+ */
+export const ADAPTER_VERSION = "0.1.0";
diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
index deaa279..a7a9284 100644
--- a/agents-comm-bus/package.json
+++ b/agents-comm-bus/package.json
@@ -27,7 +27,7 @@
   "scripts": {
     "build": "tsc && node scripts/copy-assets.js",
     "typecheck": "tsc --noEmit",
-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/daemon-pid-watchdog.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\" \"../tests/architecture/dev-config-resolver.test.ts\""
+    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/daemon-pid-watchdog.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\" \"../tests/architecture/dev-config-resolver.test.ts\" \"../tests/architecture/install-stamp.test.ts\""
   },
   "engines": { "node": ">=22" },
   "dependencies": {
diff --git a/hosts/common/install/install-stamp.js b/hosts/common/install/install-stamp.js
new file mode 100644
index 0000000..1ccca65
--- /dev/null
+++ b/hosts/common/install/install-stamp.js
@@ -0,0 +1,52 @@
+/**
+ * Build the central-install stamp object that the stage scripts write to
+ * `install-stamp.json` in each plugin artifact, and that
+ * `ensure-central-install.js → readInstallStamp` consumes.
+ *
+ * The three version fields come from three INDEPENDENT sources — the plugin
+ * manifest (`plugin_version`), `DAEMON_VERSION` (`daemon_bundle_version`), and
+ * the per-comm `ADAPTER_VERSION` (`adapter_bundle_version`). Keeping them
+ * separate is the whole point: a plugin-version bump must never masquerade as
+ * an adapter/daemon content change (the conflation the central-install
+ * downgrade guards exist to prevent). This builder takes them as distinct
+ * arguments and never derives one from another.
+ *
+ * All three are required non-empty strings, matching readInstallStamp's strict
+ * validation (schema_version === 1 + the three version strings). A plugin
+ * manifest that lacks a `version` therefore fails loud at stage time rather
+ * than producing a stamp the reader would reject.
+ */
+export const INSTALL_STAMP_SCHEMA = 1;
+
+/**
+ * @param {Object} fields
+ * @param {string} fields.agent
+ * @param {string} fields.comm
+ * @param {string} fields.pluginVersion        provenance (from the plugin manifest)
+ * @param {string} fields.daemonBundleVersion   content key (DAEMON_VERSION)
+ * @param {string} fields.adapterBundleVersion  content key (per-comm ADAPTER_VERSION)
+ * @returns {{schema_version:number, agent:string, comm:string, plugin_version:string, daemon_bundle_version:string, adapter_bundle_version:string}}
+ */
+export function buildInstallStamp(fields) {
+  const { agent, comm, pluginVersion, daemonBundleVersion, adapterBundleVersion } = fields ?? {};
+  requireString("agent", agent);
+  requireString("comm", comm);
+  requireString("pluginVersion", pluginVersion);
+  requireString("daemonBundleVersion", daemonBundleVersion);
+  requireString("adapterBundleVersion", adapterBundleVersion);
+  return {
+    schema_version: INSTALL_STAMP_SCHEMA,
+    agent,
+    comm,
+    plugin_version: pluginVersion,
+    daemon_bundle_version: daemonBundleVersion,
+    adapter_bundle_version: adapterBundleVersion,
+  };
+}
+
+/** @param {string} name @param {unknown} value */
+function requireString(name, value) {
+  if (typeof value !== "string" || value.length === 0) {
+    throw new Error(`buildInstallStamp: ${name} must be a non-empty string`);
+  }
+}
diff --git a/scripts/stage-plugins.js b/scripts/stage-plugins.js
index 7199dae..f67e964 100755
--- a/scripts/stage-plugins.js
+++ b/scripts/stage-plugins.js
@@ -21,8 +21,11 @@
 import { copyFile, mkdir, readFile, readdir, writeFile, access, rm } from "node:fs/promises";
 import { createReadStream, createWriteStream } from "node:fs";
 import { extname, resolve, relative, basename, dirname } from "node:path";
+import { pathToFileURL } from "node:url";
 import { pipeline } from "node:stream/promises";
 
+import { buildInstallStamp } from "../hosts/common/install/install-stamp.js";
+
 const REPO_ROOT = resolve(import.meta.dirname, "..");
 const DEFAULT_OUTPUT_DIR = resolve(REPO_ROOT, "plugins");
 
@@ -124,6 +127,25 @@ async function writeJson(p, obj) {
   return writeText(p, JSON.stringify(obj, null, 2) + "\n");
 }
 
+/**
+ * Load a named string export from a built dist module. Used to source the
+ * install-stamp version fields from authoritative, independent sources:
+ * DAEMON_VERSION (core-daemon) and ADAPTER_VERSION (per-comm adapter). Requires
+ * `npm --workspace agents-comm-bus run build` to have produced dist first.
+ */
+async function loadDistExport(distRelPath, exportName) {
+  const abs = resolve(REPO_ROOT, distRelPath);
+  if (!(await pathExists(abs))) {
+    throw new Error(`stage-plugins: missing ${distRelPath} (run the agents-comm-bus build first)`);
+  }
+  const mod = await import(pathToFileURL(abs).href);
+  const value = mod[exportName];
+  if (typeof value !== "string" || value.length === 0) {
+    throw new Error(`stage-plugins: ${exportName} missing/invalid in ${distRelPath}`);
+  }
+  return value;
+}
+
 /* ── skill assembly (copied from assemble-skills.js for self-containment) ── */
 
 function parseSkill(content) {
@@ -374,8 +396,10 @@ async function stagePair(agent, comm) {
   const manifestSrcDir = resolve(REPO_ROOT, manifestName);
   const manifestSrc = resolve(manifestSrcDir, "plugin.json");
   const manifestDst = resolve(outDir, manifestName, "plugin.json");
+  let pluginVersion = null;
   if (await pathExists(manifestSrc)) {
     const manifest = await readJson(manifestSrc);
+    pluginVersion = typeof manifest.version === "string" ? manifest.version : null;
     // Ensure MCP server args point to the staged shim. Codex stores MCP
     // server declarations in artifact-local .mcp.json, not plugin.json.
     if (agent === "codex") {
@@ -389,6 +413,35 @@ async function stagePair(agent, comm) {
     record(manifestSrc, manifestDst, "manifest");
   }
 
+  /* 4b. Central-install stamp — runtime-readable version source. Three
+     independent fields so adapter/daemon/plugin versions can diverge without
+     one masquerading as another (see install-model.md + AGE-13). No timestamp,
+     so the stamp is byte-stable across stagings. */
+  const daemonBundleVersion = await loadDistExport(
+    "agents-comm-bus/dist/core-daemon/config.js",
+    "DAEMON_VERSION",
+  );
+  const adapterBundleVersion = await loadDistExport(
+    `agents-comm-bus/dist/adapters/${comm}/version.js`,
+    "ADAPTER_VERSION",
+  );
+  const stampDst = resolve(outDir, "install-stamp.json");
+  await writeJson(
+    stampDst,
+    buildInstallStamp({
+      agent,
+      comm,
+      pluginVersion,
+      daemonBundleVersion,
+      adapterBundleVersion,
+    }),
+  );
+  mapping.artifacts.push({
+    source: `core-daemon/config.ts (DAEMON_VERSION) + adapters/${comm}/version.ts (ADAPTER_VERSION) + ${manifestName}/plugin.json (version)`,
+    artifact: relative(REPO_ROOT, stampDst),
+    type: "install-stamp",
+  });
+
   /* 5. Codex .mcp.json */
   if (agent === "codex") {
     const mcpJsonSrc = resolve(REPO_ROOT, ".mcp.json.template");
diff --git a/tests/architecture/install-stamp.test.ts b/tests/architecture/install-stamp.test.ts
new file mode 100644
index 0000000..7b6c54f
--- /dev/null
+++ b/tests/architecture/install-stamp.test.ts
@@ -0,0 +1,77 @@
+import assert from "node:assert/strict";
+import { describe, it } from "node:test";
+
+import {
+  buildInstallStamp,
+  INSTALL_STAMP_SCHEMA,
+} from "../../hosts/common/install/install-stamp.js";
+
+// ---------------------------------------------------------------------------
+// buildInstallStamp: the writer side of install-stamp.json. Pure — no build or
+// staged artifacts needed. readInstallStamp (ensure-central-install.js) is the
+// reader; both agree on shape + strictness.
+// ---------------------------------------------------------------------------
+
+const VALID = {
+  agent: "claude",
+  comm: "telegram",
+  pluginVersion: "1.2.0",
+  daemonBundleVersion: "2.0.0",
+  adapterBundleVersion: "0.1.0",
+};
+
+describe("buildInstallStamp", () => {
+  it("maps the three independent versions into the stamp shape", () => {
+    const stamp = buildInstallStamp(VALID);
+    assert.equal(stamp.schema_version, INSTALL_STAMP_SCHEMA);
+    assert.equal(stamp.agent, "claude");
+    assert.equal(stamp.comm, "telegram");
+    assert.equal(stamp.plugin_version, "1.2.0");
+    assert.equal(stamp.daemon_bundle_version, "2.0.0");
+    assert.equal(stamp.adapter_bundle_version, "0.1.0");
+  });
+
+  it("keeps the three versions independent — none derived from another", () => {
+    // Distinct inputs must surface as distinct, correctly-placed fields, so a
+    // plugin-version bump can never masquerade as an adapter/daemon change.
+    const stamp = buildInstallStamp({
+      agent: "codex",
+      comm: "telegram",
+      pluginVersion: "9.9.9",
+      daemonBundleVersion: "2.0.0",
+      adapterBundleVersion: "0.1.0",
+    });
+    assert.equal(stamp.plugin_version, "9.9.9");
+    assert.equal(stamp.daemon_bundle_version, "2.0.0");
+    assert.equal(stamp.adapter_bundle_version, "0.1.0");
+    // The content keys must NOT equal the (higher) plugin_version.
+    assert.notEqual(stamp.daemon_bundle_version, stamp.plugin_version);
+    assert.notEqual(stamp.adapter_bundle_version, stamp.plugin_version);
+  });
+
+  it("produces a stamp readInstallStamp accepts (schema_version === 1, three version strings)", () => {
+    const stamp = buildInstallStamp(VALID);
+    assert.equal(stamp.schema_version, 1);
+    assert.equal(typeof stamp.plugin_version, "string");
+    assert.equal(typeof stamp.daemon_bundle_version, "string");
+    assert.equal(typeof stamp.adapter_bundle_version, "string");
+  });
+
+  for (const missing of [
+    "agent",
+    "comm",
+    "pluginVersion",
+    "daemonBundleVersion",
+    "adapterBundleVersion",
+  ] as const) {
+    it(`throws when ${missing} is missing (fail loud at stage time)`, () => {
+      const fields: Record<string, string> = { ...VALID };
+      delete fields[missing];
+      assert.throws(() => buildInstallStamp(fields as never), new RegExp(missing));
+    });
+  }
+
+  it("throws on an empty-string version rather than emitting a bad stamp", () => {
+    assert.throws(() => buildInstallStamp({ ...VALID, adapterBundleVersion: "" }), /adapterBundleVersion/);
+  });
+});

````

---

### `df554f6` -- AGE-13 step 3 (part 1): entryEnsures — canonical ensure path

AGE-13 step 3a: entryEnsures -- the single ordered ensure path (applyDevConfig -> ensureCentralInstall -> ensureDaemon); returns the daemon result; source skips install but still ensures daemon; production fails before daemon.

_Files (stat):_

```
 agents-comm-bus/package.json             |   2 +-
 hosts/common/install/entry-ensures.js    |  81 ++++++++++++++++++
 tests/architecture/entry-ensures.test.ts | 140 +++++++++++++++++++++++++++++++
 3 files changed, 222 insertions(+), 1 deletion(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
index a7a9284..e8dfad9 100644
--- a/agents-comm-bus/package.json
+++ b/agents-comm-bus/package.json
@@ -27,7 +27,7 @@
   "scripts": {
     "build": "tsc && node scripts/copy-assets.js",
     "typecheck": "tsc --noEmit",
-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/daemon-pid-watchdog.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\" \"../tests/architecture/dev-config-resolver.test.ts\" \"../tests/architecture/install-stamp.test.ts\""
+    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/daemon-pid-watchdog.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\" \"../tests/architecture/dev-config-resolver.test.ts\" \"../tests/architecture/install-stamp.test.ts\" \"../tests/architecture/entry-ensures.test.ts\""
   },
   "engines": { "node": ">=22" },
   "dependencies": {
diff --git a/hosts/common/install/entry-ensures.js b/hosts/common/install/entry-ensures.js
new file mode 100644
index 0000000..33eefe5
--- /dev/null
+++ b/hosts/common/install/entry-ensures.js
@@ -0,0 +1,81 @@
+/**
+ * entryEnsures — the single canonical "ensure the runtime is ready" path that
+ * every host entrypoint (the per-agent hooks + the MCP shim) calls instead of
+ * open-coding ensureCentralInstall + ensureDaemon themselves.
+ *
+ * Ordered contract (see install-model.md + AGE-13):
+ *   1. Resolve dev-config: a gitignored repo-local marker is turned into
+ *      env-shaped overrides (applyDevConfig) and merged onto the caller's env.
+ *      resolveInstallMode stays env-only; this is just the convenience layer.
+ *   2. ensureCentralInstall FIRST. In source/dev mode (AGENTS_COMM_BUS_BIN set)
+ *      it skips central install; in production mode it REQUIRES a valid install
+ *      stamp and throws if missing — and because it runs before ensureDaemon, a
+ *      packaging failure is never masked by a spawned daemon.
+ *   3. ensureDaemon. Its result is returned (with `centralInstall` attached) so
+ *      existing callers keep using `{ port, hello, spawned }`.
+ *
+ * Inputs are explicit. process.env is only read as the outermost default here
+ * (entryEnsures IS the outermost wrapper the hooks/shim call); inner logic uses
+ * the passed/merged env. All collaborators are injectable for testing.
+ */
+import { ensureDaemon as defaultEnsureDaemon } from "../../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js";
+import { ensureCentralInstall as defaultEnsureCentralInstall } from "./ensure-central-install.js";
+import { applyDevConfig } from "./dev-config-resolver.js";
+
+/**
+ * @typedef {Object} EntryEnsuresOptions
+ * @property {string} agent
+ * @property {string} comm
+ * @property {string} [stateRoot]
+ * @property {string} [projectRoot]          repo/worktree root for the dev marker lookup
+ * @property {string} [pluginInstallDir]     plugin artifact dir (production stamp source)
+ * @property {Record<string,string|undefined>} [env]   defaults to process.env (outermost only)
+ * @property {Object} [ensureDaemonOptions]  forwarded verbatim to ensureDaemon
+ * @property {boolean} [daemonRunning]
+ * @property {EntryEnsuresDeps} [deps]
+ *
+ * @typedef {Object} EntryEnsuresDeps
+ * @property {typeof defaultEnsureDaemon} [ensureDaemon]
+ * @property {typeof defaultEnsureCentralInstall} [ensureCentralInstall]
+ * @property {import("./dev-config-resolver.js").DevConfigDeps} [devConfigDeps]
+ * @property {import("./ensure-central-install.js").EnsureCentralInstallDeps} [centralInstallDeps]
+ */
+
+/**
+ * @param {EntryEnsuresOptions} options
+ */
+export async function entryEnsures(options) {
+  const {
+    agent,
+    comm,
+    stateRoot,
+    projectRoot,
+    pluginInstallDir,
+    env = process.env,
+    ensureDaemonOptions = {},
+    daemonRunning = false,
+    deps = {},
+  } = options ?? {};
+
+  const ensureDaemonFn = deps.ensureDaemon ?? defaultEnsureDaemon;
+  const ensureCentralInstallFn = deps.ensureCentralInstall ?? defaultEnsureCentralInstall;
+
+  // 1. Dev-config marker → merged env (no-op without a marker; never mutates the
+  //    caller's env object).
+  const resolvedEnv = projectRoot ? applyDevConfig(env, projectRoot, deps.devConfigDeps).env : env;
+
+  // 2. Central install FIRST — production failures throw here, before any spawn.
+  const centralInstall = await ensureCentralInstallFn({
+    stateRoot,
+    agent,
+    comm,
+    pluginInstallDir,
+    env: resolvedEnv,
+    daemonRunning,
+    deps: deps.centralInstallDeps,
+  });
+
+  // 3. Then ensure the daemon; return its result so callers keep {port, hello, spawned}.
+  const daemon = await ensureDaemonFn(ensureDaemonOptions);
+  return { ...daemon, centralInstall };
+}
diff --git a/tests/architecture/entry-ensures.test.ts b/tests/architecture/entry-ensures.test.ts
new file mode 100644
index 0000000..9a84ce2
--- /dev/null
+++ b/tests/architecture/entry-ensures.test.ts
@@ -0,0 +1,140 @@
+import assert from "node:assert/strict";
+import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
+import os from "node:os";
+import path from "node:path";
+import { describe, it } from "node:test";
+
+import { entryEnsures } from "../../hosts/common/install/entry-ensures.js";
+import { INSTALL_STAMP_NAME } from "../../hosts/common/install/ensure-central-install.js";
+import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";
+import { DEV_MARKER_NAME } from "../../hosts/common/install/dev-config-resolver.js";
+
+// entryEnsures composes applyDevConfig -> ensureCentralInstall -> ensureDaemon.
+// Tests use the REAL ensureCentralInstall (deterministic via fixtures/env) and
+// a spy ensureDaemon, so they prove the real ordering/mode contract rather than
+// only that a mock was called.
+
+async function tempDir(prefix: string): Promise<string> {
+  return mkdtemp(path.join(os.tmpdir(), prefix));
+}
+
+/** A production plugin dir: real bundle payloads + a valid install-stamp. */
+async function fixturedPlugin(): Promise<string> {
+  const dir = await tempDir("acb-ee-plugin-");
+  await writeFile(path.join(dir, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
+  await writeFile(path.join(dir, "telegram.adapter.bundle.js"), "TELEGRAM_ADAPTER_v1.0.0", "utf8");
+  await writeFile(
+    path.join(dir, INSTALL_STAMP_NAME),
+    JSON.stringify({
+      schema_version: 1,
+      agent: "claude",
+      comm: "telegram",
+      plugin_version: "0.1.0",
+      daemon_bundle_version: "1.0.0",
+      adapter_bundle_version: "0.1.0",
+    }),
+    "utf8",
+  );
+  return dir;
+}
+
+function spyEnsureDaemon() {
+  let calls = 0;
+  const fn = async () => {
+    calls += 1;
+    return { port: 51999, hello: { daemonName: "agents-comm-bus" }, spawned: false };
+  };
+  return { fn, get called() { return calls; } };
+}
+
+describe("entryEnsures — production mode", () => {
+  it("runs central install then ensureDaemon, returning the daemon result + centralInstall", async () => {
+    const stateRoot = await tempDir("acb-ee-state-");
+    const plugin = await fixturedPlugin();
+    const daemon = spyEnsureDaemon();
+
+    const result = await entryEnsures({
+      agent: "claude",
+      comm: "telegram",
+      stateRoot,
+      pluginInstallDir: plugin,
+      env: {}, // no AGENTS_COMM_BUS_BIN -> production
+      deps: { ensureDaemon: daemon.fn },
+    });
+
+    assert.equal(daemon.called, 1, "ensureDaemon must be called");
+    assert.equal(result.port, 51999, "returns the ensureDaemon result fields");
+    assert.equal(result.spawned, false);
+    assert.equal(result.centralInstall.mode, "production");
+    // The install really happened (bundle landed) before the daemon was ensured.
+    const paths = resolveCentralPaths(stateRoot, "telegram");
+    const { readFile } = await import("node:fs/promises");
+    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
+  });
+
+  it("fails BEFORE ensureDaemon when production metadata is missing (no daemon spawn masks it)", async () => {
+    const stateRoot = await tempDir("acb-ee-state-");
+    const daemon = spyEnsureDaemon();
+
+    await assert.rejects(
+      () =>
+        entryEnsures({
+          agent: "claude",
+          comm: "telegram",
+          stateRoot,
+          // no pluginInstallDir -> production strict failure
+          env: {},
+          deps: { ensureDaemon: daemon.fn },
+        }),
+      /missing or invalid plugin install metadata/,
+    );
+    assert.equal(daemon.called, 0, "ensureDaemon must NOT run after a central-install failure");
+  });
+});
+
+describe("entryEnsures — source/dev mode", () => {
+  it("skips central install but still ensures the daemon when AGENTS_COMM_BUS_BIN is set", async () => {
+    const stateRoot = await tempDir("acb-ee-state-");
+    const daemon = spyEnsureDaemon();
+
+    const result = await entryEnsures({
+      agent: "claude",
+      comm: "telegram",
+      stateRoot,
+      env: { AGENTS_COMM_BUS_BIN: "/proj/core/serve.js" },
+      deps: { ensureDaemon: daemon.fn },
+    });
+
+    assert.equal(result.centralInstall.mode, "source");
+    assert.equal(result.centralInstall.skipped, true);
+    assert.equal(daemon.called, 1, "daemon still ensured in source mode");
+  });
+
+  it("a gitignored dev marker resolves into source mode (marker -> env -> resolveInstallMode)", async () => {
+    const stateRoot = await tempDir("acb-ee-state-");
+    const daemon = spyEnsureDaemon();
+
+    // A project root with a valid marker pointing at an existing source entry.
+    const projectRoot = await tempDir("acb-ee-proj-");
+    const binRel = "agents-comm-bus/dist/core-daemon/serve.js";
+    await mkdir(path.join(projectRoot, path.dirname(binRel)), { recursive: true });
+    await writeFile(path.join(projectRoot, binRel), "// daemon\n", "utf8");
+    await writeFile(
+      path.join(projectRoot, DEV_MARKER_NAME),
+      JSON.stringify({ daemonBin: binRel }),
+      "utf8",
+    );
+
+    const result = await entryEnsures({
+      agent: "claude",
+      comm: "telegram",
+      stateRoot,
+      projectRoot,
+      env: {}, // marker supplies AGENTS_COMM_BUS_BIN
+      deps: { ensureDaemon: daemon.fn },
+    });
+
+    assert.equal(result.centralInstall.mode, "source", "marker put us in source mode");
+    assert.equal(daemon.called, 1);
+  });
+});

````

---

### `8727ea7` -- AGE-13 step 3 (part 1b): entry-path resolver for entryEnsures

AGE-13 step 3b: resolveEntryContext(fromDir) -- symmetric nearest-ancestor walk for projectRoot (dev marker) and pluginInstallDir (install-stamp), so each entry's wiring is one line.

_Files (stat):_

```
 hosts/common/install/entry-ensures.js    | 61 ++++++++++++++++++++++++++++++--
 tests/architecture/entry-ensures.test.ts | 24 ++++++++++++-
 2 files changed, 81 insertions(+), 4 deletions(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/hosts/common/install/entry-ensures.js b/hosts/common/install/entry-ensures.js
index 33eefe5..38f12b5 100644
--- a/hosts/common/install/entry-ensures.js
+++ b/hosts/common/install/entry-ensures.js
@@ -18,9 +18,51 @@
  * (entryEnsures IS the outermost wrapper the hooks/shim call); inner logic uses
  * the passed/merged env. All collaborators are injectable for testing.
  */
+import { existsSync } from "node:fs";
+import path from "node:path";
+
 import { ensureDaemon as defaultEnsureDaemon } from "../../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js";
 import { ensureCentralInstall as defaultEnsureCentralInstall } from "./ensure-central-install.js";
-import { applyDevConfig } from "./dev-config-resolver.js";
+import { applyDevConfig, DEV_MARKER_NAME } from "./dev-config-resolver.js";
+import { INSTALL_STAMP_NAME } from "./ensure-central-install.js";
+
+/**
+ * Derive the entry context for a calling hook/shim from its own directory, so
+ * every entrypoint can pass just `fromDir` and get identical resolution:
+ *   - projectRoot:      nearest ancestor containing the gitignored dev marker
+ *                       (`.agents-comm-bus-dev.json`). In a source/dev checkout
+ *                       this is the repo root; in a packaged install it is
+ *                       absent (no marker shipped).
+ *   - pluginInstallDir: nearest ancestor containing `install-stamp.json`. In a
+ *                       packaged install this is the plugin root; in a dev
+ *                       checkout it is absent (no committed stamp).
+ *
+ * Symmetric "nearest ancestor with marker X" walk for both, so the same hook
+ * file resolves correctly whether it runs from the source tree or a staged
+ * plugin dir.
+ *
+ * @param {string} fromDir
+ * @param {{ exists?: (p: string) => boolean }} [deps]
+ * @returns {{ projectRoot?: string, pluginInstallDir?: string }}
+ */
+export function resolveEntryContext(fromDir, deps = {}) {
+  const exists = deps.exists ?? existsSync;
+  return {
+    projectRoot: findAncestorContaining(fromDir, DEV_MARKER_NAME, exists),
+    pluginInstallDir: findAncestorContaining(fromDir, INSTALL_STAMP_NAME, exists),
+  };
+}
+
+/** @returns {string|undefined} nearest ancestor of `dir` (inclusive) holding `name` */
+function findAncestorContaining(dir, name, exists) {
+  let current = path.resolve(dir);
+  for (;;) {
+    if (exists(path.join(current, name))) return current;
+    const parent = path.dirname(current);
+    if (parent === current) return undefined;
+    current = parent;
+  }
+}
 
 /**
  * @typedef {Object} EntryEnsuresOptions
@@ -49,6 +91,7 @@ export async function entryEnsures(options) {
     agent,
     comm,
     stateRoot,
+    fromDir,
     projectRoot,
     pluginInstallDir,
     env = process.env,
@@ -60,16 +103,28 @@ export async function entryEnsures(options) {
   const ensureDaemonFn = deps.ensureDaemon ?? defaultEnsureDaemon;
   const ensureCentralInstallFn = deps.ensureCentralInstall ?? defaultEnsureCentralInstall;
 
+  // Hooks/shims pass their own dir; explicit projectRoot/pluginInstallDir still
+  // win (used by tests). fromDir derives both via the symmetric marker walk.
+  let resolvedProjectRoot = projectRoot;
+  let resolvedPluginInstallDir = pluginInstallDir;
+  if (fromDir && (resolvedProjectRoot === undefined || resolvedPluginInstallDir === undefined)) {
+    const ctx = resolveEntryContext(fromDir, deps.entryContextDeps);
+    resolvedProjectRoot = resolvedProjectRoot ?? ctx.projectRoot;
+    resolvedPluginInstallDir = resolvedPluginInstallDir ?? ctx.pluginInstallDir;
+  }
+
   // 1. Dev-config marker → merged env (no-op without a marker; never mutates the
   //    caller's env object).
-  const resolvedEnv = projectRoot ? applyDevConfig(env, projectRoot, deps.devConfigDeps).env : env;
+  const resolvedEnv = resolvedProjectRoot
+    ? applyDevConfig(env, resolvedProjectRoot, deps.devConfigDeps).env
+    : env;
 
   // 2. Central install FIRST — production failures throw here, before any spawn.
   const centralInstall = await ensureCentralInstallFn({
     stateRoot,
     agent,
     comm,
-    pluginInstallDir,
+    pluginInstallDir: resolvedPluginInstallDir,
     env: resolvedEnv,
     daemonRunning,
     deps: deps.centralInstallDeps,
diff --git a/tests/architecture/entry-ensures.test.ts b/tests/architecture/entry-ensures.test.ts
index 9a84ce2..e6a0eee 100644
--- a/tests/architecture/entry-ensures.test.ts
+++ b/tests/architecture/entry-ensures.test.ts
@@ -4,7 +4,7 @@ import os from "node:os";
 import path from "node:path";
 import { describe, it } from "node:test";
 
-import { entryEnsures } from "../../hosts/common/install/entry-ensures.js";
+import { entryEnsures, resolveEntryContext } from "../../hosts/common/install/entry-ensures.js";
 import { INSTALL_STAMP_NAME } from "../../hosts/common/install/ensure-central-install.js";
 import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";
 import { DEV_MARKER_NAME } from "../../hosts/common/install/dev-config-resolver.js";
@@ -92,6 +92,28 @@ describe("entryEnsures — production mode", () => {
   });
 });
 
+describe("resolveEntryContext", () => {
+  it("finds projectRoot at the nearest ancestor holding the dev marker", async () => {
+    const root = await tempDir("acb-ee-ctx-");
+    await writeFile(path.join(root, DEV_MARKER_NAME), "{}", "utf8");
+    const hookDir = path.join(root, "hosts", "claude", "hooks");
+    await mkdir(hookDir, { recursive: true });
+    const ctx = resolveEntryContext(hookDir);
+    assert.equal(ctx.projectRoot, root);
+    assert.equal(ctx.pluginInstallDir, undefined, "no stamp in a dev tree");
+  });
+
+  it("finds pluginInstallDir at the nearest ancestor holding install-stamp.json", async () => {
+    const pluginRoot = await tempDir("acb-ee-plug-");
+    await writeFile(path.join(pluginRoot, INSTALL_STAMP_NAME), "{}", "utf8");
+    const hookDir = path.join(pluginRoot, "hooks");
+    await mkdir(hookDir, { recursive: true });
+    const ctx = resolveEntryContext(hookDir);
+    assert.equal(ctx.pluginInstallDir, pluginRoot);
+    assert.equal(ctx.projectRoot, undefined, "no dev marker in a packaged install");
+  });
+});
+
 describe("entryEnsures — source/dev mode", () => {
   it("skips central install but still ensures the daemon when AGENTS_COMM_BUS_BIN is set", async () => {
     const stateRoot = await tempDir("acb-ee-state-");

````

---

### `47c5c55` -- AGE-13 step 3 (part 2a): dev-marker template + actionable production error

AGE-13 step 3c: .agents-comm-bus-dev.json.example + actionable production-mode failure naming both fixes (create marker / set AGENTS_COMM_BUS_BIN, or provide staged artifacts).

_Files (stat):_

```
 .agents-comm-bus-dev.json.example              |  5 +++++
 hosts/common/install/ensure-central-install.js | 11 ++++++++---
 2 files changed, 13 insertions(+), 3 deletions(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/.agents-comm-bus-dev.json.example b/.agents-comm-bus-dev.json.example
new file mode 100644
index 0000000..df8dc9c
--- /dev/null
+++ b/.agents-comm-bus-dev.json.example
@@ -0,0 +1,5 @@
+{
+  "_note": "LOCAL DEV ONLY. Copy this to .agents-comm-bus-dev.json (gitignored) to mark THIS checkout as source/dev mode: the install hooks + MCP shim then skip central install and run the daemon from source. This marker is never shipped; production/marketplace installs rely on staged plugin artifacts + install-stamp.json, never on this file. It resolves into the env-only source-mode contract (sets AGENTS_COMM_BUS_BIN) -- it is not itself a second 'skip install' switch.",
+  "_optional": "stateRoot and adaptersDir are optional overrides (AGENTS_COMM_BUS_ROOT / AGENTS_COMM_BUS_ADAPTERS_DIR). Leave stateRoot UNSET when multiple agents share one daemon on this machine (e.g. Claude + Codex both on ~/.agents-comm-bus) -- setting it would split them onto separate state roots.",
+  "daemonBin": "agents-comm-bus/dist/core-daemon/serve.js"
+}
diff --git a/hosts/common/install/ensure-central-install.js b/hosts/common/install/ensure-central-install.js
index 08b0256..32e87eb 100644
--- a/hosts/common/install/ensure-central-install.js
+++ b/hosts/common/install/ensure-central-install.js
@@ -134,9 +134,14 @@ export async function ensureCentralInstall(options) {
   const stamp = await readInstallStamp(options.pluginInstallDir, options.deps);
   if (!options.pluginInstallDir || !stamp) {
     throw new Error(
-      `central install (production mode): missing or invalid plugin install metadata — ` +
-        `expected ${INSTALL_STAMP_NAME} under pluginInstallDir=${options.pluginInstallDir ?? "<unset>"}. ` +
-        `Set AGENTS_COMM_BUS_BIN for source/dev mode, or fix the plugin packaging.`,
+      `central install (production mode): missing or invalid plugin install metadata.\n` +
+        `  - no source-mode signal (no AGENTS_COMM_BUS_BIN, no .agents-comm-bus-dev.json marker resolved)\n` +
+        `  - no valid packaged install artifact (expected ${INSTALL_STAMP_NAME} under ` +
+        `pluginInstallDir=${options.pluginInstallDir ?? "<unset>"})\n` +
+        `Fix one of:\n` +
+        `  - source/dev checkout: create .agents-comm-bus-dev.json at the repo root ` +
+        `(see .agents-comm-bus-dev.json.example), or set AGENTS_COMM_BUS_BIN\n` +
+        `  - packaged install: provide the staged plugin artifacts incl. ${INSTALL_STAMP_NAME}`,
     );
   }
 

````

---

### `6f1d516` -- AGE-13 step 3 (final): wire all entrypoints to entryEnsures + subprocess proof

AGE-13 step 3d: wire all 6 entrypoints (5 hooks + mcp-shim) through entryEnsures + a real-installed-path subprocess proof.

_Files (stat):_

```
 agents-comm-bus/package.json                       |  2 +-
 hosts/claude/hooks/permission-request.js           |  9 ++-
 hosts/claude/hooks/user-prompt-submit.js           |  9 ++-
 hosts/codex/hooks/permission-request.js            |  9 ++-
 hosts/codex/hooks/session-start.js                 |  9 ++-
 hosts/codex/hooks/user-prompt-submit.js            |  9 ++-
 hosts/common/mcp-shim-shared.js                    | 15 ++--
 .../architecture/entry-ensures-subprocess.test.ts  | 94 ++++++++++++++++++++++
 .../fixtures/entry-ensures-harness.mjs             | 35 ++++++++
 9 files changed, 175 insertions(+), 16 deletions(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/agents-comm-bus/package.json b/agents-comm-bus/package.json
index e8dfad9..bc4a215 100644
--- a/agents-comm-bus/package.json
+++ b/agents-comm-bus/package.json
@@ -27,7 +27,7 @@
   "scripts": {
     "build": "tsc && node scripts/copy-assets.js",
     "typecheck": "tsc --noEmit",
-    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/daemon-pid-watchdog.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\" \"../tests/architecture/dev-config-resolver.test.ts\" \"../tests/architecture/install-stamp.test.ts\" \"../tests/architecture/entry-ensures.test.ts\""
+    "test": "node --test --import tsx \"../tests/architecture/bootstrap-race.test.ts\" \"../tests/architecture/ipc-versioning.test.ts\" \"../tests/architecture/sqlite-schema.test.ts\" \"../tests/architecture/allowlist-factory.test.ts\" \"../tests/architecture/reload-allowlist-refresh.test.ts\" \"../tests/architecture/drain-pending-inbound.test.ts\" \"../tests/architecture/daemon-pid-watchdog.test.ts\" \"../tests/architecture/account-registration-cli.test.ts\" \"../tests/architecture/central-install-reconcile.test.ts\" \"../tests/architecture/central-install-execute.test.ts\" \"../tests/architecture/central-install-concurrency.test.ts\" \"../tests/architecture/central-install-mode.test.ts\" \"../tests/architecture/dev-config-resolver.test.ts\" \"../tests/architecture/install-stamp.test.ts\" \"../tests/architecture/entry-ensures.test.ts\" \"../tests/architecture/entry-ensures-subprocess.test.ts\""
   },
   "engines": { "node": ">=22" },
   "dependencies": {
diff --git a/hosts/claude/hooks/permission-request.js b/hosts/claude/hooks/permission-request.js
index 55a493e..78ca03b 100644
--- a/hosts/claude/hooks/permission-request.js
+++ b/hosts/claude/hooks/permission-request.js
@@ -9,7 +9,7 @@
  */
 
 import crypto from 'node:crypto';
-import { ensureDaemon } from '../../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js';
+import { entryEnsures } from '../../common/install/entry-ensures.js';
 import { connectIpc } from '../../../agents-comm-bus/dist/core-daemon/ipc/client.js';
 import {
   ensureClaudeWakeWatcher,
@@ -38,7 +38,12 @@ async function readStdinJson() {
 }
 
 async function openDaemonConnection(metadata) {
-  const daemon = await ensureDaemon({ clientVersion: CLIENT_VERSION, metadata });
+  const daemon = await entryEnsures({
+    fromDir: import.meta.dirname,
+    agent: 'claude',
+    env: process.env,
+    ensureDaemonOptions: { clientVersion: CLIENT_VERSION, metadata },
+  });
   return connectIpc({
     port: daemon.port,
     clientVersion: CLIENT_VERSION,
diff --git a/hosts/claude/hooks/user-prompt-submit.js b/hosts/claude/hooks/user-prompt-submit.js
index d4f895b..d2fb432 100644
--- a/hosts/claude/hooks/user-prompt-submit.js
+++ b/hosts/claude/hooks/user-prompt-submit.js
@@ -9,7 +9,7 @@
  */
 
 import crypto from 'node:crypto';
-import { ensureDaemon } from '../../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js';
+import { entryEnsures } from '../../common/install/entry-ensures.js';
 import { connectIpc } from '../../../agents-comm-bus/dist/core-daemon/ipc/client.js';
 import {
   ensureClaudeWakeWatcher,
@@ -41,7 +41,12 @@ async function readStdinJson() {
 }
 
 async function openDaemonConnection(metadata) {
-  const daemon = await ensureDaemon({ clientVersion: CLIENT_VERSION, metadata });
+  const daemon = await entryEnsures({
+    fromDir: import.meta.dirname,
+    agent: 'claude',
+    env: process.env,
+    ensureDaemonOptions: { clientVersion: CLIENT_VERSION, metadata },
+  });
   return connectIpc({
     port: daemon.port,
     clientVersion: CLIENT_VERSION,
diff --git a/hosts/codex/hooks/permission-request.js b/hosts/codex/hooks/permission-request.js
index a07caa9..60957ba 100644
--- a/hosts/codex/hooks/permission-request.js
+++ b/hosts/codex/hooks/permission-request.js
@@ -9,7 +9,7 @@
  */
 
 import crypto from 'node:crypto';
-import { ensureDaemon } from '../../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js';
+import { entryEnsures } from '../../common/install/entry-ensures.js';
 import { connectIpc } from '../../../agents-comm-bus/dist/core-daemon/ipc/client.js';
 
 const CLIENT_VERSION = 'codex-hook-phase3';
@@ -36,7 +36,12 @@ async function readStdinJson() {
 }
 
 async function openDaemonConnection(metadata) {
-  const daemon = await ensureDaemon({ clientVersion: CLIENT_VERSION, metadata });
+  const daemon = await entryEnsures({
+    fromDir: import.meta.dirname,
+    agent: 'codex',
+    env: process.env,
+    ensureDaemonOptions: { clientVersion: CLIENT_VERSION, metadata },
+  });
   return connectIpc({
     port: daemon.port,
     clientVersion: CLIENT_VERSION,
diff --git a/hosts/codex/hooks/session-start.js b/hosts/codex/hooks/session-start.js
index 235d4fa..2426ad2 100644
--- a/hosts/codex/hooks/session-start.js
+++ b/hosts/codex/hooks/session-start.js
@@ -16,7 +16,7 @@ import path from 'node:path';
 import { spawnSync } from 'node:child_process';
 import { fileURLToPath } from 'node:url';
 
-import { ensureDaemon } from '../../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js';
+import { entryEnsures } from '../../common/install/entry-ensures.js';
 import { connectIpc } from '../../../agents-comm-bus/dist/core-daemon/ipc/client.js';
 
 const CLIENT_VERSION = 'codex-session-start-bootstrap';
@@ -66,7 +66,12 @@ async function readStdinJson() {
 }
 
 async function openDaemonConnection(metadata) {
-  const daemon = await ensureDaemon({ clientVersion: CLIENT_VERSION, metadata });
+  const daemon = await entryEnsures({
+    fromDir: __dirname,
+    agent: 'codex',
+    env: process.env,
+    ensureDaemonOptions: { clientVersion: CLIENT_VERSION, metadata },
+  });
   return connectIpc({
     port: daemon.port,
     clientVersion: CLIENT_VERSION,
diff --git a/hosts/codex/hooks/user-prompt-submit.js b/hosts/codex/hooks/user-prompt-submit.js
index 727e456..288bd8a 100644
--- a/hosts/codex/hooks/user-prompt-submit.js
+++ b/hosts/codex/hooks/user-prompt-submit.js
@@ -9,7 +9,7 @@
  */
 
 import crypto from 'node:crypto';
-import { ensureDaemon } from '../../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js';
+import { entryEnsures } from '../../common/install/entry-ensures.js';
 import { connectIpc } from '../../../agents-comm-bus/dist/core-daemon/ipc/client.js';
 
 const CLIENT_VERSION = 'codex-hook-phase3';
@@ -39,7 +39,12 @@ async function readStdinJson() {
 }
 
 async function openDaemonConnection(metadata) {
-  const daemon = await ensureDaemon({ clientVersion: CLIENT_VERSION, metadata });
+  const daemon = await entryEnsures({
+    fromDir: import.meta.dirname,
+    agent: 'codex',
+    env: process.env,
+    ensureDaemonOptions: { clientVersion: CLIENT_VERSION, metadata },
+  });
   return connectIpc({
     port: daemon.port,
     clientVersion: CLIENT_VERSION,
diff --git a/hosts/common/mcp-shim-shared.js b/hosts/common/mcp-shim-shared.js
index 053afd7..a215ba3 100644
--- a/hosts/common/mcp-shim-shared.js
+++ b/hosts/common/mcp-shim-shared.js
@@ -8,7 +8,7 @@ import {
   ListToolsRequestSchema,
 } from "@modelcontextprotocol/sdk/types.js";
 
-import { ensureDaemon } from "../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js";
+import { entryEnsures } from "./install/entry-ensures.js";
 import { connectIpc } from "../../agents-comm-bus/dist/core-daemon/ipc/client.js";
 import { PersistentIpcClient } from "../../agents-comm-bus/dist/core-daemon/ipc/persistent-client.js";
 import { DAEMON_VERSION } from "../../agents-comm-bus/dist/core-daemon/config.js";
@@ -58,10 +58,15 @@ export function createDaemonRequester(options) {
       agent,
       project: process.cwd(),
     };
-    const ensured = await ensureDaemon({
-      clientVersion: DAEMON_VERSION,
-      metadata,
-      spawnDaemon: options.spawnDaemon ?? spawnDaemonFromMcpShim,
+    const ensured = await entryEnsures({
+      fromDir: import.meta.dirname,
+      agent,
+      env: process.env,
+      ensureDaemonOptions: {
+        clientVersion: DAEMON_VERSION,
+        metadata,
+        spawnDaemon: options.spawnDaemon ?? spawnDaemonFromMcpShim,
+      },
     });
     const connection = await connectIpc({
       port: ensured.port,
diff --git a/tests/architecture/entry-ensures-subprocess.test.ts b/tests/architecture/entry-ensures-subprocess.test.ts
new file mode 100644
index 0000000..6c03e67
--- /dev/null
+++ b/tests/architecture/entry-ensures-subprocess.test.ts
@@ -0,0 +1,94 @@
+import assert from "node:assert/strict";
+import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
+import os from "node:os";
+import path from "node:path";
+import { execFile } from "node:child_process";
+import { promisify } from "node:util";
+import { fileURLToPath } from "node:url";
+import { describe, it } from "node:test";
+
+import { INSTALL_STAMP_NAME } from "../../hosts/common/install/ensure-central-install.js";
+import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";
+
+// Real-installed-path subprocess proof for the entryEnsures wiring. Spawns the
+// harness (which calls entryEnsures exactly as a wired hook does) against a
+// fixtured plugin dir + a clean state root, and asserts the REAL central-install
+// file effects — not that a mock was called. ensureDaemon is stubbed in the
+// harness so no real daemon is spawned.
+
+const run = promisify(execFile);
+const HARNESS = fileURLToPath(new URL("./fixtures/entry-ensures-harness.mjs", import.meta.url));
+
+async function tempDir(prefix: string): Promise<string> {
+  return mkdtemp(path.join(os.tmpdir(), prefix));
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
+/** A production plugin dir (bundles + stamp) with a hooks/ subdir for fromDir. */
+async function fixturePlugin(withStamp: boolean): Promise<{ pluginDir: string; hookDir: string }> {
+  const pluginDir = await tempDir("acb-ee-sub-plugin-");
+  await writeFile(path.join(pluginDir, "daemon.bundle.js"), "DAEMON_BUNDLE_v1.0.0", "utf8");
+  await writeFile(path.join(pluginDir, "telegram.adapter.bundle.js"), "TELEGRAM_ADAPTER_v1.0.0", "utf8");
+  if (withStamp) {
+    await writeFile(
+      path.join(pluginDir, INSTALL_STAMP_NAME),
+      JSON.stringify({
+        schema_version: 1,
+        agent: "claude",
+        comm: "telegram",
+        plugin_version: "0.1.0",
+        daemon_bundle_version: "1.0.0",
+        adapter_bundle_version: "0.1.0",
+      }),
+      "utf8",
+    );
+  }
+  const hookDir = path.join(pluginDir, "hooks");
+  await mkdir(hookDir, { recursive: true });
+  return { pluginDir, hookDir };
+}
+
+describe("entryEnsures wiring — subprocess real-installed-path proof", () => {
+  it("production: a wired-hook-style invocation lands the real install, then ensures the daemon", async () => {
+    const { hookDir } = await fixturePlugin(true);
+    const stateRoot = await tempDir("acb-ee-sub-state-");
+
+    const { stdout } = await run("node", [HARNESS, hookDir, stateRoot]);
+    const out = JSON.parse(stdout.trim());
+    assert.equal(out.ok, true);
+    assert.equal(out.mode, "production");
+    assert.equal(out.port, 1, "stubbed ensureDaemon ran and its result shape survived");
+
+    // The decisive check: the real bundle was copied into the state root.
+    const paths = resolveCentralPaths(stateRoot, "telegram");
+    assert.equal(await exists(paths.daemonBundle), true, "daemon bundle really installed");
+    assert.equal(await exists(paths.daemonVersionFile), true, "version metadata really written");
+  });
+
+  it("production failure: a missing stamp aborts BEFORE the daemon ensure, with nothing installed", async () => {
+    const { hookDir } = await fixturePlugin(false); // no install-stamp.json
+    const stateRoot = await tempDir("acb-ee-sub-state-");
+
+    await assert.rejects(
+      () => run("node", [HARNESS, hookDir, stateRoot]),
+      (err: unknown) => {
+        const e = err as { code?: number; stderr?: string };
+        assert.equal(e.code, 3, "harness exits non-zero on entryEnsures throw");
+        assert.match(e.stderr ?? "", /missing or invalid plugin install metadata/);
+        return true;
+      },
+    );
+
+    // Failed before any install: the state root has no daemon bundle.
+    const paths = resolveCentralPaths(stateRoot, "telegram");
+    assert.equal(await exists(paths.daemonBundle), false, "nothing installed on the failure path");
+  });
+});
diff --git a/tests/architecture/fixtures/entry-ensures-harness.mjs b/tests/architecture/fixtures/entry-ensures-harness.mjs
new file mode 100644
index 0000000..d9c180e
--- /dev/null
+++ b/tests/architecture/fixtures/entry-ensures-harness.mjs
@@ -0,0 +1,35 @@
+/**
+ * Subprocess harness for the entryEnsures real-installed-path proof.
+ *
+ * Invoked as: node entry-ensures-harness.mjs <fromDir> <stateRoot>
+ *
+ * Calls entryEnsures the way a wired hook does — fromDir resolves the plugin
+ * install dir (and any dev marker) from the real filesystem, env is empty so we
+ * exercise the strict PRODUCTION path, and ensureDaemon is stubbed (we are
+ * proving the real central-install file effects, not spawning a daemon). On
+ * success prints a JSON line; on failure prints to stderr and exits non-zero —
+ * so the test can assert install-before-daemon and fail-before-daemon against
+ * the real state root, not a mock.
+ */
+import { entryEnsures } from "../../../hosts/common/install/entry-ensures.js";
+
+const [, , fromDir, stateRoot] = process.argv;
+
+try {
+  const result = await entryEnsures({
+    fromDir,
+    agent: "claude",
+    stateRoot,
+    env: {}, // no AGENTS_COMM_BUS_BIN -> strict production path
+    deps: {
+      ensureDaemon: async () => ({ port: 1, hello: { daemonName: "stub" }, spawned: false }),
+    },
+    ensureDaemonOptions: {},
+  });
+  process.stdout.write(
+    JSON.stringify({ ok: true, mode: result.centralInstall?.mode, port: result.port }) + "\n",
+  );
+} catch (error) {
+  process.stderr.write(`ENTRY_ENSURES_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
+  process.exit(3);
+}

````

---

### `2d4539e` -- AGE-13 step 3 (blocker fix): canonical stateRoot in entryEnsures

AGE-13 step 3e (blocker fix): derive ONE canonical stateRoot (explicit -> AGENTS_COMM_BUS_ROOT -> daemon default) fed to BOTH ensureCentralInstall and ensureDaemon; fixes the production undefined-stateRoot crash + marker-root propagation. Merge tip.

_Files (stat):_

```
 hosts/common/install/entry-ensures.js              | 24 +++++-
 .../architecture/entry-ensures-subprocess.test.ts  | 18 ++++-
 tests/architecture/entry-ensures.test.ts           | 87 +++++++++++++++++++++-
 .../fixtures/entry-ensures-harness.mjs             | 31 ++++----
 4 files changed, 140 insertions(+), 20 deletions(-)
```

_Source diff (dist/plugins excluded):_

````diff
diff --git a/hosts/common/install/entry-ensures.js b/hosts/common/install/entry-ensures.js
index 38f12b5..12cc578 100644
--- a/hosts/common/install/entry-ensures.js
+++ b/hosts/common/install/entry-ensures.js
@@ -22,6 +22,7 @@ import { existsSync } from "node:fs";
 import path from "node:path";
 
 import { ensureDaemon as defaultEnsureDaemon } from "../../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js";
+import { resolveStatePaths as defaultResolveStatePaths } from "../../../agents-comm-bus/dist/core-daemon/paths.js";
 import { ensureCentralInstall as defaultEnsureCentralInstall } from "./ensure-central-install.js";
 import { applyDevConfig, DEV_MARKER_NAME } from "./dev-config-resolver.js";
 import { INSTALL_STAMP_NAME } from "./ensure-central-install.js";
@@ -79,8 +80,10 @@ function findAncestorContaining(dir, name, exists) {
  * @typedef {Object} EntryEnsuresDeps
  * @property {typeof defaultEnsureDaemon} [ensureDaemon]
  * @property {typeof defaultEnsureCentralInstall} [ensureCentralInstall]
+ * @property {typeof defaultResolveStatePaths} [resolveStatePaths]  default-root resolver (injectable in tests so the fallback can't touch the real ~/.agents-comm-bus)
  * @property {import("./dev-config-resolver.js").DevConfigDeps} [devConfigDeps]
  * @property {import("./ensure-central-install.js").EnsureCentralInstallDeps} [centralInstallDeps]
+ * @property {{ exists?: (p: string) => boolean }} [entryContextDeps]
  */
 
 /**
@@ -119,9 +122,23 @@ export async function entryEnsures(options) {
     ? applyDevConfig(env, resolvedProjectRoot, deps.devConfigDeps).env
     : env;
 
+  // 1b. Derive ONE canonical state root and feed it to both ensureCentralInstall
+  //     and ensureDaemon, so they never diverge. Precedence: explicit option ->
+  //     resolved AGENTS_COMM_BUS_ROOT (marker/env) -> the daemon's own default
+  //     (which honors AGENTS_COMM_BUS_STATE_ROOT, else ~/.agents-comm-bus).
+  //     Live hooks/shim call entryEnsures WITHOUT an explicit stateRoot, so
+  //     without this the production path passed undefined into runCentralInstall
+  //     (path.join(undefined, ...) crash) and the daemon ensure never saw the
+  //     marker-resolved root.
+  const resolveStatePathsFn = deps.resolveStatePaths ?? defaultResolveStatePaths;
+  const canonicalStateRoot =
+    stateRoot ??
+    resolvedEnv.AGENTS_COMM_BUS_ROOT ??
+    resolveStatePathsFn({ stateRoot: resolvedEnv.AGENTS_COMM_BUS_STATE_ROOT }).root;
+
   // 2. Central install FIRST — production failures throw here, before any spawn.
   const centralInstall = await ensureCentralInstallFn({
-    stateRoot,
+    stateRoot: canonicalStateRoot,
     agent,
     comm,
     pluginInstallDir: resolvedPluginInstallDir,
@@ -130,7 +147,8 @@ export async function entryEnsures(options) {
     deps: deps.centralInstallDeps,
   });
 
-  // 3. Then ensure the daemon; return its result so callers keep {port, hello, spawned}.
-  const daemon = await ensureDaemonFn(ensureDaemonOptions);
+  // 3. Then ensure the daemon with the SAME canonical root; return its result so
+  //    callers keep using { port, hello, spawned }.
+  const daemon = await ensureDaemonFn({ ...ensureDaemonOptions, stateRoot: canonicalStateRoot });
   return { ...daemon, centralInstall };
 }
diff --git a/tests/architecture/entry-ensures-subprocess.test.ts b/tests/architecture/entry-ensures-subprocess.test.ts
index 6c03e67..e094037 100644
--- a/tests/architecture/entry-ensures-subprocess.test.ts
+++ b/tests/architecture/entry-ensures-subprocess.test.ts
@@ -32,6 +32,17 @@ async function exists(p: string): Promise<boolean> {
   }
 }
 
+/**
+ * Child env in the real wired-hook shape: the state root comes from
+ * AGENTS_COMM_BUS_ROOT (not an explicit stateRoot arg), and AGENTS_COMM_BUS_BIN
+ * is cleared so we stay on the strict production path.
+ */
+function childEnv(stateRoot: string): NodeJS.ProcessEnv {
+  const e: NodeJS.ProcessEnv = { ...process.env, AGENTS_COMM_BUS_ROOT: stateRoot };
+  delete e.AGENTS_COMM_BUS_BIN;
+  return e;
+}
+
 /** A production plugin dir (bundles + stamp) with a hooks/ subdir for fromDir. */
 async function fixturePlugin(withStamp: boolean): Promise<{ pluginDir: string; hookDir: string }> {
   const pluginDir = await tempDir("acb-ee-sub-plugin-");
@@ -61,11 +72,14 @@ describe("entryEnsures wiring — subprocess real-installed-path proof", () => {
     const { hookDir } = await fixturePlugin(true);
     const stateRoot = await tempDir("acb-ee-sub-state-");
 
-    const { stdout } = await run("node", [HARNESS, hookDir, stateRoot]);
+    // No explicit stateRoot arg — entryEnsures must derive the canonical root
+    // from the env (the real wired-hook shape that the old harness masked).
+    const { stdout } = await run("node", [HARNESS, hookDir], { env: childEnv(stateRoot) });
     const out = JSON.parse(stdout.trim());
     assert.equal(out.ok, true);
     assert.equal(out.mode, "production");
     assert.equal(out.port, 1, "stubbed ensureDaemon ran and its result shape survived");
+    assert.equal(out.daemonStateRoot, stateRoot, "daemon ensure got the SAME canonical root as central install");
 
     // The decisive check: the real bundle was copied into the state root.
     const paths = resolveCentralPaths(stateRoot, "telegram");
@@ -78,7 +92,7 @@ describe("entryEnsures wiring — subprocess real-installed-path proof", () => {
     const stateRoot = await tempDir("acb-ee-sub-state-");
 
     await assert.rejects(
-      () => run("node", [HARNESS, hookDir, stateRoot]),
+      () => run("node", [HARNESS, hookDir], { env: childEnv(stateRoot) }),
       (err: unknown) => {
         const e = err as { code?: number; stderr?: string };
         assert.equal(e.code, 3, "harness exits non-zero on entryEnsures throw");
diff --git a/tests/architecture/entry-ensures.test.ts b/tests/architecture/entry-ensures.test.ts
index e6a0eee..31170d0 100644
--- a/tests/architecture/entry-ensures.test.ts
+++ b/tests/architecture/entry-ensures.test.ts
@@ -40,11 +40,21 @@ async function fixturedPlugin(): Promise<string> {
 
 function spyEnsureDaemon() {
   let calls = 0;
-  const fn = async () => {
+  let lastOpts: Record<string, unknown> | undefined;
+  const fn = async (opts: Record<string, unknown>) => {
     calls += 1;
+    lastOpts = opts;
     return { port: 51999, hello: { daemonName: "agents-comm-bus" }, spawned: false };
   };
-  return { fn, get called() { return calls; } };
+  return {
+    fn,
+    get called() {
+      return calls;
+    },
+    get lastOpts() {
+      return lastOpts;
+    },
+  };
 }
 
 describe("entryEnsures — production mode", () => {
@@ -92,6 +102,79 @@ describe("entryEnsures — production mode", () => {
   });
 });
 
+describe("entryEnsures — canonical stateRoot derivation", () => {
+  it("uses AGENTS_COMM_BUS_ROOT when no explicit stateRoot, feeding it to both install and daemon", async () => {
+    const envRoot = await tempDir("acb-ee-envroot-");
+    const plugin = await fixturedPlugin();
+    const daemon = spyEnsureDaemon();
+
+    const result = await entryEnsures({
+      agent: "claude",
+      comm: "telegram",
+      pluginInstallDir: plugin,
+      // no explicit stateRoot — must derive from env
+      env: { AGENTS_COMM_BUS_ROOT: envRoot },
+      deps: { ensureDaemon: daemon.fn },
+    });
+
+    assert.equal(result.centralInstall.mode, "production");
+    assert.equal(daemon.lastOpts?.stateRoot, envRoot, "daemon got the env-derived canonical root");
+    const paths = resolveCentralPaths(envRoot, "telegram");
+    const { readFile } = await import("node:fs/promises");
+    assert.equal(await readFile(paths.daemonBundle, "utf8"), "DAEMON_BUNDLE_v1.0.0");
+  });
+
+  it("falls back to the daemon default root (injected) when neither stateRoot nor env root is set", async () => {
+    const defaultRoot = await tempDir("acb-ee-default-");
+    const plugin = await fixturedPlugin();
+    const daemon = spyEnsureDaemon();
+
+    const result = await entryEnsures({
+      agent: "claude",
+      comm: "telegram",
+      pluginInstallDir: plugin,
+      env: {}, // no explicit stateRoot, no env root -> daemon default
+      deps: {
+        ensureDaemon: daemon.fn,
+        resolveStatePaths: (() => ({ root: defaultRoot })) as never,
+      },
+    });
+
+    assert.equal(result.centralInstall.mode, "production");
+    assert.equal(daemon.lastOpts?.stateRoot, defaultRoot, "fell back to the injected default root");
+    const { access } = await import("node:fs/promises");
+    await access(resolveCentralPaths(defaultRoot, "telegram").daemonBundle); // throws if not installed
+  });
+
+  it("propagates a dev-marker stateRoot to the daemon ensure (source mode)", async () => {
+    const daemon = spyEnsureDaemon();
+    const projectRoot = await tempDir("acb-ee-mk-");
+    const binRel = "agents-comm-bus/dist/core-daemon/serve.js";
+    await mkdir(path.join(projectRoot, path.dirname(binRel)), { recursive: true });
+    await writeFile(path.join(projectRoot, binRel), "// daemon\n", "utf8");
+    await writeFile(
+      path.join(projectRoot, DEV_MARKER_NAME),
+      JSON.stringify({ daemonBin: binRel, stateRoot: ".acb-dev" }),
+      "utf8",
+    );
+
+    const result = await entryEnsures({
+      agent: "claude",
+      comm: "telegram",
+      projectRoot,
+      env: {}, // marker supplies AGENTS_COMM_BUS_BIN (source) + AGENTS_COMM_BUS_ROOT
+      deps: { ensureDaemon: daemon.fn },
+    });
+
+    assert.equal(result.centralInstall.mode, "source");
+    assert.equal(
+      daemon.lastOpts?.stateRoot,
+      path.join(projectRoot, ".acb-dev"),
+      "marker-resolved stateRoot reached the daemon ensure",
+    );
+  });
+});
+
 describe("resolveEntryContext", () => {
   it("finds projectRoot at the nearest ancestor holding the dev marker", async () => {
     const root = await tempDir("acb-ee-ctx-");
diff --git a/tests/architecture/fixtures/entry-ensures-harness.mjs b/tests/architecture/fixtures/entry-ensures-harness.mjs
index d9c180e..1272d0c 100644
--- a/tests/architecture/fixtures/entry-ensures-harness.mjs
+++ b/tests/architecture/fixtures/entry-ensures-harness.mjs
@@ -1,33 +1,38 @@
 /**
  * Subprocess harness for the entryEnsures real-installed-path proof.
  *
- * Invoked as: node entry-ensures-harness.mjs <fromDir> <stateRoot>
+ * Invoked as: node entry-ensures-harness.mjs <fromDir>
  *
- * Calls entryEnsures the way a wired hook does — fromDir resolves the plugin
- * install dir (and any dev marker) from the real filesystem, env is empty so we
- * exercise the strict PRODUCTION path, and ensureDaemon is stubbed (we are
- * proving the real central-install file effects, not spawning a daemon). On
- * success prints a JSON line; on failure prints to stderr and exits non-zero —
- * so the test can assert install-before-daemon and fail-before-daemon against
- * the real state root, not a mock.
+ * Calls entryEnsures exactly the way a wired hook does — fromDir resolves the
+ * plugin install dir (and any dev marker) from the real filesystem, and it
+ * passes process.env WITHOUT an explicit stateRoot (the real wired-hook shape;
+ * the test controls the state root via AGENTS_COMM_BUS_ROOT in the child env).
+ * The earlier harness passed stateRoot explicitly, which masked the production
+ * crash where entryEnsures must derive the canonical root itself. ensureDaemon
+ * is stubbed (we prove the real central-install file effects, not a daemon
+ * spawn) and records the stateRoot it was handed so the test can assert the
+ * daemon got the SAME canonical root as central install.
  */
 import { entryEnsures } from "../../../hosts/common/install/entry-ensures.js";
 
-const [, , fromDir, stateRoot] = process.argv;
+const [, , fromDir] = process.argv;
 
 try {
+  let daemonStateRoot;
   const result = await entryEnsures({
     fromDir,
     agent: "claude",
-    stateRoot,
-    env: {}, // no AGENTS_COMM_BUS_BIN -> strict production path
+    env: process.env, // realistic: hook passes process.env; no explicit stateRoot
     deps: {
-      ensureDaemon: async () => ({ port: 1, hello: { daemonName: "stub" }, spawned: false }),
+      ensureDaemon: async (opts) => {
+        daemonStateRoot = opts?.stateRoot;
+        return { port: 1, hello: { daemonName: "stub" }, spawned: false };
+      },
     },
     ensureDaemonOptions: {},
   });
   process.stdout.write(
-    JSON.stringify({ ok: true, mode: result.centralInstall?.mode, port: result.port }) + "\n",
+    JSON.stringify({ ok: true, mode: result.centralInstall?.mode, port: result.port, daemonStateRoot }) + "\n",
   );
 } catch (error) {
   process.stderr.write(`ENTRY_ENSURES_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);

````
