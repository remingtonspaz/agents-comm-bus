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

export function resolveCodexSessionId(hookInput) {
  if (process.env.AGENTS_COMM_BUS_SESSION_ID) {
    return process.env.AGENTS_COMM_BUS_SESSION_ID;
  }
  const herdr = herdrSessionIdFromEnv('codex');
  if (herdr) return herdr;
  const raw =
    codexThreadIdFromHook(hookInput) ||
    `${process.cwd()}:${process.env.CODEX_APP_SERVER_URL || ''}`;
  return `codex_${crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 24)}`;
}
