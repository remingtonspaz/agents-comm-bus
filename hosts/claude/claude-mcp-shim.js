#!/usr/bin/env node
import {
  ensureCommsForScopeAtStartup,
  resolveMcpShimProject,
  runMcpShim,
} from "../common/mcp-shim-shared.js";

function agentInUse() {
  return process.env.AGENTS_COMM_BUS_AGENT ?? "claude";
}

function sessionInUse() {
  return process.env.AGENTS_COMM_BUS_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? "mcp";
}

runMcpShim({
  agentInUse,
  sessionInUse,
  shimName: "agents-comm-claude-mcp-shim",
  beforeConnect: () =>
    ensureCommsForScopeAtStartup({
      agentInUse,
      shimName: "agents-comm-claude-mcp-shim",
      resolveProject: () => resolveMcpShimProject(),
    }),
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
