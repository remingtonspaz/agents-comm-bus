/**
 * Pi-registered comm tools — mirror MCP shim semantics for cross-host skills.
 *
 * Phase 4: call `pi.registerTool(...)` for:
 *   - `comm_send_message` — text outbound; `target` optional (omit to reply to
 *     most-recent inbound); `target.account` must be a concrete bot_user_id (AGE-15).
 *   - `comm_send_attachment` — file/image outbound; same target semantics.
 *   - `comm_check_messages` — drain pending inbound for the session.
 *   - `list_conversations` — conversation inventory from the daemon.
 *
 * Schemas: typebox (peer dependency). Return concise result text.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerCommTools(_pi: ExtensionAPI): void {
  throw new Error("phase5: not implemented");
}
