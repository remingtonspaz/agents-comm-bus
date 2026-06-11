import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  CurlCommAdapter,
  curlEndpointFilePath,
  isAuthorizedCurlRequest,
  parseCurlPostBody,
  sanitizeAccountIdForPath,
  syntheticChatNativeId,
} from "../../adapters/curl/adapter.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type {
  AccountId,
  AgentId,
  AuditEvent,
  CommId,
  Conversation,
  FilterDropEvent,
  InboundAcceptance,
  Message,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";

registerTempDirCleanup();

const ACCOUNT = "curl:local" as AccountId;
const PROJECT = normalizeProjectPath("/repo");
const TOKEN = "s3cret-token";

class RecordingAuditStore {
  readonly events: AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

function makeAdapter(overrides: Partial<ConstructorParameters<typeof CurlCommAdapter>[0]> = {}) {
  return new CurlCommAdapter({
    token: TOKEN,
    accountId: ACCOUNT,
    project: PROJECT,
    agent: "claude",
    ...overrides,
  });
}

interface StartedAdapter {
  adapter: CurlCommAdapter;
  url: string;
  received: Message[];
  drops: FilterDropEvent[];
}

async function startAdapter(
  overrides: Partial<ConstructorParameters<typeof CurlCommAdapter>[0]> = {},
  handler?: (msg: Message) => Promise<void | InboundAcceptance>,
): Promise<StartedAdapter> {
  const adapter = makeAdapter(overrides);
  const received: Message[] = [];
  const drops: FilterDropEvent[] = [];
  adapter.onInbound(async (msg) => {
    received.push(msg);
    return handler ? handler(msg) : { conversation_id: "conv_fixture" };
  });
  adapter.onFilterDrop((event) => drops.push(event));
  await adapter.start();
  return {
    adapter,
    url: `http://127.0.0.1:${adapter.port}/messages`,
    received,
    drops,
  };
}

function postBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: PROJECT,
    agent: "claude",
    sender_id: "ci",
    text: "build green",
    ...overrides,
  };
}

async function post(
  url: string,
  body: unknown,
  options: { token?: string | null } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("curl adapter pure helpers", () => {
  it("derives a deterministic synthetic conversation key from the sender", () => {
    assert.equal(syntheticChatNativeId("ci"), "curl:ci");
    assert.equal(syntheticChatNativeId("ci"), syntheticChatNativeId("ci"));
  });

  it("sanitizes account ids for filesystem paths", () => {
    assert.equal(sanitizeAccountIdForPath("curl:local"), "curl-local");
    assert.equal(sanitizeAccountIdForPath("a b/c\\d"), "a-b-c-d");
  });

  it("validates POST bodies field by field", () => {
    assert.deepEqual(parseCurlPostBody(null), { error: "body must be a JSON object" });
    assert.ok("error" in parseCurlPostBody({ project: PROJECT, agent: "claude", sender_id: "ci" }));
    assert.ok("error" in parseCurlPostBody(postBody({ text: "  " })));
    assert.ok("error" in parseCurlPostBody(postBody({ chat_native_id: 5 })));
    assert.ok("error" in parseCurlPostBody(postBody({ metadata: ["not-an-object"] })));
    const parsed = parseCurlPostBody(postBody({ chat_native_id: "bin-1", metadata: { run: 7 } }));
    if (!("body" in parsed)) throw new Error(`expected parsed body, got ${parsed.error}`);
    assert.equal(parsed.body.chat_native_id, "bin-1");
    assert.deepEqual(parsed.body.metadata, { run: 7 });
  });

  it("authorizes only the exact bearer token", () => {
    assert.equal(isAuthorizedCurlRequest(`Bearer ${TOKEN}`, TOKEN), true);
    assert.equal(isAuthorizedCurlRequest(`Bearer ${TOKEN}x`, TOKEN), false);
    assert.equal(isAuthorizedCurlRequest(TOKEN, TOKEN), false);
    assert.equal(isAuthorizedCurlRequest(undefined, TOKEN), false);
  });
});

describe("curl adapter HTTP ingress", () => {
  it("accepts an authorized POST and dispatches a normal inbound Message", async () => {
    const { adapter, url, received } = await startAdapter();
    try {
      const { status, json } = await post(url, postBody({ metadata: { run: 42 } }));
      assert.equal(status, 202);
      assert.equal(json.ok, true);
      assert.match(String(json.message_id), /^curl:/);
      assert.equal(json.conversation_id, "conv_fixture");
      assert.equal(json.chat_native_id, "curl:ci");

      assert.equal(received.length, 1);
      const message = received[0]!;
      assert.equal(message.chat.comm, "curl");
      assert.equal(message.chat.account, ACCOUNT);
      assert.equal(message.chat.chat_native_id, "curl:ci");
      assert.equal(message.sender.id, "ci");
      assert.equal(message.sender.isBot, false);
      assert.equal(message.sender.isForeignBot, false);
      assert.equal(message.text, "build green");
      assert.equal(message.hop_count, 0);
      assert.deepEqual(
        (message as Message & { metadata?: Record<string, unknown> }).metadata,
        { run: 42 },
      );
    } finally {
      await adapter.stop();
    }
  });

  it("stabilizes the default synthetic conversation per sender and honors explicit chat_native_id", async () => {
    const { adapter, url, received } = await startAdapter();
    try {
      const first = await post(url, postBody());
      const second = await post(url, postBody({ text: "again" }));
      assert.equal(first.json.chat_native_id, second.json.chat_native_id);

      const binned = await post(url, postBody({ chat_native_id: "heartbeats" }));
      assert.equal(binned.json.chat_native_id, "heartbeats");
      assert.equal(received[2]!.chat.chat_native_id, "heartbeats");
    } finally {
      await adapter.stop();
    }
  });

  it("rejects unauthorized POSTs with 401 and emits an audited filter drop", async () => {
    const { adapter, url, received, drops } = await startAdapter();
    try {
      const missing = await post(url, postBody(), { token: null });
      assert.equal(missing.status, 401);
      const wrong = await post(url, postBody(), { token: "wrong-token" });
      assert.equal(wrong.status, 401);
      assert.equal(received.length, 0);
      assert.equal(drops.length, 2);
      assert.ok(drops.every((drop) => drop.reason === "unauthorized"));
    } finally {
      await adapter.stop();
    }
  });

  it("enforces the sender allowlist when configured", async () => {
    const { adapter, url, received, drops } = await startAdapter({ allowedSenderIds: ["ci"] });
    try {
      const denied = await post(url, postBody({ sender_id: "stranger" }));
      assert.equal(denied.status, 403);
      assert.equal(drops.length, 1);
      assert.equal(drops[0]!.reason, "sender_not_allowed");
      assert.equal(drops[0]!.sender_id, "stranger");

      const allowed = await post(url, postBody());
      assert.equal(allowed.status, 202);
      assert.equal(received.length, 1);
    } finally {
      await adapter.stop();
    }
  });

  it("refreshes the allowlist via updateAllowedSenderIds without a restart", async () => {
    const { adapter, url } = await startAdapter({ allowedSenderIds: ["ci"] });
    try {
      adapter.updateAllowedSenderIds(["other"]);
      const denied = await post(url, postBody());
      assert.equal(denied.status, 403);
      adapter.updateAllowedSenderIds(["ci"]);
      const allowed = await post(url, postBody());
      assert.equal(allowed.status, 202);
    } finally {
      await adapter.stop();
    }
  });

  it("404s a POST whose project/agent does not match the served scope", async () => {
    const { adapter, url, received } = await startAdapter();
    try {
      const wrongProject = await post(url, postBody({ project: "/other" }));
      assert.equal(wrongProject.status, 404);
      assert.match(String(wrongProject.json.error), /serves project=/);

      const wrongAgent = await post(url, postBody({ agent: "codex" }));
      assert.equal(wrongAgent.status, 404);
      assert.equal(received.length, 0);

      // Separator/casing drift that canonicalizes to the served project passes.
      const drifted = await post(url, postBody({ project: PROJECT.replace(/\\/g, "/") }));
      assert.equal(drifted.status, 202);
    } finally {
      await adapter.stop();
    }
  });

  it("rejects malformed requests with actionable statuses", async () => {
    const { adapter } = await startAdapter();
    const base = `http://127.0.0.1:${adapter.port}`;
    try {
      const wrongPath = await fetch(`${base}/nope`, { method: "POST" });
      assert.equal(wrongPath.status, 404);

      const wrongMethod = await fetch(`${base}/messages`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(wrongMethod.status, 405);

      const badJson = await post(`${base}/messages`, "{not json");
      assert.equal(badJson.status, 400);

      const missingField = await post(`${base}/messages`, { project: PROJECT, agent: "claude" });
      assert.equal(missingField.status, 400);
    } finally {
      await adapter.stop();
    }
  });

  it("writes the endpoint discovery file on start and removes it on stop", async () => {
    const stateRoot = await makeTempDir("acb-curl-state-");
    const { adapter } = await startAdapter({ stateRoot });
    const endpointPath = curlEndpointFilePath(stateRoot, String(ACCOUNT));
    try {
      const endpoint = JSON.parse(await readFile(endpointPath, "utf8")) as Record<string, unknown>;
      assert.equal(endpoint.port, adapter.port);
      assert.equal(endpoint.agent, "claude");
      assert.equal(endpoint.url, `http://127.0.0.1:${adapter.port}/messages`);
    } finally {
      await adapter.stop();
    }
    await assert.rejects(() => stat(endpointPath));
  });

  it("rejects outbound send loudly — the curl comm is inbound-only", async () => {
    const adapter = makeAdapter();
    await assert.rejects(
      () =>
        adapter.send(
          { comm: "curl" as CommId, account: ACCOUNT, chat_native_id: "curl:ci" },
          { text: "nope" },
          "idem-1",
        ),
      /inbound-only/,
    );
    assert.equal(adapter.classifyFailure(), "permanent");
  });
});

describe("curl adapter through the MessageBus", () => {
  it("reuses transcript/audit/dispatch and echoes the canonical conversation_id", async () => {
    const dir = await makeTempDir("acb-curl-bus-");
    const storage = await openSqliteStorage(join(dir, "storage.db"));
    const transcripts = new JsonlTranscriptStore(dir);
    const audit = new RecordingAuditStore();
    const adapter = makeAdapter();
    try {
      await storage.putAccountRegistration({
        schema_version: SCHEMA_VERSION_ACCOUNT,
        registration_id: "reg-curl-1",
        project: PROJECT,
        comm: "curl" as CommId,
        agent: "claude" as AgentId,
        account_label: "main",
        bot_user_id: String(ACCOUNT),
        credentials_ref: "file:/dev/null",
        created_at: 1,
        updated_at: 1,
      });

      const bus = new MessageBus({
        project: PROJECT,
        storage,
        transcripts,
        audit,
        now: () => 2000,
      });
      const dispatched: Array<{ message: Message; conversation: Conversation }> = [];
      bus.setDispatchSink({
        enqueueInbound: async (message, conversation) => {
          dispatched.push({ message, conversation });
        },
      });
      bus.registerComm(adapter);
      await adapter.start();

      const url = `http://127.0.0.1:${adapter.port}/messages`;
      const accepted = await post(url, postBody());
      assert.equal(accepted.status, 202);
      assert.match(String(accepted.json.conversation_id), /^conv_/);

      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0]!.conversation.conversation_id, accepted.json.conversation_id);
      assert.equal(dispatched[0]!.conversation.comm, "curl");
      assert.equal(dispatched[0]!.conversation.chat_native_id, "curl:ci");

      const stored = await storage.getConversation(
        String(accepted.json.conversation_id) as Conversation["conversation_id"],
      );
      assert.ok(stored, "conversation persisted");

      assert.ok(audit.events.some((event) => event.kind === "inbound_received"));

      // A second POST from the same sender bins into the same conversation.
      const again = await post(url, postBody({ text: "another" }));
      assert.equal(again.json.conversation_id, accepted.json.conversation_id);

      // Unauthorized POSTs surface as audited inbound_filter_drop via bus wiring.
      const denied = await post(url, postBody(), { token: "wrong" });
      assert.equal(denied.status, 401);
      const dropEvents = audit.events.filter((event) => event.kind === "inbound_filter_drop");
      assert.equal(dropEvents.length, 1);
      assert.equal((dropEvents[0]!.detail as Record<string, unknown>).reason, "unauthorized");
    } finally {
      await adapter.stop();
      await storage.close();
    }
  });
});
