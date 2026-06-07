import { createHash } from "node:crypto";

/** Discord nonce must fit in a snowflake-sized string (≤25 decimal digits). */
const DISCORD_NONCE_MAX_LEN = 25;

/**
 * Map a bus idempotency key to a stable Discord nonce for server-side dedup.
 */
export function discordNonceFromIdempotencyKey(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex").slice(0, DISCORD_NONCE_MAX_LEN);
}
