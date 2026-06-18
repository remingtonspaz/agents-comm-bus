/**
 * Pi extension entrypoint for agents-comm-bus.
 *
 * Phase 4 wiring (stubs only in Phase 3):
 * - On load: register comm tools + optional slash commands.
 * - On `session_start`: derive `piSessionId`, `client.start()`, `registerReplay`,
 *   `registerPiSession`, start inbound poller → `pi.sendUserMessage(...)`.
 * - On `session_shutdown`: reason-branched cleanup — stop poller; if reason in
 *   `{new, resume, fork, quit}` call `unregisterPiSession` before `client.close()`;
 *   if `reload` skip unregister; always `client.close()`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerCommCommands } from "./commands.js";
import { registerCommTools } from "./tools.js";

export default function agentsCommExtension(pi: ExtensionAPI): void {
  registerCommTools(pi);
  registerCommCommands(pi);

  // TODO(phase4): pi.on("session_start", async (ctx) => { ... });
  // TODO(phase4): pi.on("session_shutdown", async (ctx) => { ... });
}
