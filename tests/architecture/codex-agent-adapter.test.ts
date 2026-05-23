import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CodexAgentAdapter,
  codexDecisionFromResolution,
} from "../../core-daemon/adapters/agent/codex/adapter.js";
import type {
  ChatRef,
  ControlChannel,
  Message,
  QueryChannel,
  ResolvedDecision,
} from "../../packages/core-contracts/src/index.js";
import type {
  AccountId,
  AgentId,
  CommId,
  MessageId,
  QueryId,
  SessionId,
} from "../../packages/core-contracts/src/types.js";

describe("CodexAgentAdapter", () => {
  it("implements the agent contract shape and explicit Codex capabilities", async () => {
    const adapter = new CodexAgentAdapter({ appServerClientFactory: () => new FakeCodexClient() });
    const control = new RecordingControlChannel();

    assert.equal(adapter.id, "codex");
    assert.deepEqual(adapter.capabilities, {
      canWake: true,
      canSteer: true,
      canInterrupt: false,
      midTurnPolicy: "steer",
      supportedQueryKinds: ["approval"],
    });
    assert.equal(typeof adapter.connect, "function");
    assert.equal(typeof adapter.disconnect, "function");
    assert.equal(typeof adapter.deliverInbound, "function");
    assert.equal(typeof adapter.openQuery, "function");
    assert.equal(typeof adapter.wake, "function");
    assert.equal(typeof adapter.steer, "function");
    assert.equal(typeof adapter.interrupt, "function");

    await adapter.connect("session-1" as SessionId, control);
    assert.equal(control.sent[0]?.type, "agent.connected");
  });

  it("keeps Codex wake and steer behavior behind the adapter", async () => {
    const fake = new FakeCodexClient();
    const adapter = new CodexAgentAdapter({
      appServerClientFactory: () => fake,
      wakePlaceholder: ".",
    });
    const control = new RecordingControlChannel();
    const session = "session-1" as SessionId;
    await adapter.connect(session, control);

    await adapter.deliverInbound(session, message());
    await adapter.wake(session);
    await adapter.steer(session, { text: "new Telegram guidance" });

    assert.equal(control.sent.at(-3)?.type, "inbound.queued");
    assert.equal(control.sent.at(-2)?.type, "turn.wake");
    assert.equal(control.sent.at(-1)?.type, "turn.steer");
    assert.deepEqual(fake.calls, [
      ["turn/start", "."],
      ["turn/steer", "new Telegram guidance"],
    ]);
    assert.equal(adapter.drainQueuedInbound(session).length, 1);
  });

  it("tries steering before falling back to a wake turn", async () => {
    const fake = new FakeCodexClient({ steerOk: false });
    const adapter = new CodexAgentAdapter({
      appServerClientFactory: () => fake,
      wakePlaceholder: ".",
    });
    const control = new RecordingControlChannel();
    const session = "session-1" as SessionId;
    await adapter.connect(session, control);

    const result = await adapter.wakeOrSteer(session, { text: "new Telegram guidance" });

    assert.deepEqual(result, { ok: true, threadId: "thread-1", method: "turn/start" });
    assert.equal(control.sent.at(-2)?.type, "turn.steer");
    assert.equal(control.sent.at(-1)?.type, "turn.wake");
    assert.deepEqual(fake.calls, [
      ["turn/steer", "new Telegram guidance"],
      ["turn/start", "."],
    ]);
  });

  it("opens only approval queries for Codex permission hooks", async () => {
    const adapter = fixedAdapter();
    const control = new RecordingControlChannel();
    const queryChannel = new RecordingQueryChannel();
    const session = "session-1" as SessionId;
    await adapter.connect(session, control);
    const { query } = adapter.mapHookPayloadToQuery(session, {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    await adapter.openQuery(session, query, queryChannel);

    assert.equal(query.kind, "approval");
    assert.equal(query.prompt_text, "Codex requests permission to run Bash: npm test");
    assert.equal(query.query_id, "query-fixed");
    assert.equal(query.created_at, 1000);
    assert.equal(query.ttl_seconds, 60);
    assert.equal(queryChannel.sent[0]?.type, "query.opened");
    assert.equal(control.sent.at(-1)?.type, "query.opened");
  });

  it("rejects unsupported query kinds", async () => {
    const adapter = fixedAdapter();
    const control = new RecordingControlChannel();
    await adapter.connect("session-1" as SessionId, control);
    const { query } = adapter.mapHookPayloadToQuery("session-1" as SessionId, {
      tool_name: "Bash",
    });

    await assert.rejects(
      adapter.openQuery(
        "session-1" as SessionId,
        { ...query, kind: "choice" },
        new RecordingQueryChannel(),
      ),
      /does not support query kind/,
    );
  });

  it("translates Telegram decisions to Codex hook decisions", () => {
    assert.deepEqual(
      codexDecisionFromResolution(decision("allow")),
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      },
    );
    assert.deepEqual(
      codexDecisionFromResolution(decision("always_allow")),
      {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      },
    );
    assert.equal(
      codexDecisionFromResolution(decision("deny")).hookSpecificOutput.decision.behavior,
      "deny",
    );
  });
});

function fixedAdapter(): CodexAgentAdapter {
  return new CodexAgentAdapter({
    now: () => 1000,
    defaultTtlSeconds: 60,
    queryIdFactory: () => "query-fixed" as QueryId,
    appServerClientFactory: () => new FakeCodexClient(),
  });
}

function decision(decisionValue: ResolvedDecision["decision"]): ResolvedDecision {
  return {
    query_id: "query-fixed" as QueryId,
    decision: decisionValue,
    decided_by_sender_id: "user-1",
    decided_in_chat: chat(),
    decided_at: 2000,
  };
}

function message(): Message {
  return {
    schema_version: 1,
    message_id: "telegram:1" as MessageId,
    chat: chat(),
    sender: {
      id: "user-1",
      isBot: false,
      isForeignBot: false,
    },
    origin: { comm: "telegram" as CommId },
    text: "hello",
    hop_count: 0,
    received_at: 1000,
  };
}

function chat(): ChatRef {
  return {
    comm: "telegram" as CommId,
    account: "bot-1" as AccountId,
    chat_native_id: "chat-1",
  };
}

class FakeCodexClient {
  readonly calls: Array<[string, string]> = [];

  constructor(private readonly options: { steerOk?: boolean } = {}) {}

  async call(): Promise<unknown> {
    return {};
  }

  async listLoadedThreads(): Promise<unknown> {
    return { data: ["thread-1"] };
  }

  async startTurn(_threadId: string, text: string): Promise<unknown> {
    this.calls.push(["turn/start", text]);
    return {};
  }

  async steerTurn(_threadId: string, text: string): Promise<unknown> {
    this.calls.push(["turn/steer", text]);
    return {};
  }

  async wakeMostRecentThread(text = "."): Promise<any> {
    await this.startTurn("thread-1", text);
    return { ok: true, threadId: "thread-1", method: "turn/start" };
  }

  async steerMostRecentThread(text: string): Promise<any> {
    await this.steerTurn("thread-1", text);
    if (this.options.steerOk === false) {
      return { ok: false, reason: "steerTurn-failed", error: "no active turn", threadId: "thread-1" };
    }
    return { ok: true, threadId: "thread-1", method: "turn/steer" };
  }
}

class RecordingControlChannel implements ControlChannel {
  readonly sent: any[] = [];
  private closeHandler: (() => void) | null = null;

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  async send(envelope: unknown): Promise<void> {
    this.sent.push(envelope);
  }

  close(): void {
    this.closeHandler?.();
  }
}

class RecordingQueryChannel extends RecordingControlChannel implements QueryChannel {
  async awaitResolution(): Promise<ResolvedDecision> {
    return decision("allow");
  }
}
