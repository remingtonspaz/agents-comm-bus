import { ensureClaudeWakeWatcher } from '../claude/hooks/wake-support.js';

/**
 * Spawn the enter-watcher only when native wake is in effect (or registration failed).
 * Herdr panes have no cmd.exe console for PostMessage wake — never spawn the watcher there.
 * @param {{ wake_strategy?: string } | null | undefined} registerResult
 * @param {object} watcherOptions
 * @param {{ env?: NodeJS.ProcessEnv, ensureClaudeWakeWatcher?: typeof ensureClaudeWakeWatcher }} [deps]
 */
export function ensureClaudeWakeWatcherAfterRegister(registerResult, watcherOptions, deps = {}) {
  const env = deps.env ?? watcherOptions?.env ?? process.env;
  if (env.HERDR_ENV === '1') return;
  if (registerResult?.wake_strategy === 'herdr') return;
  const ensure = deps.ensureClaudeWakeWatcher ?? ensureClaudeWakeWatcher;
  ensure(watcherOptions);
}
