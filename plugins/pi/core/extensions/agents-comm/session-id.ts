/**
 * Pi session identity — derive the daemon session id from Pi's SessionManager.
 *
 * Usage rule: call `piSessionId(ctx.sessionManager)` fresh inside each
 * `session_start` handler. Do not cache the return value across reloads — Pi may
 * keep the same UUID on `/reload`, but the handler must still re-read it.
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/** Stable Pi session id: `pi_<uuid>` from Pi's native session id. No hashing or cwd fallback. */
export function piSessionId(sm: SessionManager): string {
  return `pi_${sm.getSessionId()}`;
}
