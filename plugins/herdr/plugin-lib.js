import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEV_MARKER_NAME = '.agents-comm-bus-dev.json';
export const SUPPORTED_AGENTS = ['claude', 'codex', 'pi'];
export const CENTRAL_CLI = path.join(os.homedir(), '.agents-comm-bus', 'bin', 'cli.js');
export const CHECKOUT_CLI_REL = path.join('agents-comm-bus', 'dist', 'core-daemon', 'cli', 'index.js');

export function stripBom(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function findGitRoot(startDir) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    if (current === root) return null;
    current = path.dirname(current);
  }
}

function readDevMarker(checkoutRoot, deps = {}) {
  const exists = deps.exists ?? fs.existsSync;
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const markerPath = path.join(checkoutRoot, DEV_MARKER_NAME);
  if (!exists(markerPath)) return null;
  try {
    const parsed = JSON.parse(stripBom(readFile(markerPath)));
    if (!parsed || typeof parsed !== 'object') return null;
    const daemonBinRaw = typeof parsed.daemonBin === 'string' ? parsed.daemonBin : null;
    if (!daemonBinRaw) return null;
    const daemonBin = path.resolve(checkoutRoot, daemonBinRaw);
    if (!daemonBin.startsWith(path.resolve(checkoutRoot))) return null;
    return { checkoutRoot, daemonBin, wakeStrict: parsed.wakeStrict === 'herdr' ? 'herdr' : null };
  } catch {
    return null;
  }
}

export function wakeStrictForProject(projectCwd, deps = {}) {
  const gitRoot = findGitRoot(projectCwd);
  if (!gitRoot) return null;

  let current = path.resolve(projectCwd);
  const stop = path.resolve(gitRoot);
  while (true) {
    const marker = readDevMarker(current, deps);
    if (marker?.wakeStrict === 'herdr') return 'herdr';
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Walk from cwd up to git root for a dev checkout CLI entry.
 */
export function resolveCliEntry(projectCwd, deps = {}) {
  const exists = deps.exists ?? fs.existsSync;
  const gitRoot = findGitRoot(projectCwd);
  if (!gitRoot) {
    return { entry: CENTRAL_CLI, source: 'central' };
  }

  let current = path.resolve(projectCwd);
  const stop = path.resolve(gitRoot);
  while (true) {
    const marker = readDevMarker(current, deps);
    if (marker) {
      const checkoutCli = path.join(current, CHECKOUT_CLI_REL);
      if (exists(checkoutCli)) {
        return { entry: checkoutCli, source: 'dev-checkout', checkoutRoot: current };
      }
    }
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { entry: CENTRAL_CLI, source: 'central' };
}

export function parsePluginEventJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function extractAgentKind(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return null;
  const candidate = value.agent ?? value.kind ?? value.type;
  if (typeof candidate === 'string') return candidate;
  if (candidate && typeof candidate === 'object') {
    const nested = candidate.agent ?? candidate.kind;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

export function agentKindFromListEntry(entry) {
  return extractAgentKind(entry?.agent) ?? extractAgentKind(entry?.kind) ?? null;
}

export function agentKindFromGetResult(result) {
  const agent = result?.result?.agent ?? result?.agent;
  return extractAgentKind(agent);
}

export function cwdFromAgentGetResult(result) {
  const cwd = result?.result?.agent?.cwd ?? result?.agent?.cwd;
  return typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd.trim()) : null;
}

export function cwdFromListEntry(entry) {
  const cwd = entry?.cwd;
  return typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd.trim()) : null;
}

export function cwdFromEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const cwd = event.cwd ?? event.pane?.cwd;
  if (typeof cwd === 'string' && cwd.trim()) return path.resolve(cwd.trim());
  const agentObj = event.agent;
  if (agentObj && typeof agentObj === 'object' && typeof agentObj.cwd === 'string' && agentObj.cwd.trim()) {
    return path.resolve(agentObj.cwd.trim());
  }
  return null;
}

/**
 * Build sync identity for an agent pane (never uses HERDR_PANE_ID from env for pane_id).
 */
export function buildSyncIdentity(agent, paneId, env = process.env, sourceEntry = {}) {
  const socket_path = env.HERDR_SOCKET_PATH;
  if (typeof paneId !== 'string' || !paneId.trim()) return null;
  if (typeof socket_path !== 'string' || !socket_path.trim()) return null;

  const identity = {
    type: 'herdr',
    agent,
    pane_id: paneId.trim(),
    socket_path: socket_path.trim(),
  };

  const workspace =
    sourceEntry.workspace_id ??
    sourceEntry.workspaceId ??
    (typeof env.HERDR_WORKSPACE_ID === 'string' ? env.HERDR_WORKSPACE_ID : undefined);
  if (typeof workspace === 'string' && workspace.trim()) identity.workspace_id = workspace.trim();

  const tab =
    sourceEntry.tab_id ??
    sourceEntry.tabId ??
    (typeof env.HERDR_TAB_ID === 'string' ? env.HERDR_TAB_ID : undefined);
  if (typeof tab === 'string' && tab.trim()) identity.tab_id = tab.trim();

  const bin =
    (typeof env.HERDR_BIN_PATH === 'string' && env.HERDR_BIN_PATH.trim())
      ? env.HERDR_BIN_PATH.trim()
      : undefined;
  if (bin) identity.bin_path = bin;

  return identity;
}

export async function resolveProjectForPane({ listEntry, event, paneId, agentGet }, deps = {}) {
  const fromList = listEntry ? cwdFromListEntry(listEntry) : null;
  if (fromList) return fromList;

  const fromEvent = event ? cwdFromEvent(event) : null;
  if (fromEvent) return fromEvent;

  if (paneId && agentGet) {
    try {
      const got = await agentGet(paneId);
      const fromGet = cwdFromAgentGetResult(got);
      if (fromGet) return fromGet;
    } catch {
      return null;
    }
  }
  return null;
}

export function appendPluginLog(stateDir, record, deps = {}) {
  const appendFile = deps.appendFile ?? fs.appendFileSync;
  if (!stateDir) return;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    appendFile(path.join(stateDir, 'plugin.log'), `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // best-effort
  }
}

export async function execFileAsync(execFile, file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
