/**
 * Pi session identity — derive the daemon session id from Pi's SessionManager.
 *
 * Phase 4 owns the usage rule: read `sm.getSessionId()` fresh inside each
 * `session_start` handler (do not cache across reloads).
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Stable Pi session id: `pi_<uuid>` from Pi's native session id. No hashing or cwd fallback. */
export function piSessionId(sm: SessionManager): string {
  return `pi_${sm.getSessionId()}`;
}
