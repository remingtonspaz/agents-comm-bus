import type { CurlInboundReceiptScope } from "agents-comm-bus-core/storage/storage";
/** Deterministic synthetic conversation key when the caller omits `chat_native_id`. */
export declare function syntheticChatNativeId(senderId: string): string;
/** Maximum client idempotency key length (bytes of trimmed UTF-8). */
export declare const CURL_IDEMPOTENCY_KEY_MAX_LENGTH = 128;
/** Default receipt retention: 7 days. Override via CURL_IDEMPOTENCY_RECEIPT_TTL_MS. */
export declare const DEFAULT_CURL_RECEIPT_TTL_MS: number;
export declare function curlReceiptTtlMs(env?: NodeJS.ProcessEnv): number;
export declare function validateCurlIdempotencyKey(raw: unknown): {
    key: string;
} | {
    error: string;
};
export declare function validateCurlMetadata(raw: unknown): {
    metadata: Record<string, unknown>;
} | {
    error: string;
};
/** Canonicalize nested JSON metadata for stable request hashing. */
export declare function canonicalizeJsonValue(value: unknown): unknown;
/** Unambiguous in-memory join key for scoped idempotency work (B7). */
export declare function curlIdempotencyScopeKey(scope: CurlInboundReceiptScope): string;
export interface CurlRequestHashInput {
    project: string;
    agent: string;
    sender_id: string;
    text: string;
    chat_native_id?: string;
    metadata?: Record<string, unknown>;
}
/** Hash canonical accepted request fields. Plaintext is not stored in receipts. */
export declare function curlRequestHash(input: CurlRequestHashInput): string;
//# sourceMappingURL=idempotency.d.ts.map