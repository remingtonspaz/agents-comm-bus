import { ensureClaudeWakeWatcher } from '../claude/hooks/wake-support.js';

/**
 * Spawn the enter-watcher only when native wake is in effect (or registration failed).
 * @param {{ wake_strategy?: string } | null | undefined} registerResult
 * @param {object} watcherOptions
 */
export function ensureClaudeWakeWatcherAfterRegister(registerResult, watcherOptions) {
  if (registerResult?.wake_strategy === 'herdr') return;
  ensureClaudeWakeWatcher(watcherOptions);
}
