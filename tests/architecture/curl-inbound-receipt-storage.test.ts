import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  canonicalizeJsonValue,
  curlIdempotencyScopeKey,
  curlRequestHash,
  DEFAULT_CURL_RECEIPT_TTL_MS,
  validateCurlIdempotencyKey,
  validateCurlMetadata,
} from "../../adapters/curl/idempotency.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type { MessageId } from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT, SCHEMA_VERSION_CONVERSATION } from "../../packages/core-contracts/src/types.js";

registerTempDirCleanup();

const REGISTRATION_ID = "reg-curl-storage";
const SENDER = "ci";
const CLIENT_KEY = "job-42";

function scope(overrides: Partial<{ sender_id: string; client_key: string }> = {}) {
  return {
    registration_id: REGISTRATION_ID,
    sender_id: overrides.sender_id ?? SENDER,
    client_key: overrides.client_key ?? CLIENT_KEY,
  };
}

async function seedConversation(
  storage: Awaited<ReturnType<typeof openSqliteStorage>>,
  conversationId = "conv_storage",
) {
  await storage.putAccountRegistration({
    schema_version: SCHEMA_VERSION_ACCOUNT,
    registration_id: REGISTRATION_ID,
    project: "/repo",
    comm: "curl",
    agent: "claude",
    account_label: "main",
    bot_user_id: "curl:local",
    credentials_ref: "file:/dev/null",
    created_at: 1,
    updated_at: 1,
  });
  await storage.upsertConversation({
    schema_version: SCHEMA_VERSION_CONVERSATION,
    project: "/repo",
    comm: "curl",
    agent: "claude",
    account_label: "main",
    bot_user_id: "curl:local",
    registration_id: REGISTRATION_ID,
    chat_native_id: "curl:ci",
    thread_native_id: null,
    conversation_id: conversationId as never,
    created_at: 1,
    last_inbound_at: null,
    last_outbound_at: null,
    last_message_id: null,
  });
}

describe("AGE-96 curl inbound receipt storage", () => {
  it("coalesces a same-key reservation race across database connections", async () => {
    const dir = await makeTempDir("acb-age96-storage-");
    const path = join(dir, "storage.db");
    const left = await openSqliteStorage(path);
    const right = await openSqliteStorage(path);
    try {
      const now = 900_000;
      const hash = curlRequestHash({
        project: "/repo",
        agent: "claude",
        sender_id: SENDER,
        text: "connection-race",
      });
      const results = await Promise.all([
        left.reserveCurlInboundReceipt({
          ...scope(),
          request_hash: hash,
          message_id: "curl:race-left" as MessageId,
          reserved_at: now,
          expires_at: now + DEFAULT_CURL_RECEIPT_TTL_MS,
        }),
        right.reserveCurlInboundReceipt({
          ...scope(),
          request_hash: hash,
          message_id: "curl:race-right" as MessageId,
          reserved_at: now,
          expires_at: now + DEFAULT_CURL_RECEIPT_TTL_MS,
        }),
      ]);

      assert.deepEqual(
        results.map((result) => result.kind).sort(),
        ["reserved", "resume"],
      );
      assert.equal(results[0].message_id, results[1].message_id);
    } finally {
      await left.close();
      await right.close();
    }
  });

  it("enforces scoped uniqueness and state transitions", async () => {
    const dir = await makeTempDir("acb-age96-storage-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    try {
      const now = 1_000_000;
      const hash = curlRequestHash({
        project: "/repo",
        agent: "claude",
        sender_id: SENDER,
        text: "hello",
      });
      const messageId = "curl:msg-1" as MessageId;

      const reserved = await storage.reserveCurlInboundReceipt({
        ...scope(),
        request_hash: hash,
        message_id: messageId,
        reserved_at: now,
        expires_at: now + DEFAULT_CURL_RECEIPT_TTL_MS,
      });
      assert.deepEqual(reserved, { kind: "reserved", message_id: messageId });

      const resume = await storage.reserveCurlInboundReceipt({
        ...scope(),
        request_hash: hash,
        message_id: "curl:other" as MessageId,
        reserved_at: now + 1,
        expires_at: now + DEFAULT_CURL_RECEIPT_TTL_MS,
      });
      assert.deepEqual(resume, {
        kind: "resume",
        message_id: messageId,
        conversation_id: null,
      });

      const accepted = await storage.acceptCurlInboundReceipt({
        ...scope(),
        conversation_id: "conv_abc" as never,
        accepted_at: now + 2,
      });
      assert.equal(accepted, true);

      const replay = await storage.reserveCurlInboundReceipt({
        ...scope(),
        request_hash: hash,
        message_id: "curl:other2" as MessageId,
        reserved_at: now + 3,
        expires_at: now + DEFAULT_CURL_RECEIPT_TTL_MS,
      });
      assert.deepEqual(replay, {
        kind: "replay",
        message_id: messageId,
        conversation_id: "conv_abc",
      });

      const conflict = await storage.reserveCurlInboundReceipt({
        ...scope(),
        request_hash: "deadbeef",
        message_id: "curl:other3" as MessageId,
        reserved_at: now + 4,
        expires_at: now + DEFAULT_CURL_RECEIPT_TTL_MS,
      });
      assert.deepEqual(conflict, { kind: "conflict" });
    } finally {
      await storage.close();
    }
  });

  it("accept returns false when no pending scoped row exists (B8)", async () => {
    const dir = await makeTempDir("acb-age96-storage-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    try {
      const now = 2_000_000;
      const hash = curlRequestHash({
        project: "/repo",
        agent: "claude",
        sender_id: SENDER,
        text: "accept-guard",
      });
      await storage.reserveCurlInboundReceipt({
        ...scope(),
        request_hash: hash,
        message_id: "curl:accept-guard" as MessageId,
        reserved_at: now,
        expires_at: now + DEFAULT_CURL_RECEIPT_TTL_MS,
      });
      assert.equal(
        await storage.acceptCurlInboundReceipt({
          ...scope(),
          conversation_id: "conv_a" as never,
          accepted_at: now + 1,
        }),
        true,
      );
      assert.equal(
        await storage.acceptCurlInboundReceipt({
          ...scope(),
          conversation_id: "conv_b" as never,
          accepted_at: now + 2,
        }),
        false,
      );
    } finally {
      await storage.close();
    }
  });

  it("stores only hashes, not plaintext request fields", async () => {
    const dir = await makeTempDir("acb-age96-storage-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    try {
      const secretText = "super-secret-payload";
      const hash = curlRequestHash({
        project: "/repo",
        agent: "claude",
        sender_id: SENDER,
        text: secretText,
        metadata: { token: "abc" },
      });
      await storage.reserveCurlInboundReceipt({
        ...scope(),
        request_hash: hash,
        message_id: "curl:msg-2" as MessageId,
        reserved_at: 2_000_000,
        expires_at: 2_000_000 + DEFAULT_CURL_RECEIPT_TTL_MS,
      });

      const row = await storage.getCurlInboundReceipt(scope());
      assert.ok(row);
      assert.equal(row.request_hash, hash);
      assert.equal(JSON.stringify(row).includes(secretText), false);
      assert.equal(JSON.stringify(row).includes("abc"), false);
    } finally {
      await storage.close();
    }
  });

  it("deletes only accepted receipts past TTL; pending reservations survive (B5)", async () => {
    const dir = await makeTempDir("acb-age96-storage-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    try {
      const reservedAt = 3_000_000;
      const expiresAt = reservedAt + 1_000;
      const hash = curlRequestHash({
        project: "/repo",
        agent: "claude",
        sender_id: SENDER,
        text: "ttl-test",
      });
      await storage.reserveCurlInboundReceipt({
        ...scope({ client_key: "pending-ttl" }),
        request_hash: hash,
        message_id: "curl:ttl-pending" as MessageId,
        reserved_at: reservedAt,
        expires_at: expiresAt,
      });
      await storage.reserveCurlInboundReceipt({
        ...scope({ client_key: "accepted-ttl" }),
        request_hash: hash,
        message_id: "curl:ttl-accepted" as MessageId,
        reserved_at: reservedAt,
        expires_at: expiresAt,
      });
      await storage.acceptCurlInboundReceipt({
        ...scope({ client_key: "accepted-ttl" }),
        conversation_id: "conv_ttl" as never,
        accepted_at: reservedAt + 1,
      });

      const deleted = await storage.deleteExpiredCurlInboundReceipts(expiresAt + 1);
      assert.equal(deleted, 1);

      const pending = await storage.getCurlInboundReceipt(scope({ client_key: "pending-ttl" }));
      assert.ok(pending);
      assert.equal(pending.state, "pending");

      const resume = await storage.reserveCurlInboundReceipt({
        ...scope({ client_key: "pending-ttl" }),
        request_hash: hash,
        message_id: "curl:ttl-pending-new" as MessageId,
        reserved_at: expiresAt + 2,
        expires_at: expiresAt + 2 + DEFAULT_CURL_RECEIPT_TTL_MS,
      });
      assert.deepEqual(resume.kind, "resume");
      assert.equal(resume.message_id, "curl:ttl-pending");
    } finally {
      await storage.close();
    }
  });

  it("tracks receipt-scoped recovery markers", async () => {
    const dir = await makeTempDir("acb-age96-storage-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    try {
      const now = 4_000_000;
      const hash = curlRequestHash({
        project: "/repo",
        agent: "claude",
        sender_id: SENDER,
        text: "markers",
      });
      await storage.reserveCurlInboundReceipt({
        ...scope(),
        request_hash: hash,
        message_id: "curl:markers" as MessageId,
        reserved_at: now,
        expires_at: now + DEFAULT_CURL_RECEIPT_TTL_MS,
      });
      await storage.markCurlReceiptConversation(scope(), "conv_prog" as never);
      await storage.markCurlReceiptTranscript(scope(), 100);
      await storage.markCurlReceiptAudit(scope(), 200);
      await storage.markCurlReceiptDispatch(scope(), 300);

      const receipt = await storage.getCurlInboundReceipt(scope());
      assert.equal(receipt?.conversation_id, "conv_prog");
      assert.equal(receipt?.transcript_recorded_at, 100);
      assert.equal(receipt?.audit_recorded_at, 200);
      assert.equal(receipt?.dispatch_recorded_at, 300);

      await storage.markCurlReceiptTranscript(scope(), 999);
      const again = await storage.getCurlInboundReceipt(scope());
      assert.equal(again?.transcript_recorded_at, 100);
    } finally {
      await storage.close();
    }
  });
});

describe("AGE-96 curl idempotency key + hash", () => {
  it("rejects invalid and oversized keys", () => {
    assert.ok("error" in validateCurlIdempotencyKey(""));
    assert.ok("error" in validateCurlIdempotencyKey("   "));
    assert.ok("error" in validateCurlIdempotencyKey(42));
    assert.ok("error" in validateCurlIdempotencyKey("a".repeat(129)));
    assert.ok("error" in validateCurlIdempotencyKey("bad-\u007f-key"));
    assert.deepEqual(validateCurlIdempotencyKey("  stable-key  "), { key: "stable-key" });
  });

  it("uses unambiguous scope keys (B7)", () => {
    const a = curlIdempotencyScopeKey({
      registration_id: "reg",
      sender_id: "send:er",
      client_key: "key",
    });
    const b = curlIdempotencyScopeKey({
      registration_id: "reg",
      sender_id: "send",
      client_key: "er:key",
    });
    assert.notEqual(a, b);
  });

  it("canonicalizes nested metadata and matches across key order (B6)", () => {
    const left = { outer: { z: 1, a: { y: 2, b: 3 } }, list: [{ c: 1, a: 2 }] };
    const right = { list: [{ a: 2, c: 1 }], outer: { a: { b: 3, y: 2 }, z: 1 } };
    assert.deepEqual(canonicalizeJsonValue(left), canonicalizeJsonValue(right));
    const hashA = curlRequestHash({
      project: "/repo",
      agent: "claude",
      sender_id: SENDER,
      text: "nested",
      metadata: left,
    });
    const hashB = curlRequestHash({
      project: "/repo",
      agent: "claude",
      sender_id: SENDER,
      text: "nested",
      metadata: right,
    });
    assert.equal(hashA, hashB);
  });

  it("rejects unsupported metadata values (B6)", () => {
    assert.ok("error" in validateCurlMetadata({ bad: undefined }));
    assert.throws(() => canonicalizeJsonValue(() => {}));
  });

  it("changes hash when canonical request fields change", () => {
    const base = {
      project: "/repo",
      agent: "claude",
      sender_id: SENDER,
      text: "same",
    };
    assert.notEqual(curlRequestHash(base), curlRequestHash({ ...base, text: "different" }));
  });
});
