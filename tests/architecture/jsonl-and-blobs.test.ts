import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import type { ConversationId, MessageId } from "../../packages/core-contracts/src/types.js";

async function withTempDir<T>(test: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-jsonl-"));
  try {
    return await test(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}

describe("JSONL and blob stores", () => {
  it("appends transcript entries in order for a conversation", async () => {
    await withTempDir(async (dir) => {
      const store = new JsonlTranscriptStore(dir);
      const conversation = "conv-1" as ConversationId;

      await store.append({
        conversation_id: conversation,
        timestamp: 1,
        direction: "inbound",
        message_id: "msg-1" as MessageId,
        payload: { text: "first" },
      });
      await store.append({
        conversation_id: conversation,
        timestamp: 2,
        direction: "outbound",
        message_id: "msg-2" as MessageId,
        payload: { text: "second", blob_hashes: ["abc"] },
      });

      const entries = await collect(store.read(conversation));
      assert.deepEqual(entries.map((entry) => entry.message_id), ["msg-1", "msg-2"]);
      assert.deepEqual(entries[1]?.payload, { text: "second", blob_hashes: ["abc"] });
    });
  });

  it("appends audit events to a daily JSONL file", async () => {
    await withTempDir(async (dir) => {
      const store = new JsonlAuditStore(dir);
      await store.append({ timestamp: Date.UTC(2026, 4, 15, 1), kind: "query_opened" });
      await store.append({ timestamp: Date.UTC(2026, 4, 15, 2), kind: "query_resolved" });

      const lines = (await readFile(store.pathFor(Date.UTC(2026, 4, 15)), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string });

      assert.deepEqual(lines.map((line) => line.kind), ["query_opened", "query_resolved"]);
    });
  });

  it("stores blobs by content hash and returns stable references", async () => {
    await withTempDir(async (dir) => {
      const store = new ContentAddressedBlobStore(dir);
      const first = await store.put(new TextEncoder().encode("same content"), "text/plain");
      const second = await store.put(new TextEncoder().encode("same content"), "text/plain");
      const other = await store.put(new TextEncoder().encode("other content"), "text/plain");

      assert.deepEqual(second, first);
      assert.notEqual(other.hash, first.hash);
      assert.equal(await store.exists(first), true);

      const bytes = await new Response(await store.open(first)).arrayBuffer();
      assert.equal(new TextDecoder().decode(bytes), "same content");
    });
  });
});
