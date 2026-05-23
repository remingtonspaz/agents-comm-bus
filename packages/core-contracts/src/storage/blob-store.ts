// Content-addressed filesystem storage under
// `~/.agents-comm-bus/chats/<conversation-id>/attachments/`; references by hash
// only — DB rows MUST NOT duplicate payloads.

export interface BlobRef {
  /** SHA-256 hex of the content. */
  hash: string;
  size: number;
  mime?: string;
}

export interface BlobStore {
  /** Hash = sha256 hex of the bytes. Idempotent: same content yields same ref. */
  put(content: Uint8Array, mime?: string): Promise<BlobRef>;
  open(ref: BlobRef): Promise<ReadableStream<Uint8Array>>;
  /** Resolution helper for transcript references; does not read the file. */
  pathFor(ref: BlobRef): string;
  exists(ref: BlobRef): Promise<boolean>;
}
