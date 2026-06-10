/** Visible TUI notice when hook IPC to agents-comm-bus fails (AGE-57). */
export const AGENTS_COMM_BUS_DEGRADED_MESSAGE =
  '⚠️ agents-comm-bus: daemon unreachable — comm integration degraded this turn';

export function degradedHookOutput(hookEventName, extra = {}) {
  return {
    systemMessage: AGENTS_COMM_BUS_DEGRADED_MESSAGE,
    hookSpecificOutput: {
      hookEventName,
      additionalContext: AGENTS_COMM_BUS_DEGRADED_MESSAGE,
      ...extra,
    },
  };
}
