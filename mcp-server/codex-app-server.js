// Minimal client for the Codex local app-server JSON-RPC interface.
//
// Codex's interactive sessions (CLI and desktop) listen on a Unix-domain
// socket at $CODEX_HOME/app-server-control/app-server-control.sock. The
// transport is WebSocket-over-UDS (RFC 6455 over an AF_UNIX socket). On
// top of that, the messages are JSON-RPC 2.0.
//
// We use this to wake an idle Codex thread when a Telegram message
// arrives — equivalent to the "auto-enter" PostMessage WM_CHAR trick the
// Claude Code version uses, but routed through Codex's own protocol so
// no console focus or keystroke injection is needed.

import WebSocket from 'ws';
import http from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

function getControlSocketPath() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'app-server-control', 'app-server-control.sock');
}

// Send one JSON-RPC request over the control socket and resolve with the
// response. Closes the connection after the reply (or timeout) — this is
// not meant for high-frequency or streaming use.
function callOnce(method, params, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const socketPath = getControlSocketPath();
    if (!fs.existsSync(socketPath)) {
      reject(new Error(`app-server control socket not found at ${socketPath}`));
      return;
    }

    const agent = new http.Agent({ socketPath });
    const ws = new WebSocket('ws://localhost/', { agent });
    const id = Math.floor(Math.random() * 1e9);
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(`app-server JSON-RPC timeout after ${timeoutMs}ms (method=${method})`));
    }, timeoutMs);

    ws.on('open', () => {
      const req = { jsonrpc: '2.0', id, method, params };
      ws.send(JSON.stringify(req));
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf-8'));
      } catch (e) {
        return; // Ignore unparseable frames
      }
      if (msg.id !== id) return;
      clearTimeout(timer);
      if (msg.error) {
        finish(new Error(`app-server JSON-RPC error ${msg.error.code}: ${msg.error.message || ''}`));
      } else {
        finish(null, msg.result);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (!settled) finish(new Error('app-server connection closed before reply'));
    });
  });
}

export async function listLoadedThreads() {
  return callOnce('thread/loaded/list', {});
}

export async function startTurn(threadId, text) {
  return callOnce('turn/start', {
    threadId,
    input: [{ type: 'text', text }],
  });
}

// Best-effort wake: pick the most recently active loaded thread and call
// turn/start with a tiny placeholder. The placeholder fires the
// UserPromptSubmit hook, which injects the queued Telegram messages as
// additionalContext. Returns true on success, false on any failure.
//
// Failures are silent by design — there might be no Codex session
// running, the socket might not exist yet, the thread might already be
// mid-turn. In all those cases we just leave the message in the queue
// for the next prompt to pick up.
export async function wakeMostRecentThread(placeholderText = '.') {
  let result;
  try {
    result = await listLoadedThreads();
  } catch {
    return false;
  }

  // The exact response shape isn't fully documented; handle common variants.
  // Expect something like { threads: [{ threadId, lastActiveAt, ... }] }.
  const threads =
    (result && (result.threads || result.items || result.loaded)) ||
    (Array.isArray(result) ? result : []);
  if (!Array.isArray(threads) || threads.length === 0) return false;

  // Pick the most recently active thread by lastActiveAt / updatedAt /
  // startedAt timestamp, falling back to the first one.
  const sorted = [...threads].sort((a, b) => {
    const ta = Date.parse(a?.lastActiveAt || a?.updatedAt || a?.startedAt || 0) || 0;
    const tb = Date.parse(b?.lastActiveAt || b?.updatedAt || b?.startedAt || 0) || 0;
    return tb - ta;
  });
  const target = sorted[0];
  const threadId = target?.threadId || target?.id;
  if (!threadId) return false;

  try {
    await startTurn(threadId, placeholderText);
    return true;
  } catch {
    // turn/start can refuse if the thread is already mid-turn. We swallow
    // the error — the message will be picked up on the next user prompt.
    return false;
  }
}
