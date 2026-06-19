export type AgentId = "claude" | "codex";
export type ContentKind = "daemon" | "adapter";

export interface InstallActor {
  agent: AgentId;
  comm: string;
  pluginVersion: string;
  daemonBundleVersion: string;
  adapterBundleVersion: string;
  pluginInstallDir?: string;
  daemonSidecars?: string[];
  installedAt: string;
}

export interface ProvenanceEntry {
  agent: AgentId;
  comm: string;
  plugin_version: string;
  bundle_version: string;
  installed_at: string;
}

export interface VersionRecord {
  schema_version: number;
  content_version: string;
  content_kind: ContentKind;
  content_id?: string;
  content_source: ProvenanceEntry;
  installed_by: ProvenanceEntry[];
}

export interface CentralState {
  daemonExists: boolean;
  daemonVersionFile: VersionRecord | null;
  adapterExists: boolean;
  adapterVersionFile: VersionRecord | null;
  daemonRunning: boolean;
}

export interface ArtifactPlan {
  writeBundle: boolean;
  writeVersionFile: boolean;
  contentReplaced: boolean;
  resultingContentVersion: string;
  resultingVersionFile: VersionRecord;
  reasons: string[];
}

export interface ReconcilePlan {
  daemon: ArtifactPlan;
  adapter: ArtifactPlan;
  requiresSpawn: boolean;
  requiresDaemonRestart: boolean;
  requiresAdapterReload: boolean;
  reasons: string[];
}

export interface FsSeam {
  mkdirp: (dir: string) => Promise<void>;
  copyFile: (from: string, to: string) => Promise<void>;
  writeFile: (file: string, data: string) => Promise<void>;
  chmod?: (file: string, mode: number) => Promise<void>;
}

export interface CentralPaths {
  daemonBundle: string;
  daemonVersionFile: string;
  cliBundle: string;
  adapterBundle: string;
  adapterVersionFile: string;
}

export interface ExecutionResult {
  wroteBundles: string[];
  wroteVersionFiles: string[];
}

export const VERSION_FILE_SCHEMA = 1;

export function reconcileInstall(actor: InstallActor, state: CentralState): ReconcilePlan {
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

function reconcileArtifact(
  kind: ContentKind,
  actor: InstallActor,
  existing: VersionRecord | null,
  bundleExists: boolean,
  contentId: string | undefined,
): ArtifactPlan {
  const incomingVersion = kind === "daemon" ? actor.daemonBundleVersion : actor.adapterBundleVersion;
  const entry = makeEntry(actor, kind);

  if (!existing) {
    const record: VersionRecord = {
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
  const record: VersionRecord = { ...existing, installed_by: list };
  const reasons: string[] = [];
  let writeBundle = false;
  let contentReplaced = false;

  const cmp = compareVersions(incomingVersion, existing.content_version);
  if (cmp > 0) {
    writeBundle = true;
    contentReplaced = true;
    record.content_version = incomingVersion;
    record.content_source = entry;
    reasons.push(`upgrade ${kind}: incoming ${incomingVersion} > installed ${existing.content_version}`);
  } else if (cmp === 0) {
    reasons.push(`no content change: incoming ${kind} equals installed ${incomingVersion}`);
    if (!bundleExists) {
      writeBundle = true;
      reasons.push(`recovery: ${kind} blob missing on disk, rewriting at installed version`);
    }
  } else {
    reasons.push(`no downgrade: incoming ${kind} ${incomingVersion} < installed ${existing.content_version}`);
    if (!bundleExists) {
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

function upsertInstalledBy(
  list: ProvenanceEntry[],
  entry: ProvenanceEntry,
): { list: ProvenanceEntry[]; changed: boolean } {
  const idx = list.findIndex((e) => e.agent === entry.agent && e.comm === entry.comm);
  if (idx === -1) {
    return { list: [...list, entry], changed: true };
  }
  const prev = list[idx]!;
  if (prev.plugin_version === entry.plugin_version && prev.bundle_version === entry.bundle_version) {
    return { list, changed: false };
  }
  const next = list.slice();
  next[idx] = entry;
  return { list: next, changed: true };
}

function makeEntry(actor: InstallActor, kind: ContentKind): ProvenanceEntry {
  return {
    agent: actor.agent,
    comm: actor.comm,
    plugin_version: actor.pluginVersion,
    bundle_version: kind === "daemon" ? actor.daemonBundleVersion : actor.adapterBundleVersion,
    installed_at: actor.installedAt,
  };
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
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

function parseVersion(v: string): Array<number | string> {
  return String(v)
    .split("-")[0]!
    .split(".")
    .map((s) => {
      const num = Number(s);
      return Number.isInteger(num) ? num : s;
    });
}

export async function executeInstallPlan(
  plan: ReconcilePlan,
  actor: InstallActor,
  paths: CentralPaths,
  fs: FsSeam,
): Promise<ExecutionResult> {
  const daemonSrc = actor.pluginInstallDir ? `${actor.pluginInstallDir}/daemon.bundle.js` : null;
  const adapterSrc = actor.pluginInstallDir ? `${actor.pluginInstallDir}/${actor.comm}.adapter.bundle.js` : null;

  if (plan.daemon.writeBundle && !daemonSrc) {
    throw new Error("executeInstallPlan: daemon bundle write required but actor.pluginInstallDir is unset");
  }
  if (plan.adapter.writeBundle && !adapterSrc) {
    throw new Error("executeInstallPlan: adapter bundle write required but actor.pluginInstallDir is unset");
  }

  const wroteBundles: string[] = [];
  const wroteVersionFiles: string[] = [];

  if (plan.daemon.writeBundle) {
    const binDir = dirname(paths.daemonBundle);
    await fs.mkdirp(binDir);
    await fs.copyFile(daemonSrc!, paths.daemonBundle);
    wroteBundles.push(paths.daemonBundle);
    for (const name of actor.daemonSidecars ?? []) {
      await fs.copyFile(`${actor.pluginInstallDir}/${name}`, join(binDir, name));
    }
    await fs.writeFile(join(binDir, "package.json"), '{\n  "type": "module"\n}\n');
  }
  if (plan.daemon.writeVersionFile) {
    await fs.mkdirp(dirname(paths.daemonVersionFile));
    await fs.writeFile(paths.daemonVersionFile, serialize(plan.daemon.resultingVersionFile));
    wroteVersionFiles.push(paths.daemonVersionFile);
  }
  if (plan.adapter.writeBundle) {
    const adapterDir = dirname(paths.adapterBundle);
    await fs.mkdirp(adapterDir);
    await fs.copyFile(adapterSrc!, paths.adapterBundle);
    await fs.writeFile(join(adapterDir, "package.json"), '{\n  "type": "module"\n}\n');
    wroteBundles.push(paths.adapterBundle);
  }
  if (plan.adapter.writeVersionFile) {
    await fs.mkdirp(dirname(paths.adapterVersionFile));
    await fs.writeFile(paths.adapterVersionFile, serialize(plan.adapter.resultingVersionFile));
    wroteVersionFiles.push(paths.adapterVersionFile);
  }

  return { wroteBundles, wroteVersionFiles };
}

function serialize(record: VersionRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

const CLI_LAUNCHER_NAMES = ["agents-comm", "agents-comm-bus"];

export async function installCliLaunchers(paths: CentralPaths, cliSrc: string, fs: FsSeam): Promise<void> {
  const binDir = dirname(paths.cliBundle);
  await fs.mkdirp(binDir);
  await fs.copyFile(cliSrc, paths.cliBundle);
  for (const name of CLI_LAUNCHER_NAMES) {
    await fs.writeFile(join(binDir, `${name}.cmd`), `@echo off\r\nnode "%~dp0cli.js" %*\r\n`);
    const posix = join(binDir, name);
    await fs.writeFile(posix, `#!/bin/sh\nexec node "$(dirname "$0")/cli.js" "$@"\n`);
    await fs.chmod?.(posix, 0o755);
  }
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? "." : p.slice(0, i);
}

function join(dir: string, name: string): string {
  return `${dir}/${name}`;
}
