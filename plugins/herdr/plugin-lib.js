import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEV_MARKER_NAME } from '../../agents-comm-bus/dist/core-daemon/host-runtime/dev-config-resolver.js';
import { stripBom } from '../../agents-comm-bus/dist/core-daemon/host-runtime/strip-bom.js';

const SUPPORTED_AGENTS = ['claude', 'codex'];
const CENTRAL_CLI = path.join(os.homedir(), '.agents-comm-bus', 'bin', 'cli.js');
const CHECKOUT_CLI_REL = path.join('agents-comm-bus', 'dist', 'core-daemon', 'cli', 'index.js');

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
    return { checkoutRoot, daemonBin };
  } catch {
    return null;
  }
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

export function identityFromPaneEnv(agent, env = process.env) {
  const pane_id = env.HERDR_PANE_ID;
  const socket_path = env.HERDR_SOCKET_PATH;
  if (typeof pane_id !== 'string' || !pane_id.trim()) return null;
  if (typeof socket_path !== 'string' || !socket_path.trim()) return null;
  const identity = {
    type: 'herdr',
    agent,
    pane_id: pane_id.trim(),
    socket_path: socket_path.trim(),
  };
  if (typeof env.HERDR_WORKSPACE_ID === 'string' && env.HERDR_WORKSPACE_ID.trim()) {
    identity.workspace_id = env.HERDR_WORKSPACE_ID.trim();
  }
  if (typeof env.HERDR_TAB_ID === 'string' && env.HERDR_TAB_ID.trim()) {
    identity.tab_id = env.HERDR_TAB_ID.trim();
  }
  if (typeof env.HERDR_BIN_PATH === 'string' && env.HERDR_BIN_PATH.trim()) {
    identity.bin_path = env.HERDR_BIN_PATH.trim();
  }
  return identity;
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

export function projectFromCwd(cwd) {
  return path.resolve(cwd || process.cwd());
}

export { SUPPORTED_AGENTS, CENTRAL_CLI, CHECKOUT_CLI_REL };
