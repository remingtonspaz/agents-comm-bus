/**
 * Central-install reconciliation seam (host-edge, agent-agnostic).
 *
 * This is the shared library boundary the per-agent install hooks delegate to.
 * It mirrors the dependency-injection discipline of
 * `core-daemon/bootstrap/ensure-daemon.ts`: a PURE decision function
 * (`reconcileInstall`) that takes the installing plugin's identity + the
 * current on-disk central-install state and returns a *plan*, kept separate
 * from `executeInstallPlan`, which performs the actual filesystem effects
 * against an injected `fs` seam. That split is what makes the four-layer test
 * model cheap:
 *   - T1: drive `reconcileInstall` with plain objects (this file; no I/O).
 *   - T2: drive `executeInstallPlan` against a temp state root.
 *   - T3: race many reconcile+execute pairs against one temp root.
 *   - T4: run the real install hook in a subprocess against temp HOME.
 *
 * Versioning invariant (see install-model.md "Version metadata policy"):
 * the replace decision for a shared blob keys on that blob's OWN version
 * (`daemonBundleVersion` / `adapterBundleVersion`), NEVER on `pluginVersion`.
 * `pluginVersion` is provenance only. This prevents an adapter-side plugin
 * hotfix (higher plugin_version) that re-bundles an OLDER daemon from silently
 * downgrading a newer installed daemon.
 *
 * Reference counting: a single `bin/daemon.js` is shared across every comm
 * plugin of every agent. The reference unit is therefore `(agent, comm)`, not
 * `agent` alone — claude-telegram and claude-matrix are two independent
 * references to the same daemon blob. `installed_by` entries are keyed on
 * `(agent, comm)` so uninstalling one comm plugin doesn't drop the daemon's
 * reference held by another comm plugin of the same agent.
 *
 * @typedef {"claude" | "codex"} AgentId
 * @typedef {"daemon" | "adapter"} ContentKind
 *
 * @typedef {Object} InstallActor
 * @property {AgentId} agent
 * @property {string} comm                  e.g. "telegram"
 * @property {string} pluginVersion         provenance only — NOT a replace key
 * @property {string} daemonBundleVersion   replace key for bin/daemon.js
 * @property {string} adapterBundleVersion  replace key for adapters/<comm>.js
 * @property {string} [pluginInstallDir]    source dir for bundle bytes (used by execute)
 * @property {string[]} [daemonSidecars]    basenames copied next to bin/daemon.js (e.g. migration *.sql); execute-only, ignored by reconcile
 * @property {string} installedAt           ISO timestamp, injected (keeps reconcile pure)
 *
 * @typedef {Object} ProvenanceEntry
 * @property {AgentId} agent
 * @property {string} comm
 * @property {string} plugin_version
 * @property {string} bundle_version
 * @property {string} installed_at
 *
 * @typedef {Object} VersionRecord   the parsed content of a *.version.json file
 * @property {number} schema_version
 * @property {string} content_version   the installed blob's own version (highest-wins key)
 * @property {ContentKind} content_kind
 * @property {string} [content_id]      <comm> for adapters; absent for the daemon
 * @property {ProvenanceEntry} content_source   which plugin laid down the current blob
 * @property {ProvenanceEntry[]} installed_by   reference set, keyed by (agent, comm)
 *
 * @typedef {Object} CentralState
 * @property {boolean} daemonExists                bin/daemon.js present on disk
 * @property {VersionRecord | null} daemonVersionFile
 * @property {boolean} adapterExists               adapters/<actor.comm>.js present on disk
 * @property {VersionRecord | null} adapterVersionFile
 * @property {boolean} daemonRunning               a live daemon answered discovery
 *
 * @typedef {Object} ArtifactPlan
 * @property {boolean} writeBundle          copy the plugin's bundle into the central path
 * @property {boolean} writeVersionFile     (re)write the *.version.json metadata
 * @property {boolean} contentReplaced      the installed blob version changed
 * @property {string} resultingContentVersion
 * @property {VersionRecord} resultingVersionFile   metadata to persist (merged provenance)
 * @property {string[]} reasons
 *
 * @typedef {Object} ReconcilePlan
 * @property {ArtifactPlan} daemon
 * @property {ArtifactPlan} adapter
 * @property {boolean} requiresSpawn            no live daemon — caller must spawn
 * @property {boolean} requiresDaemonRestart    daemon blob changed under a live daemon
 * @property {boolean} requiresAdapterReload    adapter blob added/changed under a live daemon
 * @property {string[]} reasons
 */

export const VERSION_FILE_SCHEMA = 1;

/**
 * Pure decision function. No I/O. Deterministic given its inputs (timestamps
 * are supplied via `actor.installedAt`, never read from the clock here).
 *
 * @param {InstallActor} actor
 * @param {CentralState} state
 * @returns {ReconcilePlan}
 */
export function reconcileInstall(actor, state) {
  const daemon = reconcileArtifact("daemon", actor, state.daemonVersionFile, state.daemonExists, undefined);
  const adapter = reconcileArtifact("adapter", actor, state.adapterVersionFile, state.adapterExists, actor.comm);

  const requiresSpawn = !state.daemonRunning;
  const requiresDaemonRestart = state.daemonRunning && daemon.contentReplaced;
  const requiresAdapterReload = state.daemonRunning && adapter.contentReplaced;

  return {
    daemon,
    adapter,
    requiresSpawn,
    requiresDaemonRestart,
    requiresAdapterReload,
    reasons: [...daemon.reasons, ...adapter.reasons],
  };
}

/**
 * @param {ContentKind} kind
 * @param {InstallActor} actor
 * @param {VersionRecord | null} existing
 * @param {boolean} bundleExists
 * @param {string | undefined} contentId
 * @returns {ArtifactPlan}
 */
function reconcileArtifact(kind, actor, existing, bundleExists, contentId) {
  const incomingVersion = kind === "daemon" ? actor.daemonBundleVersion : actor.adapterBundleVersion;
  const entry = makeEntry(actor, kind);

  // Cold: nothing recorded yet for this artifact.
  if (!existing) {
    /** @type {VersionRecord} */
    const record = {
      schema_version: VERSION_FILE_SCHEMA,
      content_version: incomingVersion,
      content_kind: kind,
      ...(contentId ? { content_id: contentId } : {}),
      content_source: entry,
      installed_by: [entry],
    };
    return {
      writeBundle: true,
      writeVersionFile: true,
      contentReplaced: true,
      resultingContentVersion: incomingVersion,
      resultingVersionFile: record,
      reasons: [`cold install: no existing ${kind}`],
    };
  }

  const { list, changed } = upsertInstalledBy(existing.installed_by, entry);
  /** @type {VersionRecord} */
  const record = { ...existing, installed_by: list };
  const reasons = [];
  let writeBundle = false;
  let contentReplaced = false;

  const cmp = compareVersions(incomingVersion, existing.content_version);
  if (cmp > 0) {
    // Genuine upgrade — incoming blob is newer than what's installed.
    writeBundle = true;
    contentReplaced = true;
    record.content_version = incomingVersion;
    record.content_source = entry;
    reasons.push(`upgrade ${kind}: incoming ${incomingVersion} > installed ${existing.content_version}`);
  } else if (cmp === 0) {
    reasons.push(`no content change: incoming ${kind} equals installed ${incomingVersion}`);
    if (!bundleExists) {
      // Metadata says this version is installed but the blob is gone — restore it.
      writeBundle = true;
      reasons.push(`recovery: ${kind} blob missing on disk, rewriting at installed version`);
    }
  } else {
    // Older incoming blob. THE REGRESSION GUARD: this branch is reached even
    // when actor.pluginVersion > content_source.plugin_version, because the
    // comparison keys on the blob version, not the plugin version.
    reasons.push(`no downgrade: incoming ${kind} ${incomingVersion} < installed ${existing.content_version}`);
    if (!bundleExists) {
      // Recorded-newer blob is missing and we only carry an older one. Restore
      // the older blob rather than leave the artifact unusable — an explicit,
      // logged downgrade-on-recovery, distinct from a normal install path.
      writeBundle = true;
      contentReplaced = true;
      record.content_version = incomingVersion;
      record.content_source = entry;
      reasons.push(`recovery: ${kind} blob missing and only older bundle available; restoring at ${incomingVersion}`);
    }
  }

  return {
    writeBundle,
    writeVersionFile: changed || contentReplaced,
    contentReplaced,
    resultingContentVersion: record.content_version,
    resultingVersionFile: record,
    reasons,
  };
}

/**
 * Upsert a provenance entry keyed on (agent, comm). Returns the new list and
 * whether anything meaningful changed. An entry whose (plugin_version,
 * bundle_version) is unchanged is a no-op (its installed_at is preserved) so a
 * re-run of the same install is idempotent and does not churn the file.
 *
 * @param {ProvenanceEntry[]} list
 * @param {ProvenanceEntry} entry
 * @returns {{ list: ProvenanceEntry[], changed: boolean }}
 */
function upsertInstalledBy(list, entry) {
  const idx = list.findIndex((e) => e.agent === entry.agent && e.comm === entry.comm);
  if (idx === -1) {
    return { list: [...list, entry], changed: true };
  }
  const prev = list[idx];
  if (prev.plugin_version === entry.plugin_version && prev.bundle_version === entry.bundle_version) {
    return { list, changed: false };
  }
  const next = list.slice();
  next[idx] = entry;
  return { list: next, changed: true };
}

/**
 * @param {InstallActor} actor
 * @param {ContentKind} kind
 * @returns {ProvenanceEntry}
 */
function makeEntry(actor, kind) {
  return {
    agent: actor.agent,
    comm: actor.comm,
    plugin_version: actor.pluginVersion,
    bundle_version: kind === "daemon" ? actor.daemonBundleVersion : actor.adapterBundleVersion,
    installed_at: actor.installedAt,
  };
}

/**
 * Release-version comparison ("semver-ish"). Compares dotted numeric
 * components; prerelease suffixes (after `-`) are stripped — full prerelease
 * ordering is out of scope for v1. Non-numeric components fall back to string
 * comparison per component.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const xs = String(x);
      const ys = String(y);
      if (xs !== ys) return xs < ys ? -1 : 1;
    }
  }
  return 0;
}

/**
 * @param {string} v
 * @returns {Array<number | string>}
 */
function parseVersion(v) {
  return String(v)
    .split("-")[0]
    .split(".")
    .map((s) => {
      const num = Number(s);
      return Number.isInteger(num) ? num : s;
    });
}

/**
 * Minimal filesystem seam used by `executeInstallPlan`. Injectable so tests
 * can drive execution against a temp root (T2) or a fake (T3) without touching
 * the real `~/.agents-comm-bus/`.
 *
 * @typedef {Object} FsSeam
 * @property {(dir: string) => Promise<void>} mkdirp
 * @property {(from: string, to: string) => Promise<void>} copyFile
 * @property {(file: string, data: string) => Promise<void>} writeFile
 *
 * @typedef {Object} CentralPaths
 * @property {string} daemonBundle        target path for bin/daemon.js
 * @property {string} daemonVersionFile   target path for bin/version.json
 * @property {string} adapterBundle       target path for adapters/<comm>.js
 * @property {string} adapterVersionFile  target path for adapters/<comm>.version.json
 *
 * @typedef {Object} ExecutionResult
 * @property {string[]} wroteBundles
 * @property {string[]} wroteVersionFiles
 */

/**
 * Reference executor for the plan. Kept intentionally thin: it only performs
 * the writes the plan asked for. Spawn / restart / reload are the caller's
 * responsibility (they depend on the runtime daemon connection, not the fs).
 *
 * @param {ReconcilePlan} plan
 * @param {InstallActor} actor
 * @param {CentralPaths} paths
 * @param {FsSeam} fs
 * @returns {Promise<ExecutionResult>}
 */
export async function executeInstallPlan(plan, actor, paths, fs) {
  const daemonSrc = actor.pluginInstallDir ? `${actor.pluginInstallDir}/daemon.bundle.js` : null;
  const adapterSrc = actor.pluginInstallDir
    ? `${actor.pluginInstallDir}/${actor.comm}.adapter.bundle.js`
    : null;

  // Fail hard BEFORE any write. A `writeBundle` with no source path would
  // otherwise silently skip the copy yet still write the version file —
  // manufacturing a partial-install state where the metadata claims a blob
  // that was never laid down. Validate up front so a rejected plan writes
  // nothing at all.
  if (plan.daemon.writeBundle && !daemonSrc) {
    throw new Error(
      "executeInstallPlan: daemon bundle write required but actor.pluginInstallDir is unset",
    );
  }
  if (plan.adapter.writeBundle && !adapterSrc) {
    throw new Error(
      "executeInstallPlan: adapter bundle write required but actor.pluginInstallDir is unset",
    );
  }

  const wroteBundles = [];
  const wroteVersionFiles = [];

  if (plan.daemon.writeBundle) {
    const binDir = dirname(paths.daemonBundle);
    await fs.mkdirp(binDir);
    await fs.copyFile(/** @type {string} */ (daemonSrc), paths.daemonBundle);
    wroteBundles.push(paths.daemonBundle);
    // Copy the daemon's schema sidecars (migration *.sql) next to the bundle.
    // The migration runner reads schema relative to its own module dir, which —
    // for the copied single-file bundle — is bin/. Without these the daemon
    // loads but cannot migrate the DB.
    for (const name of actor.daemonSidecars ?? []) {
      await fs.copyFile(`${actor.pluginInstallDir}/${name}`, join(binDir, name));
    }
    // node resolves a bare ".js" module's type from the nearest package.json;
    // bin/ has none, so the ESM daemon bundle would be parsed as CommonJS and
    // crash on its first `import`. Pin ESM for everything under bin/.
    await fs.writeFile(join(binDir, "package.json"), '{\n  "type": "module"\n}\n');
  }
  if (plan.daemon.writeVersionFile) {
    await fs.mkdirp(dirname(paths.daemonVersionFile));
    await fs.writeFile(paths.daemonVersionFile, serialize(plan.daemon.resultingVersionFile));
    wroteVersionFiles.push(paths.daemonVersionFile);
  }
  if (plan.adapter.writeBundle) {
    await fs.mkdirp(dirname(paths.adapterBundle));
    await fs.copyFile(/** @type {string} */ (adapterSrc), paths.adapterBundle);
    wroteBundles.push(paths.adapterBundle);
  }
  if (plan.adapter.writeVersionFile) {
    await fs.mkdirp(dirname(paths.adapterVersionFile));
    await fs.writeFile(paths.adapterVersionFile, serialize(plan.adapter.resultingVersionFile));
    wroteVersionFiles.push(paths.adapterVersionFile);
  }

  return { wroteBundles, wroteVersionFiles };
}

/** @param {VersionRecord} record */
function serialize(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** @param {string} p */
function dirname(p) {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? "." : p.slice(0, i);
}

/** Join a dir and a basename with a forward slash (node fs accepts mixed seps on Windows). @param {string} dir @param {string} name */
function join(dir, name) {
  return `${dir}/${name}`;
}
