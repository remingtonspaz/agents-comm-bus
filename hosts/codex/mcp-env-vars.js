/**
 * Canonical environment variable names Codex must forward into stdio MCP shims.
 * Bootstrap/app-server and MCP registration read these keys at runtime.
 */
export const CODEX_MCP_ENV_VAR_NAMES = Object.freeze([
  "AGENTS_COMM_BUS_AGENT",
  "AGENTS_COMM_BUS_SESSION_ID",
  "AGENTS_COMM_LABELS",
  "AGENTS_COMM_BUS_BIN",
  "AGENTS_COMM_BUS_DISCOVERY_ROOT",
  "AGENTS_COMM_BUS_ADAPTERS_DIR",
  "AGENTS_COMM_BUS_ROOT",
  "CODEX_APP_SERVER_URL",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
]);

export function formatTomlEnvVars(names = CODEX_MCP_ENV_VAR_NAMES) {
  const items = names.map((name) => JSON.stringify(name)).join(", ");
  return `env_vars = [${items}]`;
}
