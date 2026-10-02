import crypto from 'node:crypto';

import { herdrSessionIdFromEnv } from './herdr-env.js';

export function resolveClaudeSessionId(hookInput) {
  const herdr = herdrSessionIdFromEnv('claude');
  if (herdr) return herdr;
  const raw =
    hookInput?.session_id ||
    hookInput?.sessionId ||
    process.env.CLAUDE_SESSION_ID ||
    `${process.cwd()}:${process.env.CLAUDE_PROJECT_DIR || ''}`;
  return `claude_${crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 24)}`;
}
