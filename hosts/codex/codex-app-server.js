// Codex local app-server JSON-RPC helper.
//
// Phase 3 keeps Codex wake/steer semantics capability-driven in the Codex
// daemon adapter. This file remains the JS helper surface for Codex installs
// and manual diagnostics, not a separate Telegram state owner.

import WebSocket from 'ws';

export const DEFAULT_CODEX_APP_SERVER_URL = 'ws://127.0.0.1:4500';

function getAppServerUrl() {
  if (process.env.CODEX_APP_SERVER_URL) return process.env.CODEX_APP_SERVER_URL;
  for (const arg of process.argv.slice(2)) {
    const match = arg.match(/^--app-server-url=(.+)$/);
    if (match) return match[1];
  }
  return DEFAULT_CODEX_APP_SERVER_URL;
}

const CLIENT_INFO = {
  name: 'agents-comm-bus-codex-helper',
  version: '0.1.0',
};

export function getAppServerUrlInUse() {
  return getAppServerUrl();
}

export function callOnce(method, params, { timeoutMs = 5000 } = {}) {
  const url = getAppServerUrl();
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      reject(error);
      return;
    }

    const initId = 1;
    const callId = 2;
    let settled = false;
    let initialized = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(new Error(`app-server JSON-RPC timeout after ${timeoutMs}ms (method=${method}, url=${url})`));
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
      let message;
      try {
        message = JSON.parse(data.toString('utf-8'));
      } catch {
        return;
      }
      if (message.id === initId) {
        if (message.error) {
          finish(new Error(`app-server initialize failed: ${message.error.code} ${message.error.message || ''}`));
          return;
        }
        initialized = true;
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }));
        return;
      }
      if (message.id === callId) {
        if (message.error) {
          finish(new Error(`app-server JSON-RPC error ${message.error.code}: ${message.error.message || ''}`));
        } else {
          finish(null, message.result);
        }
      }
    });

    ws.on('error', (error) => finish(error));
    ws.on('close', () => {
      if (!settled) {
        finish(new Error(initialized
          ? 'app-server connection closed after initialize but before reply'
          : 'app-server connection closed before initialize completed'));
      }
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

export async function steerTurn(threadId, text) {
  return callOnce('turn/steer', {
    threadId,
    input: [{ type: 'text', text }],
  });
}

export async function wakeMostRecentThread(placeholderText = '.') {
  return controlMostRecentThread('turn/start', placeholderText);
}

export async function steerMostRecentThread(text) {
  return controlMostRecentThread('turn/steer', text);
}

async function controlMostRecentThread(method, text) {
  let result;
  try {
    result = await listLoadedThreads();
  } catch (error) {
    return { ok: false, reason: 'listLoadedThreads-failed', error: error.message, url: getAppServerUrl() };
  }

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

  const sorted = [...threads].sort((a, b) => {
    if (typeof a === 'string' || typeof b === 'string') return 0;
    const ta = Date.parse(a?.lastActiveAt || a?.updatedAt || a?.startedAt || 0) || 0;
    const tb = Date.parse(b?.lastActiveAt || b?.updatedAt || b?.startedAt || 0) || 0;
    return tb - ta;
  });
  const target = sorted[0];
  const threadId = typeof target === 'string' ? target : target?.threadId || target?.id;
  if (!threadId) {
    return {
      ok: false,
      reason: 'no-thread-id-in-response',
      raw: JSON.stringify(target).slice(0, 500),
    };
  }

  try {
    if (method === 'turn/steer') {
      await steerTurn(threadId, text);
    } else {
      await startTurn(threadId, text);
    }
    return { ok: true, method, threadId };
  } catch (error) {
    return { ok: false, reason: `${method}-failed`, error: error.message, threadId };
  }
}
