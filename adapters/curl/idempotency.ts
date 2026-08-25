import crypto from "node:crypto";

import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import type { CurlInboundReceiptScope } from "agents-comm-bus-core/storage/storage";

/** Deterministic synthetic conversation key when the caller omits `chat_native_id`. */
export function syntheticChatNativeId(senderId: string): string {
  return `curl:${senderId}`;
}

/** Maximum client idempotency key length (bytes of trimmed UTF-8). */
export const CURL_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Default receipt retention: 7 days. Override via CURL_IDEMPOTENCY_RECEIPT_TTL_MS. */
export const DEFAULT_CURL_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function curlReceiptTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CURL_IDEMPOTENCY_RECEIPT_TTL_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_CURL_RECEIPT_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CURL_RECEIPT_TTL_MS;
  }
  return Math.floor(parsed);
}

export function validateCurlIdempotencyKey(
  raw: unknown,
): { key: string } | { error: string } {
  if (typeof raw !== "string") {
    return { error: "body.idempotency_key must be a string when present" };
  }
  const key = raw.trim();
  if (key.length === 0) {
    return { error: "body.idempotency_key must be a non-empty string" };
  }
  if (key.length > CURL_IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      error:
        `body.idempotency_key must be at most ${CURL_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    };
  }
  if (!/^[\x20-\x7E]+$/.test(key)) {
    return { error: "body.idempotency_key must contain only printable ASCII characters" };
  }
  return { key };
}

const METADATA_UNSUPPORTED =
  "body.metadata must contain only JSON values (null, boolean, number, string, object, array)";

export function validateCurlMetadata(
  raw: unknown,
): { metadata: Record<string, unknown> } | { error: string } {
  if (raw == null) return { metadata: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body.metadata must be a JSON object when present" };
  }
  try {
    return { metadata: canonicalizeJsonValue(raw) as Record<string, unknown> };
  } catch {
    return { error: METADATA_UNSUPPORTED };
  }
}

/** Canonicalize nested JSON metadata for stable request hashing. */
export function canonicalizeJsonValue(value: unknown): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error(METADATA_UNSUPPORTED);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (kind === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const nested = record[key];
      if (nested === undefined) {
        throw new Error(METADATA_UNSUPPORTED);
      }
      out[key] = canonicalizeJsonValue(nested);
    }
    return out;
  }
  throw new Error(METADATA_UNSUPPORTED);
}

/** Unambiguous in-memory join key for scoped idempotency work (B7). */
export function curlIdempotencyScopeKey(scope: CurlInboundReceiptScope): string {
  return JSON.stringify([scope.registration_id, scope.sender_id, scope.client_key]);
}

export interface CurlRequestHashInput {
  project: string;
  agent: string;
  sender_id: string;
  text: string;
  chat_native_id?: string;
  metadata?: Record<string, unknown>;
}

/** Hash canonical accepted request fields. Plaintext is not stored in receipts. */
export function curlRequestHash(input: CurlRequestHashInput): string {
  const effectiveChat = input.chat_native_id ?? syntheticChatNativeId(input.sender_id);
  const canonical = {
    project: normalizeProjectPath(input.project),
    agent: input.agent,
    sender_id: input.sender_id,
    text: input.text,
    chat_native_id: effectiveChat,
    metadata: input.metadata ? canonicalizeJsonValue(input.metadata) : null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
