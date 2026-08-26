import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CurlCommAdapter } from "../../adapters/curl/adapter.js";
import { curlIdempotencyScopeKey, curlRequestHash } from "../../adapters/curl/idempotency.js";
import { MessageBus } from "../../core-daemon/bus.js";
import {
  attachInboundMessageContext,
  readInboundMessageContext,
} from "../../core-daemon/runtime/inbound-message-context.js";
import {
  deliveryRowFromEntry,
} from "../../core-daemon/runtime/durable-inbound.js";
import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import type { TranscriptEntry, TranscriptStore } from "agents-comm-bus-core";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type {
  AccountId,
  AgentId,
  AuditEvent,
  CommId,
  Conversation,
  ConversationId,
  Message,
  MessageId,
  QueryId,
  SessionId,
  Storage,
  TranscriptStore as TranscriptStoreContract,
} from "../../packages/core-contracts/src/index.js";
import {
  SCHEMA_VERSION_ACCOUNT,
  SCHEMA_VERSION_CONVERSATION,
  SCHEMA_VERSION_QUERY,
  SCHEMA_VERSION_SESSION,
} from "../../packages/core-contracts/src/types.js";

registerTempDirCleanup();

const ACCOUNT = "curl:local" as AccountId;
const PROJECT = normalizeProjectPath("/repo");
const REGISTRATION_ID = "reg-curl-age96";
const TOKEN = "s3cret-token";
const SENDER = "ci";

class RecordingAuditStore {
  readonly events: AuditEvent[] = [];
  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
  async hasInboundReceived(
    conversation_id: ConversationId,
    message: Pick<Message, "platform_message_id">,
    _auditTimestamp?: number,
  ): Promise<boolean> {
    return this.events.some(
      (event) =>
        event.kind === "inbound_received" &&
        event.conversation_id === conversation_id &&
        event.detail?.platform_message_id === message.platform_message_id,
    );
  }
}

interface HarnessCounters {
  dispatchCount: number;
  wakeCount: number;
}

interface HarnessParts {
  dir: string;
  dbPath: string;
  storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  transcripts: TranscriptStoreContract;
  audit: RecordingAuditStore;
  pendingInbound: PendingInboundEntry[];
  counters: HarnessCounters;
  adapter: CurlCommAdapter;
  url: string;
}

async function openHarnessParts(
  dir: string,
  options: {
    transcripts?: TranscriptStoreContract;
    storage?: Storage;
    audit?: RecordingAuditStore;
  } = {},
): Promise<Omit<HarnessParts, "adapter" | "url">> {
  const dbPath = join(dir, "storage.db");
  const storage = options.storage ?? (await openSqliteStorage(dbPath));
  const transcripts = options.transcripts ?? new JsonlTranscriptStore(dir);
  const audit = options.audit ?? new RecordingAuditStore();
  const pendingInbound: PendingInboundEntry[] = [];
  const counters: HarnessCounters = { dispatchCount: 0, wakeCount: 0 };

  await storage.putAccountRegistration({
    schema_version: SCHEMA_VERSION_ACCOUNT,
    registration_id: REGISTRATION_ID,
    project: PROJECT,
    comm: "curl" as CommId,
    agent: "claude" as AgentId,
    account_label: "main",
    bot_user_id: String(ACCOUNT),
    credentials_ref: "file:/dev/null",
    created_at: 1,
    updated_at: 1,
  });

  return {
    dir,
    dbPath,
    storage,
    transcripts,
    audit,
    pendingInbound,
    counters,
  };
}

function wireBus(parts: Omit<HarnessParts, "adapter" | "url">): MessageBus {
  const bus = new MessageBus({
    project: PROJECT,
    storage: parts.storage,
    transcripts: parts.transcripts,
    audit: parts.audit,
    now: () => 5_000,
  });
  bus.setDispatchSink({
    enqueueInbound: async (message, conversation) => {
      parts.counters.dispatchCount += 1;
      parts.counters.wakeCount += 1;
      const entry: PendingInboundEntry = { message, conversation };
      await parts.storage.recordPendingInboundDelivery(
        deliveryRowFromEntry(entry, Date.now()),
      );
      parts.pendingInbound.push(entry);
    },
  });
  return bus;
}

async function startHarness(
  dir: string,
  options: {
    transcripts?: TranscriptStoreContract;
    storage?: Storage;
    audit?: RecordingAuditStore;
    adapterOverrides?: Partial<ConstructorParameters<typeof CurlCommAdapter>[0]>;
  } = {},
): Promise<HarnessParts> {
  const parts = await openHarnessParts(dir, options);
  const bus = wireBus(parts);
  const adapter = new CurlCommAdapter({
    token: TOKEN,
    accountId: ACCOUNT,
    project: PROJECT,
    agent: "claude",
    registrationId: REGISTRATION_ID,
    storage: parts.storage,
    receiptTtlMs: 60_000,
    ...options.adapterOverrides,
  });
  bus.registerComm(adapter);
  await adapter.start();
  return {
    ...parts,
    adapter,
    url: `http://127.0.0.1:${adapter.port}/messages`,
  };
}

function postBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: PROJECT,
    agent: "claude",
    sender_id: SENDER,
    text: "build green",
    ...overrides,
  };
}

async function post(
  url: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json };
}

async function stopHarness(harness: HarnessParts): Promise<void> {
  await harness.adapter.stop();
  await harness.storage.close();
}

async function transcriptLineCount(
  transcripts: TranscriptStoreContract,
  conversationId: string,
): Promise<number> {
  let count = 0;
  for await (const _entry of transcripts.read(conversationId as ConversationId)) {
    count += 1;
  }
  return count;
}

function crashAfterFirstAppend(inner: TranscriptStoreContract): TranscriptStoreContract {
  let crashed = false;
  return {
    async append(entry: TranscriptEntry): Promise<void> {
      await inner.append(entry);
      if (!crashed) {
        crashed = true;
        throw new Error("crash after transcript append");
      }
    },
    read: inner.read.bind(inner),
  };
}

function crashAfterFirstAudit(inner: RecordingAuditStore): RecordingAuditStore {
  let crashed = false;
  const originalAppend = inner.append.bind(inner);
  inner.append = async (event: AuditEvent) => {
    await originalAppend(event);
    if (!crashed && event.kind === "inbound_received") {
      crashed = true;
      throw new Error("crash after audit append");
    }
  };
  return inner;
}

describe("AGE-96 inbound message context serialization", { concurrency: 1 }, () => {
  it("omits non-enumerable curl scope from JSON payloads", () => {
    const message: Message = {
      schema_version: 1,
      message_id: "curl:test" as MessageId,
      chat: {
        comm: "curl",
        account: ACCOUNT,
        chat_native_id: "curl:ci",
      },
      sender: { id: SENDER, isBot: false, isForeignBot: false },
      origin: { comm: "curl" },
      text: "hello",
      platform_message_id: "uuid",
      hop_count: 0,
      received_at: 1,
    };
    attachInboundMessageContext(message, {
      kind: "curl_idempotency",
      scope: {
        registration_id: REGISTRATION_ID,
        sender_id: SENDER,
        client_key: "k1",
      },
    });
    const serialized = JSON.stringify(message);
    assert.equal(serialized.includes(REGISTRATION_ID), false);
    assert.equal(serialized.includes("client_key"), false);
    assert.equal(readInboundMessageContext(message)?.scope.client_key, "k1");
  });
});

describe("AGE-96 curl inbound idempotency HTTP", { concurrency: 1 }, () => {
  it("same key + same request returns original ids with one effect set", async () => {
    const dir = await makeTempDir("acb-age96-http-");
    const harness = await startHarness(dir);
    try {
      const body = postBody({ idempotency_key: "idem-a" });
      const first = await post(harness.url, body);
      const second = await post(harness.url, body);
      assert.equal(first.status, 202);
      assert.equal(second.status, 202);
      assert.equal(second.json.message_id, first.json.message_id);
      assert.equal(second.json.conversation_id, first.json.conversation_id);
      assert.equal(harness.audit.events.filter((e) => e.kind === "inbound_received").length, 1);
      assert.equal(harness.counters.dispatchCount, 1);

      let transcriptJson = "";
      for await (const entry of harness.transcripts.read(
        first.json.conversation_id as ConversationId,
      )) {
        transcriptJson += JSON.stringify(entry);
      }
      assert.equal(transcriptJson.includes("__agents_comm_bus"), false);
      assert.equal(transcriptJson.includes("idem-a"), false);
      assert.equal(transcriptJson.includes(REGISTRATION_ID), false);
    } finally {
      await stopHarness(harness);
    }
  });

  it("same key + changed request returns 409 with no new effects", async () => {
    const dir = await makeTempDir("acb-age96-http-");
    const harness = await startHarness(dir);
    try {
      const first = await post(harness.url, postBody({ idempotency_key: "idem-b", text: "one" }));
      assert.equal(first.status, 202);
      const conflict = await post(
        harness.url,
        postBody({ idempotency_key: "idem-b", text: "two" }),
      );
      assert.equal(conflict.status, 409);
      assert.equal(harness.audit.events.filter((e) => e.kind === "inbound_received").length, 1);
      assert.equal(harness.counters.dispatchCount, 1);
    } finally {
      await stopHarness(harness);
    }
  });

  it("identical content with different keys creates two accepted messages", async () => {
    const dir = await makeTempDir("acb-age96-http-");
    const harness = await startHarness(dir);
    try {
      const first = await post(harness.url, postBody({ idempotency_key: "k1" }));
      const second = await post(harness.url, postBody({ idempotency_key: "k2" }));
      assert.notEqual(first.json.message_id, second.json.message_id);
      assert.equal(harness.audit.events.filter((e) => e.kind === "inbound_received").length, 2);
      assert.equal(harness.counters.dispatchCount, 2);
    } finally {
      await stopHarness(harness);
    }
  });

  it("omitted key keeps fresh ids per POST", async () => {
    const dir = await makeTempDir("acb-age96-http-");
    const harness = await startHarness(dir);
    try {
      const first = await post(harness.url, postBody());
      const second = await post(harness.url, postBody());
      assert.notEqual(first.json.message_id, second.json.message_id);
    } finally {
      await stopHarness(harness);
    }
  });

  it("restarts adapter and storage then replays same ids after pending ack (B2)", async () => {
    const dir = await makeTempDir("acb-age96-restart-");
    const body = postBody({ idempotency_key: "restart-key" });
    let firstIds: { message_id: unknown; conversation_id: unknown };

    const first = await startHarness(dir);
    try {
      const accepted = await post(first.url, body);
      assert.equal(accepted.status, 202);
      firstIds = {
        message_id: accepted.json.message_id,
        conversation_id: accepted.json.conversation_id,
      };
      assert.equal(first.pendingInbound.length, 1);
      await first.storage.acknowledgePendingInboundDeliveries([
        {
          conversation_id: firstIds.conversation_id as ConversationId,
          message_id: firstIds.message_id as MessageId,
          comm: "curl",
          account: String(ACCOUNT),
        },
      ]);
    } finally {
      await stopHarness(first);
    }

    const second = await startHarness(dir);
    try {
      const replay = await post(second.url, body);
      assert.equal(replay.status, 202);
      assert.equal(replay.json.message_id, firstIds.message_id);
      assert.equal(replay.json.conversation_id, firstIds.conversation_id);
      assert.equal(second.audit.events.filter((e) => e.kind === "inbound_received").length, 0);
      assert.equal(second.counters.dispatchCount, 0);
      assert.equal(second.pendingInbound.length, 0);
    } finally {
      await stopHarness(second);
    }
  });

  it("concurrent same-key POSTs allocate one message and one effect set", async () => {
    const dir = await makeTempDir("acb-age96-http-");
    const harness = await startHarness(dir);
    try {
      const body = postBody({ idempotency_key: "concurrent-key" });
      const [a, b, c] = await Promise.all([
        post(harness.url, body),
        post(harness.url, body),
        post(harness.url, body),
      ]);
      for (const response of [a, b, c]) {
        assert.equal(response.status, 202);
        assert.equal(response.json.message_id, a.json.message_id);
      }
      assert.equal(harness.audit.events.filter((e) => e.kind === "inbound_received").length, 1);
      assert.equal(harness.counters.dispatchCount, 1);
    } finally {
      await stopHarness(harness);
    }
  });

  it("concurrent same-key requests with different content return 409", async () => {
    const dir = await makeTempDir("acb-age96-http-");
    const inner = new JsonlTranscriptStore(dir);
    let releaseAppend!: () => void;
    const appendRelease = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let signalAppend!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      signalAppend = resolve;
    });
    const transcripts: TranscriptStoreContract = {
      async append(entry: TranscriptEntry): Promise<void> {
        signalAppend();
        await appendRelease;
        await inner.append(entry);
      },
      read: inner.read.bind(inner),
    };
    const harness = await startHarness(dir, { transcripts });
    try {
      const firstPromise = post(
        harness.url,
        postBody({ idempotency_key: "concurrent-conflict", text: "one" }),
      );
      await appendStarted;

      const conflictPromise = post(
        harness.url,
        postBody({ idempotency_key: "concurrent-conflict", text: "two" }),
      );
      let timeout: NodeJS.Timeout | undefined;
      const conflict = await Promise.race([
        conflictPromise,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("conflicting request joined in-flight work")),
            1_000,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      assert.equal(conflict.status, 409);

      releaseAppend();
      const first = await firstPromise;
      assert.equal(first.status, 202);
      assert.equal(harness.audit.events.filter((e) => e.kind === "inbound_received").length, 1);
      assert.equal(harness.counters.dispatchCount, 1);
    } finally {
      releaseAppend();
      await stopHarness(harness);
    }
  });

  it("in-flight scope keys do not alias crafted sender/key tuples (B7)", async () => {
    const dir = await makeTempDir("acb-age96-collision-");
    const harness = await startHarness(dir);
    try {
      const keyA = curlIdempotencyScopeKey({
        registration_id: REGISTRATION_ID,
        sender_id: "a:b",
        client_key: "c",
      });
      const keyB = curlIdempotencyScopeKey({
        registration_id: REGISTRATION_ID,
        sender_id: "a",
        client_key: "b:c",
      });
      assert.notEqual(keyA, keyB);

      const first = await post(
        harness.url,
        postBody({ sender_id: "a:b", idempotency_key: "c" }),
      );
      const second = await post(
        harness.url,
        postBody({ sender_id: "a", idempotency_key: "b:c" }),
      );
      assert.equal(first.status, 202);
      assert.equal(second.status, 202);
      assert.notEqual(first.json.message_id, second.json.message_id);
      assert.equal(harness.audit.events.filter((e) => e.kind === "inbound_received").length, 2);
    } finally {
      await stopHarness(harness);
    }
  });
});

describe("AGE-96 curl inbound fault injection", { concurrency: 1 }, () => {
  async function runFaultRetryTest(input: {
    dirPrefix: string;
    idempotencyKey: string;
    buildHarness: (dir: string) => Promise<HarnessParts>;
  }): Promise<{
    firstStatus: number;
    secondStatus: number;
    messageId: unknown;
    conversationId: unknown;
    inboundEvents: number;
    dispatchCount: number;
    transcriptLines: number;
    lastInboundMessageId: string | null;
  }> {
    const dir = await makeTempDir(input.dirPrefix);
    const harness = await input.buildHarness(dir);
    const body = postBody({ idempotency_key: input.idempotencyKey });
    let firstStatus = 500;
    try {
      const first = await post(harness.url, body);
      firstStatus = first.status;
    } catch {
      firstStatus = 500;
    }
    const second = await post(harness.url, body);
    const lines = await transcriptLineCount(
      harness.transcripts,
      String(second.json.conversation_id),
    );
    const conversation = await harness.storage.getConversation(
      String(second.json.conversation_id) as ConversationId,
    );
    const result = {
      firstStatus,
      secondStatus: second.status,
      messageId: second.json.message_id,
      conversationId: second.json.conversation_id,
      inboundEvents: harness.audit.events.filter((e) => e.kind === "inbound_received").length,
      dispatchCount: harness.counters.dispatchCount,
      transcriptLines: lines,
      lastInboundMessageId: conversation?.last_message_id ?? null,
    };
    await stopHarness(harness);
    return result;
  }

  it("transcript append crash then retry: one transcript row and 202 (B3)", async () => {
    const result = await runFaultRetryTest({
      dirPrefix: "acb-age96-fault-transcript-",
      idempotencyKey: "fault-transcript",
      async buildHarness(dir) {
        const inner = new JsonlTranscriptStore(dir);
        return startHarness(dir, { transcripts: crashAfterFirstAppend(inner) });
      },
    });
    assert.equal(result.secondStatus, 202);
    assert.equal(result.inboundEvents, 1);
    assert.equal(result.transcriptLines, 1);
    assert.equal(result.dispatchCount, 1);
    assert.equal(result.lastInboundMessageId, result.messageId);
  });

  it("audit append crash then retry: one inbound_received and 202 (B3)", async () => {
    const dir = await makeTempDir("acb-age96-fault-audit-");
    const inner = new JsonlTranscriptStore(dir);
    const audit = crashAfterFirstAudit(new RecordingAuditStore());
    const harness = await startHarness(dir, {
      transcripts: inner,
      audit,
    });
    try {
      const body = postBody({ idempotency_key: "fault-audit" });
      const first = await post(harness.url, body);
      assert.equal(first.status, 500);
      const second = await post(harness.url, body);
      assert.equal(second.status, 202);
      assert.equal(audit.events.filter((e) => e.kind === "inbound_received").length, 1);
      assert.equal(harness.counters.dispatchCount, 1);
    } finally {
      await stopHarness(harness);
    }
  });

  it("inbound_received audit uses receipt reserved_at across UTC day retry (F2)", async () => {
    const reservedAt = Date.parse("2026-01-01T23:59:59.000Z");
    const retryReceivedAt = Date.parse("2026-01-02T12:00:00.000Z");
    const dir = await makeTempDir("acb-age96-audit-reserved-");
    const audit = new JsonlAuditStore(dir);
    const harness = await startHarness(dir, {
      audit,
      adapterOverrides: { now: () => retryReceivedAt },
    });
    try {
      const clientKey = "audit-reserved-at";
      const body = postBody({ idempotency_key: clientKey });
      const scope = {
        registration_id: REGISTRATION_ID,
        sender_id: SENDER,
        client_key: clientKey,
      };
      const messageId = "curl:audit-reserved" as MessageId;
      await harness.storage.reserveCurlInboundReceipt({
        ...scope,
        request_hash: curlRequestHash({
          project: PROJECT,
          agent: "claude",
          sender_id: SENDER,
          text: String(body.text),
        }),
        message_id: messageId,
        reserved_at: reservedAt,
        expires_at: reservedAt + 60_000,
      });
      const convId = "conv_audit_reserved" as ConversationId;
      await harness.storage.upsertConversation({
        schema_version: SCHEMA_VERSION_CONVERSATION,
        project: PROJECT,
        comm: "curl",
        agent: "claude",
        account_label: "main",
        bot_user_id: String(ACCOUNT),
        registration_id: REGISTRATION_ID,
        chat_native_id: "curl:ci",
        thread_native_id: null,
        conversation_id: convId,
        created_at: 1,
        last_inbound_at: null,
        last_outbound_at: null,
        last_message_id: null,
      });
      await harness.storage.markCurlReceiptConversation(scope, convId);
      await harness.storage.markCurlReceiptTranscript(scope, reservedAt);

      const response = await post(harness.url, body);
      assert.equal(response.status, 202);

      const reservedDay = new Date(reservedAt).toISOString().slice(0, 10);
      const retryDay = new Date(retryReceivedAt).toISOString().slice(0, 10);
      assert.notEqual(reservedDay, retryDay);

      await access(audit.pathFor(reservedAt));
      await assert.rejects(() => access(audit.pathFor(retryReceivedAt)));

      const platformUuid = messageId.slice("curl:".length);
      const probeMessage = { platform_message_id: platformUuid } as Pick<
        Message,
        "platform_message_id"
      >;
      assert.equal(await audit.hasInboundReceived!(convId, probeMessage, reservedAt), true);
      assert.equal(
        await audit.hasInboundReceived!(convId, probeMessage, retryReceivedAt),
        false,
      );
      assert.equal(await audit.hasInboundReceived!(convId, probeMessage, Date.now()), false);
    } finally {
      await stopHarness(harness);
    }
  });

  it("dispatch crash then retry: one pending row and 202 (B3)", async () => {
    const dir = await makeTempDir("acb-age96-fault-dispatch-");
    const parts = await openHarnessParts(dir);
    const bus = wireBus(parts);
    let dispatchCalls = 0;
    bus.setDispatchSink({
      enqueueInbound: async (message, conversation) => {
        dispatchCalls += 1;
        const entry: PendingInboundEntry = { message, conversation };
        await parts.storage.recordPendingInboundDelivery(
          deliveryRowFromEntry(entry, Date.now()),
        );
        parts.pendingInbound.push(entry);
        if (dispatchCalls === 1) {
          throw new Error("crash after dispatch");
        }
      },
    });
    const adapter = new CurlCommAdapter({
      token: TOKEN,
      accountId: ACCOUNT,
      project: PROJECT,
      agent: "claude",
      registrationId: REGISTRATION_ID,
      storage: parts.storage,
      receiptTtlMs: 60_000,
    });
    bus.registerComm(adapter);
    await adapter.start();
    const url = `http://127.0.0.1:${adapter.port}/messages`;
    try {
      const body = postBody({ idempotency_key: "fault-dispatch" });
      const first = await post(url, body);
      assert.equal(first.status, 500);
      const second = await post(url, body);
      assert.equal(second.status, 202);
      assert.equal(dispatchCalls, 1);
      assert.equal(parts.pendingInbound.length, 1);
    } finally {
      await adapter.stop();
      await parts.storage.close();
    }
  });

  it("receipt finalization crash then retry: 202 without duplicate effects (B3)", async () => {
    const dir = await makeTempDir("acb-age96-fault-accept-");
    const base = await openSqliteStorage(join(dir, "storage.db"));
    let acceptCalls = 0;
    const storage = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "acceptCurlInboundReceipt") {
          return async (...args: unknown[]) => {
            acceptCalls += 1;
            if (acceptCalls === 1) {
              throw new Error("crash before receipt finalize");
            }
            return Reflect.apply(
              target.acceptCurlInboundReceipt as (...a: unknown[]) => Promise<boolean>,
              target,
              args,
            );
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Storage;
    const harness = await startHarness(dir, { storage });
    try {
      const body = postBody({ idempotency_key: "fault-accept" });
      const first = await post(harness.url, body);
      assert.equal(first.status, 500);
      const second = await post(harness.url, body);
      assert.equal(second.status, 202);
      assert.equal(harness.audit.events.filter((e) => e.kind === "inbound_received").length, 1);
      assert.equal(harness.counters.dispatchCount, 1);
      const receipt = await base.getCurlInboundReceipt({
        registration_id: REGISTRATION_ID,
        sender_id: SENDER,
        client_key: "fault-accept",
      });
      assert.equal(receipt?.state, "accepted");
    } finally {
      await stopHarness(harness);
    }
  });
});

describe("AGE-96 curl query-consuming inbound (B4)", { concurrency: 1 }, () => {
  it("does not double-resolve or dispatch after resolveQuery crash before consume marker", async () => {
    const dir = await makeTempDir("acb-age96-query-");
    const base = await openSqliteStorage(join(dir, "storage.db"));
    let resolveCalls = 0;
    const proxied = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "resolveQuery") {
          return async (...args: unknown[]) => {
            resolveCalls += 1;
            const result = await Reflect.apply(
              target.resolveQuery as (...a: unknown[]) => Promise<boolean>,
              target,
              args,
            );
            if (resolveCalls === 1) {
              throw new Error("crash after resolveQuery before consume marker");
            }
            return result;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Storage;

    const harness = await startHarness(dir, { storage: proxied });
    const conversationId = "conv_query" as ConversationId;
    try {
      await harness.storage.upsertConversation({
        schema_version: SCHEMA_VERSION_CONVERSATION,
        project: PROJECT,
        comm: "curl",
        agent: "claude",
        account_label: "main",
        bot_user_id: String(ACCOUNT),
        registration_id: REGISTRATION_ID,
        chat_native_id: "curl:ci",
        thread_native_id: null,
        conversation_id: conversationId,
        created_at: 1,
        last_inbound_at: null,
        last_outbound_at: null,
        last_message_id: null,
      });
      await harness.storage.upsertSession({
        schema_version: SCHEMA_VERSION_SESSION,
        session_id: "sess-1" as SessionId,
        agent: "claude",
        project: PROJECT,
        created_at: 1,
        lease_holder_connection_id: null,
        lease_acquired_at: null,
        lease_released_at: null,
        lease_owner_process_pid: null,
        lease_owner_process_label: null,
        lease_owner_process_registered_at: null,
        lease_owner_daemon_discovery_root: null,
        lease_owner_daemon_checkout_root: null,
        lease_owner_daemon_state_root: null,
        lease_owner_daemon_bin: null,
        lease_owner_daemon_authority_rank: null,
        most_recent_inbound_conversation_id: null,
        account_label_scope: null,
        status: "active",
      });
      await harness.storage.insertQuery({
        schema_version: SCHEMA_VERSION_QUERY,
        query_id: "q_test" as QueryId,
        agent: "claude",
        session: "sess-1" as SessionId,
        kind: "approval",
        prompt_text: "approve?",
        created_at: 1,
        ttl_seconds: 300,
        origin_chat_id: conversationId,
        source_message_id: null,
        resolved_at: null,
        resolution: null,
        options_json: null,
      });

      const body = postBody({ idempotency_key: "query-key", text: "y" });
      const first = await post(harness.url, body);
      assert.equal(first.status, 500);
      assert.equal(resolveCalls, 1);
      assert.equal(harness.counters.dispatchCount, 0);

      const beforeRetry = resolveCalls;
      const second = await post(harness.url, body);
      assert.equal(second.status, 202);
      assert.equal(resolveCalls, beforeRetry);
      assert.equal(harness.counters.dispatchCount, 0);
      assert.equal(harness.pendingInbound.length, 0);

      const receipt = await base.getCurlInboundReceipt({
        registration_id: REGISTRATION_ID,
        sender_id: SENDER,
        client_key: "query-key",
      });
      assert.equal(receipt?.state, "accepted");
      assert.ok(receipt?.query_consumed_at);
      assert.equal(receipt?.planned_query_id, "q_test");

      const query = await base.getQuery("q_test" as QueryId);
      assert.ok(query?.resolved_at);
      assert.equal(harness.audit.events.filter((e) => e.kind === "inbound_received").length, 1);
    } finally {
      await stopHarness(harness);
    }
  });
});

describe("AGE-96 curl receipt privacy (F1)", { concurrency: 1 }, () => {
  it("stores no freetext answer or metadata in any receipt column", async () => {
    const answerText = "unique-freetext-answer-xyz";
    const metaSecret = "meta-secret-abc";
    const clientKey = "privacy-key";
    const dir = await makeTempDir("acb-age96-receipt-privacy-");
    const harness = await startHarness(dir);
    const conversationId = "conv_freetext" as ConversationId;
    try {
      await harness.storage.upsertConversation({
        schema_version: SCHEMA_VERSION_CONVERSATION,
        project: PROJECT,
        comm: "curl",
        agent: "claude",
        account_label: "main",
        bot_user_id: String(ACCOUNT),
        registration_id: REGISTRATION_ID,
        chat_native_id: "curl:ci",
        thread_native_id: null,
        conversation_id: conversationId,
        created_at: 1,
        last_inbound_at: null,
        last_outbound_at: null,
        last_message_id: null,
      });
      await harness.storage.upsertSession({
        schema_version: SCHEMA_VERSION_SESSION,
        session_id: "sess-privacy" as SessionId,
        agent: "claude",
        project: PROJECT,
        created_at: 1,
        lease_holder_connection_id: null,
        lease_acquired_at: null,
        lease_released_at: null,
        lease_owner_process_pid: null,
        lease_owner_process_label: null,
        lease_owner_process_registered_at: null,
        lease_owner_daemon_discovery_root: null,
        lease_owner_daemon_checkout_root: null,
        lease_owner_daemon_state_root: null,
        lease_owner_daemon_bin: null,
        lease_owner_daemon_authority_rank: null,
        most_recent_inbound_conversation_id: null,
        account_label_scope: null,
        status: "active",
      });
      await harness.storage.insertQuery({
        schema_version: SCHEMA_VERSION_QUERY,
        query_id: "q_freetext" as QueryId,
        agent: "claude",
        session: "sess-privacy" as SessionId,
        kind: "freetext",
        prompt_text: "describe the issue",
        created_at: 1,
        ttl_seconds: 300,
        origin_chat_id: conversationId,
        source_message_id: null,
        resolved_at: null,
        resolution: null,
        options_json: null,
      });

      const body = postBody({
        idempotency_key: clientKey,
        text: answerText,
        metadata: { note: metaSecret },
      });
      const response = await post(harness.url, body);
      assert.equal(response.status, 202);
      assert.equal(harness.counters.dispatchCount, 0);

      const receipt = await harness.storage.getCurlInboundReceipt({
        registration_id: REGISTRATION_ID,
        sender_id: SENDER,
        client_key: clientKey,
      });
      assert.equal(receipt?.planned_query_id, "q_freetext");
      assert.ok(receipt?.query_consumed_at);

      await harness.storage.close();
      const db = new DatabaseSync(join(dir, "storage.db"));
      const columns = db
        .prepare("PRAGMA table_info(curl_inbound_receipts)")
        .all() as Array<{ name: string }>;
      assert.equal(
        columns.some((col) => col.name === "planned_query_resolution_json"),
        false,
      );
      const row = db
        .prepare("SELECT * FROM curl_inbound_receipts WHERE client_key = ?")
        .get(clientKey) as Record<string, unknown>;
      const serialized = JSON.stringify(row);
      assert.equal(serialized.includes(answerText), false);
      assert.equal(serialized.includes(metaSecret), false);
      db.close();
    } finally {
      await harness.adapter.stop();
    }
  });
});
