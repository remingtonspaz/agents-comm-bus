// Minimal client for the Codex local app-server JSON-RPC interface.
//
// The Codex TUI's `--remote` flag only accepts ws://host:port or
// wss://host:port (no Unix sockets), so the canonical working
// architecture is TCP-based:
//
//   codex app-server --listen ws://127.0.0.1:4500     # one terminal
//   codex --remote ws://127.0.0.1:4500                # the TUI session
//
// Both Codex *and* this MCP server connect to that same app-server, so
// they see the same set of loaded threads. We use turn/start to wake an
// idle thread when a Telegram message arrives — equivalent to the
// "auto-enter" PostMessage WM_CHAR trick the Claude Code version uses,
// but routed through Codex's own protocol.
//
// URL precedence:
//   1. --app-server-url=<url> argv flag
//   2. CODEX_APP_SERVER_URL env var
//   3. default: ws://127.0.0.1:4500

import WebSocket from 'ws';

const DEFAULT_URL = 'ws://127.0.0.1:4500';

function getAppServerUrl() {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--app-server-url=(.+)$/);
    if (m) return m[1];
  }
  if (process.env.CODEX_APP_SERVER_URL) return process.env.CODEX_APP_SERVER_URL;
  return DEFAULT_URL;
}

const APP_SERVER_URL = getAppServerUrl();

// Send one JSON-RPC request and resolve with the response. Closes the
// connection after the reply (or timeout) — not meant for streaming.
function callOnce(method, params, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(APP_SERVER_URL);
    } catch (e) {
      reject(e);
      return;
    }

    const id = Math.floor(Math.random() * 1e9);
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(`app-server JSON-RPC timeout after ${timeoutMs}ms (method=${method}, url=${APP_SERVER_URL})`));
    }, timeoutMs);

    ws.on('open', () => {
      const req = { jsonrpc: '2.0', id, method, params };
      ws.send(JSON.stringify(req));
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf-8'));
      } catch {
        return; // Ignore unparseable frames
      }
      if (msg.id !== id) return; // Ignore notifications and other replies
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

export function getAppServerUrlInUse() {
  return APP_SERVER_URL;
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
// Failures are silent by design — there might be no app-server running,
// no loaded thread, or the thread might already be mid-turn. In those
// cases the message stays in the queue for the next user prompt.
export async function wakeMostRecentThread(placeholderText = '.') {
  let result;
  try {
    result = await listLoadedThreads();
  } catch {
    return false;
  }

  // The exact response shape isn't fully documented; handle common variants.
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
    // turn/start can refuse if the thread is already mid-turn. Swallow —
    // the message will be picked up on the next user prompt.
    return false;
  }
}
