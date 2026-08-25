# Curl POST inbound idempotency (AGE-96)

Local curl ingress (`POST /messages`) accepts an optional `idempotency_key` so
retries, crashes, and adapter restarts reuse one logical inbound message instead
of duplicating transcript rows, audit events, dispatch, or query resolution.

## Client rules

- `idempotency_key` is **optional**. Omitting it gives every POST a fresh
  `message_id` (legacy behavior).
- **One logical message, one key.** Every retry of the same logical delivery
  must send the same key until the server returns `202` with stable ids.
- **Distinct messages need distinct keys**, even when `project`, `agent`,
  `sender_id`, `text`, `chat_native_id`, and `metadata` are byte-identical.
- **Same key + changed canonical fields -> `409`.** The server hashes the
  accepted request shape; a body mismatch is a conflict, not a silent new
  message.
- **Accepted receipts expire after 7 days by default** (`DEFAULT_CURL_RECEIPT_TTL_MS`).
  After an accepted receipt passes `expires_at`, the same key may reserve a new
  logical message.
- **Pending reservations never TTL-delete.** A slow or crashed in-flight request
  keeps its scoped row until it accepts or the client changes the key/body.
- Override accepted retention with `CURL_IDEMPOTENCY_RECEIPT_TTL_MS` (milliseconds).

Receipt rows store only hashes and surrogate ids. They never store request
plaintext or metadata blobs.

## Example

```json
POST /messages
Authorization: Bearer <token>
Content-Type: application/json

{
  "project": "D:/my-repo",
  "agent": "claude",
  "sender_id": "ci",
  "text": "build green",
  "idempotency_key": "deploy-42",
  "metadata": { "run_id": "gha-9912" }
}
```

**First success (`202`):**

```json
{
  "ok": true,
  "message_id": "curl:8f1c...",
  "conversation_id": "conv_...",
  "chat_native_id": "curl:ci"
}
```

**Retry with the same key and body:** same `message_id` and `conversation_id`,
no duplicate side effects.

**Retry with the same key but `"text": "build red"`:** `409` with
`idempotency_key was already used with a different request body`.
