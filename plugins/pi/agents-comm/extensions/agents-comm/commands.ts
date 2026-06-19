/**
 * Optional slash commands for comm diagnostics and operator support.
 *
 * Phase 4 (optional for MVP):
 *   - `/comm-status` — connection + session registration state
 *   - `/comm-poll-now` — force one inbound drain/inject cycle
 *   - `/comm-list` — list conversations
 *   - `/comm-pause` — pause inbound polling
 *   - `/comm-resume` — resume inbound polling
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerCommCommands(_pi: ExtensionAPI): void {
  throw new Error("phase7: not implemented");
}
