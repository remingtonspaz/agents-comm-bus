/**
 * Pi extension entrypoint for agents-comm-bus.
 *
 * Session lifecycle: register with the daemon on `session_start`, poll inbound
 * messages into Pi via `sendUserMessage`, and reason-branched cleanup on
 * `session_shutdown` (explicit lease release on quit/new/resume/fork; skip on
 * reload so `registerReplay` re-registers idempotently).
 */
import crypto from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerCommCommands } from "./commands.js";
import { PiDaemonClient, DisconnectedError } from "./daemon-client.js";
import { formatInboundMessages } from "./inbound-format.js";
import { piSessionId } from "./session-id.js";
import { registerCommTools } from "./tools.js";
import {
  parseAgentsCommLabels,
  serializeAccountLabelScope,
} from "agents-comm-bus/session-label-scope";

const POLL_INTERVAL_MS = 2_000;

let lifecycleWired = false;

/** Stable for this extension runtime — sent on register and unregister. */
const connectionId = `pi-conn-${crypto.randomUUID()}`;

let client: PiDaemonClient | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let isPolling = false;
let piSession: string | null = null;
let pollCtx: ExtensionContext | null = null;
let pollPi: ExtensionAPI | null = null;

function log(message: string): void {
  console.error(`[pi-agents-comm] ${message}`);
}

function stopPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll(): void {
  if (!client || !piSession || !pollCtx || !pollPi) return;
  pollTimer = setTimeout(() => {
    void pollOnce();
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();
}

async function pollOnce(): Promise<void> {
  if (isPolling || !client || !piSession || !pollCtx || !pollPi) return;
  isPolling = true;
  try {
    const { messages } = await client.drainPiInbound({
      agent: "pi",
      session: piSession,
      project: pollCtx.cwd,
      limit: 100,
    });
    if (messages.length > 0) {
      const block = formatInboundMessages(messages);
      if (pollCtx.isIdle()) {
        pollPi.sendUserMessage(block);
      } else {
        pollPi.sendUserMessage(block, { deliverAs: "steer" });
      }
    }
  } catch (error) {
    if (error instanceof DisconnectedError) {
      log("inbound poll skipped: daemon disconnected (reconnecting)");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      log(`inbound poll error: ${message}`);
    }
  } finally {
    isPolling = false;
    schedulePoll();
  }
}

function startPolling(pi: ExtensionAPI, ctx: ExtensionContext): void {
  stopPolling();
  pollPi = pi;
  pollCtx = ctx;
  schedulePoll();
}

export default function agentsCommExtension(pi: ExtensionAPI): void {
  // Tool/command registration moved to session_start (not load time) to fix:
  // 1. Multi-package conflict: when multiple per-comm packages are installed,
  //    each bundles its own copy of this core. At load time, each copy's
  //    module-level flag is independent → both try to register the same tools
  //    → Pi rejects with "Tool conflicts". At session_start time, the first
  //    package registers; the second sees them via getAllTools() and skips.
  // 2. Reload safety: old runtime torn down before new session_start → stale
  //    tools cleared → getAllTools() is accurate → fresh registration succeeds.

  if (!lifecycleWired) {
    lifecycleWired = true;

    pi.on("session_start", async (_event, ctx) => {
      // Register comm tools (idempotent via getAllTools check — see tools.ts).
      // Moved here from load time so the check is accurate (stale tools from
      // a prior runtime are cleared before session_start fires).
      try {
        registerCommTools(pi, () => client);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[pi-agents-comm] comm tools not registered: ${message}`);
      }
      try {
        registerCommCommands(pi);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[pi-agents-comm] comm commands not registered: ${message}`);
      }

      piSession = piSessionId(ctx.sessionManager);
      client = new PiDaemonClient(ctx.cwd, log);
      try {
        await client.start();
        await client.registerPiSession({
          agent: "pi",
          session: piSession,
          project: ctx.cwd,
          cwd: ctx.cwd,
          connection_id: connectionId,
          account_label_scope: serializeAccountLabelScope(
            parseAgentsCommLabels(process.env.AGENTS_COMM_LABELS),
          ),
          host: {
            pid: process.pid,
            label: "pi",
            mode: ctx.mode,
            session_file: ctx.sessionManager.getSessionFile() ?? null,
          },
        });
        startPolling(pi, ctx);
        if (ctx.mode === "tui") {
          ctx.ui.notify("agents-comm-bus connected", "info");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`session_start failed: ${message}`);
        await client?.close();
        client = null;
        stopPolling();
        pollPi = null;
        pollCtx = null;
      }
    });

    pi.on("session_shutdown", async (event, _ctx) => {
      stopPolling();
      pollPi = null;
      pollCtx = null;

      const reason = event.reason;
      const shouldUnregister =
        reason === "new" || reason === "resume" || reason === "fork" || reason === "quit";

      if (shouldUnregister && client && piSession) {
        try {
          await client.unregisterPiSession({
            agent: "pi",
            session: piSession,
            connection_id: connectionId,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log(`unregister skipped: ${message}`);
        }
      }

      try {
        await client?.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`client close error: ${message}`);
      }
      client = null;
    });
  }
}
