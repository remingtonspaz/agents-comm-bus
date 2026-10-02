import crypto from 'node:crypto';

import { herdrSessionIdFromEnv } from './herdr-env.js';

export function codexThreadIdFromHook(hookInput) {
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

export function resolveCodexSessionId(hookInput, options = {}) {
  const herdr = herdrSessionIdFromEnv('codex');
  if (herdr) return herdr;
  if (options.honorManagedSessionId && process.env.AGENTS_COMM_BUS_SESSION_ID) {
    return process.env.AGENTS_COMM_BUS_SESSION_ID;
  }
  const raw =
    codexThreadIdFromHook(hookInput) ||
    `${process.cwd()}:${process.env.CODEX_APP_SERVER_URL || ''}`;
  return `codex_${crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 24)}`;
}

/** MCP shim / managed registration: herdr → AGENTS_COMM_BUS_SESSION_ID → codex_ hash. */
export function resolveCodexMcpSessionId(hookInput = {}) {
  return resolveCodexSessionId(hookInput, { honorManagedSessionId: true });
}
