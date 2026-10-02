#!/usr/bin/env node
import {
  ensureCommsForScopeAtStartup,
  installShutdownHandlers,
  log,
  resolveMcpShimProject,
  runMcpShim,
  startEnsureCommsHeartbeat,
} from "../common/mcp-shim-shared.js";
import {
  claudeMcpLastWakeStrategy,
  claudeMcpSessionInUse,
  registerClaudeMcpSession,
} from "../common/claude-mcp-session.js";
import { ensureClaudeWakeWatcher } from "./hooks/wake-support.js";

function agentInUse() {
  return process.env.AGENTS_COMM_BUS_AGENT ?? "claude";
}

function sessionInUse() {
  return claudeMcpSessionInUse();
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
  beforeConnect: async () => {
    await ensureCommsForScopeAtStartup(shimCommonOptions);
    await registerClaudeMcpSession({
      ...shimCommonOptions,
      sessionInUse,
    });
  },
  afterConnect: () => {
    const heartbeat = startEnsureCommsHeartbeat({
      ...shimCommonOptions,
      deps: {
        ensureWatcher: async () => {
          if (claudeMcpLastWakeStrategy() === "herdr") {
            return { reason: "herdr" };
          }
          return ensureClaudeWakeWatcher({ log });
        },
      },
    });
    installShutdownHandlers(() => heartbeat.stop());
  },
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
