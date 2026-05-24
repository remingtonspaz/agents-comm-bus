#!/usr/bin/env node
/**
 * Codex SessionStart hook.
 *
 * Codex currently fires SessionStart at first-prompt time, not before the TUI
 * is ready. Treat this as a repair hook: if this project has a Codex comm
 * registration but the process was not launched with a comm-bus app-server,
 * schedule a same-terminal bootstrap restart and return fail-open.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ensureDaemon } from '../../../agents-comm-bus/dist/core-daemon/bootstrap/ensure-daemon.js';
import { connectIpc } from '../../../agents-comm-bus/dist/core-daemon/ipc/client.js';

const CLIENT_VERSION = 'codex-session-start-bootstrap';
const RESTART_GUARD_MS = 60_000;
const HOOK_TIMEOUT_MS = 8_000;
const APP_SERVER_PROBE_MS = 350;

const watchdog = setTimeout(() => {
  process.stderr.write('Codex SessionStart bootstrap hook timed out; continuing without restart\n');
  process.exit(0);
}, HOOK_TIMEOUT_MS);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const bootstrapperPath = path.join(repoRoot, 'scripts', 'bootstrap-codex-session.ps1');

function stableSessionId(hookInput) {
  if (process.env.AGENTS_COMM_BUS_SESSION_ID) {
    return process.env.AGENTS_COMM_BUS_SESSION_ID;
  }
  const raw = codexThreadId(hookInput) || `${process.cwd()}:${process.env.CODEX_APP_SERVER_URL || ''}`;
  return `codex_${crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 24)}`;
}

function codexThreadId(hookInput) {
  return (
    hookInput?.thread_id ||
    hookInput?.threadId ||
    hookInput?.session_id ||
    hookInput?.sessionId ||
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_SESSION_ID ||
    ''
  );
}

async function readStdinJson() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

async function openDaemonConnection(metadata) {
  const daemon = await ensureDaemon({ clientVersion: CLIENT_VERSION, metadata });
  return connectIpc({
    port: daemon.port,
    clientVersion: CLIENT_VERSION,
    metadata,
    timeoutMs: 2_000,
  });
}

function withTimeout(promise, label, timeoutMs = 3_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function appServerEndpoint(urlValue) {
  if (!urlValue) return null;
  try {
    const url = new URL(urlValue);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
    return { host: url.hostname || '127.0.0.1', port };
  } catch {
    return null;
  }
}

function canReachAppServer(urlValue) {
  const endpoint = appServerEndpoint(urlValue);
  if (!endpoint) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(APP_SERVER_PROBE_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function closeIpc(ipc) {
  if (!ipc) return;
  try {
    ipc.close();
  } catch {
    // Ignore close failures in a fail-open hook.
  }
  try {
    ipc.socket?.terminate?.();
  } catch {
    // Ignore close failures in a fail-open hook.
  }
}

function stateRoot() {
  return path.join(os.homedir(), '.agents-comm-bus', 'codex-bootstrapper');
}

function guardPath(project, session) {
  const hash = crypto
    .createHash('sha256')
    .update(`${project}:${session}`)
    .digest('hex')
    .slice(0, 24);
  return path.join(stateRoot(), 'session-start', `${hash}.json`);
}

function recentRestartAlreadyScheduled(project, session) {
  const file = guardPath(project, session);
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof marker.scheduled_at === 'number' &&
      Date.now() - marker.scheduled_at < RESTART_GUARD_MS;
  } catch {
    return false;
  }
}

function writeRestartMarker(project, session, status) {
  const file = guardPath(project, session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    project,
    session,
    scheduled_at: Date.now(),
    status,
  }, null, 2));
}

function scheduleBootstrapRestart(threadId) {
  if (process.platform !== 'win32') {
    throw new Error('Codex bootstrap restart hook currently supports Windows PowerShell only');
  }
  if (!fs.existsSync(bootstrapperPath)) {
    throw new Error(`Codex bootstrapper not found at ${bootstrapperPath}`);
  }

  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    bootstrapperPath,
    '-RestartCurrent',
    '-SameTerminal',
    '-Exec',
  ];
  if (threadId) {
    args.push('-ThreadId', String(threadId));
  }

  const result = spawnSync('powershell.exe', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(`bootstrapper exited ${result.status}: ${stderr || stdout || 'no output'}`);
  }

  return {
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

async function main() {
  const hookInput = await readStdinJson();
  const threadId = codexThreadId(hookInput);
  const session = stableSessionId(hookInput);
  const project = process.cwd();
  const metadata = {
    shimName: 'hosts/codex/hooks/session-start.js',
    agent: 'codex',
    project,
    hookEventName: 'SessionStart',
    session,
  };

  let ipc;
  try {
    ipc = await withTimeout(openDaemonConnection(metadata), 'daemon connection');
    const appServerReachable = await canReachAppServer(process.env.CODEX_APP_SERVER_URL);
    const status = await withTimeout(ipc.request('codex_bootstrap_status', {
      agent: 'codex',
      session,
      project,
      cwd: project,
      app_server_url: process.env.CODEX_APP_SERVER_URL,
      app_server_reachable: appServerReachable,
      managed_session_id: process.env.AGENTS_COMM_BUS_SESSION_ID,
      hook: 'SessionStart',
      codex: hookInput,
    }), 'codex_bootstrap_status');

    if (!status?.bootstrap_required) {
      return;
    }
    if (recentRestartAlreadyScheduled(project, session)) {
      process.stderr.write(
        `Codex SessionStart bootstrap skipped: restart already scheduled recently for ${session}\n`,
      );
      return;
    }

    writeRestartMarker(project, session, status);
    const scheduled = scheduleBootstrapRestart(threadId);
    process.stderr.write(
      `Codex SessionStart scheduled comm-bus bootstrap restart for ${session}\n`,
    );
    if (scheduled.stdout) {
      process.stderr.write(`${scheduled.stdout}\n`);
    }
  } catch (error) {
    process.stderr.write(`Codex SessionStart bootstrap hook skipped: ${error.message}\n`);
  } finally {
    closeIpc(ipc);
    clearTimeout(watchdog);
  }
}

main().then(() => {
  process.exit(0);
}).catch((error) => {
  process.stderr.write(`Codex SessionStart hook error: ${error.message}\n`);
  process.exit(0);
});
