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

// Send one JSON-RPC request and resolve with the response. Per the
// Codex app-server protocol, every fresh connection must first send an
// `initialize` request before any other method is callable — otherwise
// the server returns -32600 "Not initialized". We do that handshake
// inline on each call (one-shot connection model; cheap enough for our
// once-per-Telegram-message usage).
const CLIENT_INFO = {
  name: 'telegram-mcp-bridge',
  version: '0.1.0',
};

function callOnce(method, params, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(APP_SERVER_URL);
    } catch (e) {
      reject(e);
      return;
    }

    const initId = 1;
    const callId = 2;
    let settled = false;
    let initialized = false;

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
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: initId,
        method: 'initialize',
        params: { clientInfo: CLIENT_INFO },
      }));
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf-8'));
      } catch {
        return; // Ignore unparseable frames
      }
      if (msg.id === initId) {
        if (msg.error) {
          finish(new Error(`app-server initialize failed: ${msg.error.code} ${msg.error.message || ''}`));
          return;
        }
        initialized = true;
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }));
        return;
      }
      if (msg.id === callId) {
        clearTimeout(timer);
        if (msg.error) {
          finish(new Error(`app-server JSON-RPC error ${msg.error.code}: ${msg.error.message || ''}`));
        } else {
          finish(null, msg.result);
        }
        return;
      }
      // Ignore notifications and other unrelated replies.
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (!settled) {
        finish(new Error(initialized
          ? 'app-server connection closed after initialize but before reply'
          : 'app-server connection closed before initialize completed'));
      }
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
// additionalContext. Returns a diagnostic object so callers can log what
// happened — `ok: true` on success, `ok: false` with `reason` and
// (optionally) `raw` listing/error info otherwise.
//
// Failures are recoverable by design — there might be no app-server
// running, no loaded thread, or the thread might already be mid-turn.
// In those cases the message stays in the queue for the next user
// prompt.
export async function wakeMostRecentThread(placeholderText = '.') {
  let result;
  try {
    result = await listLoadedThreads();
  } catch (e) {
    return { ok: false, reason: 'listLoadedThreads-failed', error: e.message, url: APP_SERVER_URL };
  }

  // Response shape (Codex 0.128): {data: ["<threadId>", ...], nextCursor: null}.
  // Earlier guesses (`threads`, `items`, `loaded`) and bare arrays are
  // kept as fallbacks in case the protocol shifts again.
  const threads =
    (result && (result.data || result.threads || result.items || result.loaded)) ||
    (Array.isArray(result) ? result : []);
  if (!Array.isArray(threads) || threads.length === 0) {
    return {
      ok: false,
      reason: 'no-threads-loaded',
      raw: result === undefined ? null : JSON.stringify(result).slice(0, 500),
    };
  }

  // Each entry may be either a bare thread-ID string (current shape) or a
  // metadata object. Sort by timestamp if available; otherwise the order
  // is whatever the server returned (most-recent-first is the common
  // convention but not guaranteed).
  const sorted = [...threads].sort((a, b) => {
    if (typeof a === 'string' || typeof b === 'string') return 0;
    const ta = Date.parse(a?.lastActiveAt || a?.updatedAt || a?.startedAt || 0) || 0;
    const tb = Date.parse(b?.lastActiveAt || b?.updatedAt || b?.startedAt || 0) || 0;
    return tb - ta;
  });
  const target = sorted[0];
  const threadId =
    typeof target === 'string'
      ? target
      : target?.threadId || target?.id;
  if (!threadId) {
    return {
      ok: false,
      reason: 'no-thread-id-in-response',
      raw: JSON.stringify(target).slice(0, 500),
    };
  }

  try {
    await startTurn(threadId, placeholderText);
    return { ok: true, threadId };
  } catch (e) {
    // turn/start can refuse if the thread is already mid-turn. Surface
    // the error so the caller can decide whether to retry/steer later.
    return { ok: false, reason: 'startTurn-failed', error: e.message, threadId };
  }
}
