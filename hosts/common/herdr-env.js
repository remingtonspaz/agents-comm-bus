import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { herdrSessionId } from '../../agents-comm-bus/dist/core-daemon/runtime/herdr.js';
import { DEV_MARKER_NAME } from '../../agents-comm-bus/dist/core-daemon/host-runtime/dev-config-resolver.js';
import { stripBom } from '../../agents-comm-bus/dist/core-daemon/host-runtime/strip-bom.js';

const SUPPORTED_AGENTS = new Set(['claude', 'codex', 'pi']);

function newestHerdrStandaloneBinary(homeDir = os.homedir()) {
  const releasesRoot = path.join(homeDir, '.herdr', 'packages', 'standalone', 'releases');
  try {
    const entries = fs.readdirSync(releasesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const dir = path.join(releasesRoot, entries[i]);
      const exe = process.platform === 'win32'
        ? path.join(dir, 'herdr.exe')
        : path.join(dir, 'herdr');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    // no standalone install
  }
  return null;
}

function resolveHerdrBinPath(env = process.env) {
  if (typeof env.HERDR_BIN_PATH === 'string' && env.HERDR_BIN_PATH.trim()) {
    return env.HERDR_BIN_PATH.trim();
  }
  return newestHerdrStandaloneBinary() ?? undefined;
}

/**
 * @param {string} agent
 * @param {Record<string, string | undefined>} [env]
 */
export function herdrIdentityFromEnv(agent, env = process.env) {
  if (!SUPPORTED_AGENTS.has(agent)) return null;
  if (env.HERDR_ENV !== '1') return null;
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
  const bin_path = resolveHerdrBinPath(env);
  if (bin_path) identity.bin_path = bin_path;
  return identity;
}

export function herdrSessionIdFromEnv(agent, env = process.env) {
  const identity = herdrIdentityFromEnv(agent, env);
  return identity ? herdrSessionId(identity) : null;
}

/**
 * @param {string} projectDir
 * @param {{ exists?: (p: string) => boolean, readFile?: (p: string) => string }} [deps]
 */
export function wakeStrictFromDevMarker(projectDir, deps = {}) {
  const exists = deps.exists ?? fs.existsSync;
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, 'utf8'));
  const markerPath = path.join(projectDir, DEV_MARKER_NAME);
  if (!exists(markerPath)) return null;
  try {
    const parsed = JSON.parse(stripBom(readFile(markerPath)));
    if (!parsed || typeof parsed !== 'object') return null;
    const wakeStrict = parsed.wakeStrict;
    return wakeStrict === 'herdr' ? 'herdr' : null;
  } catch {
    return null;
  }
}

export function herdrWakeFieldsForRegister(agent, projectDir, env = process.env) {
  const identity = herdrIdentityFromEnv(agent, env);
  if (!identity) return {};
  const wake_strict = wakeStrictFromDevMarker(projectDir, {
    exists: (p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    },
  });
  return {
    herdr_identity: identity,
    ...(wake_strict ? { wake_strict } : {}),
  };
}
