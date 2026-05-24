#!/usr/bin/env node
import { runMcpShim } from "../common/mcp-shim-shared.js";

function agentInUse() {
  return process.env.AGENTS_COMM_BUS_AGENT ?? "claude";
}

function sessionInUse() {
  return process.env.AGENTS_COMM_BUS_SESSION_ID ?? process.env.CLAUDE_SESSION_ID ?? "mcp";
}

runMcpShim({
  agentInUse,
  sessionInUse,
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
