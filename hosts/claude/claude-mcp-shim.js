#!/usr/bin/env node
import {
  ensureCommsForScopeAtStartup,
  installShutdownHandlers,
  resolveMcpShimProject,
  runMcpShim,
  startEnsureCommsHeartbeat,
} from "../common/mcp-shim-shared.js";

function agentInUse() {
  return process.env.AGENTS_COMM_BUS_AGENT ?? "claude";
}

function sessionInUse() {
  return process.env.AGENTS_COMM_BUS_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? "mcp";
}

const shimCommonOptions = {
  agentInUse,
  shimName: "agents-comm-claude-mcp-shim",
  fromDir: import.meta.dirname,
  resolveProject: () => resolveMcpShimProject(),
};

runMcpShim({
  ...shimCommonOptions,
  sessionInUse,
  beforeConnect: () => ensureCommsForScopeAtStartup(shimCommonOptions),
  afterConnect: () => {
    const heartbeat = startEnsureCommsHeartbeat(shimCommonOptions);
    installShutdownHandlers(() => heartbeat.stop());
  },
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
