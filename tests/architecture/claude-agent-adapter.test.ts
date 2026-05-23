import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ClaudeAgentAdapter,
  claudeDecisionFromResolution,
} from "../../core-daemon/bridges/claude/adapter.js";
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

describe("ClaudeAgentAdapter", () => {
  it("implements the agent contract shape and explicit Claude capabilities", async () => {
    const adapter = new ClaudeAgentAdapter();
    const control = new RecordingControlChannel();

    assert.equal(adapter.id, "claude");
    assert.deepEqual(adapter.capabilities, {
      canWake: true,
      canSteer: false,
      canInterrupt: false,
      midTurnPolicy: "queue",
      supportedQueryKinds: ["approval", "choice", "freetext"],
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

  it("queues inbound messages and keeps wake behavior behind the adapter", async () => {
    const woken: SessionId[] = [];
    const adapter = new ClaudeAgentAdapter({
      wakeSession: async (session) => {
        woken.push(session);
      },
    });
    const control = new RecordingControlChannel();
    const session = "session-1" as SessionId;
    await adapter.connect(session, control);

    await adapter.deliverInbound(session, message());
    await adapter.wake(session);

    assert.equal(control.sent.at(-2)?.type, "inbound.queued");
    assert.equal(control.sent.at(-1)?.type, "turn.wake");
    assert.equal(adapter.drainQueuedInbound(session).length, 1);
    assert.deepEqual(woken, [session]);
  });

  it("opens a query channel and announces the query on the control channel", async () => {
    const adapter = new ClaudeAgentAdapter({
      now: () => 42,
      queryIdFactory: () => "query-1" as QueryId,
    });
    const control = new RecordingControlChannel();
    const queryChannel = new RecordingQueryChannel();
    const session = "session-1" as SessionId;
    await adapter.connect(session, control);
    const { query } = adapter.mapHookPayloadToQuery(session, {
      tool_name: "ExitPlanMode",
    });

    await adapter.openQuery(session, query, queryChannel);

    assert.equal(queryChannel.sent[0]?.type, "query.opened");
    assert.equal(queryChannel.sent[0]?.query.kind, "approval");
    assert.equal(control.sent.at(-1)?.type, "query.opened");
    assert.equal(control.sent.at(-1)?.query_id, "query-1");
  });

  it("maps PermissionRequest hooks to approval queries with metadata", () => {
    const adapter = fixedAdapter();

    const mapped = adapter.mapHookPayloadToQuery("session-1" as SessionId, {
      hook_event_name: "PermissionRequest",
      session_id: "claude-native-session",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    assert.equal(mapped.query.kind, "approval");
    assert.equal(mapped.query.prompt_text, "Claude requests permission to run Bash: npm test");
    assert.equal(mapped.query.query_id, "query-fixed");
    assert.equal(mapped.query.created_at, 1000);
    assert.equal(mapped.query.ttl_seconds, 60);
    assert.deepEqual(mapped.metadata, {
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      prompt_type: "permission",
      claude_session_id: "claude-native-session",
      question_index: undefined,
    });
  });

  it("maps AskUserQuestion hooks to choice queries", () => {
    const adapter = fixedAdapter();

    const mapped = adapter.mapHookPayloadToQuery("session-1" as SessionId, {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which branch should I deploy?",
          options: [
            { label: "main", description: "Production" },
            { label: "release", description: "Staging" },
          ],
        }],
      },
    });

    assert.equal(mapped.query.kind, "choice");
    assert.equal(mapped.query.prompt_text, "Which branch should I deploy?");
    assert.deepEqual(mapped.query.options, ["main", "release"]);
    assert.equal(mapped.metadata.prompt_type, "question");
    assert.equal(mapped.metadata.question_index, 0);
  });

  it("maps AskUserQuestion without options to freetext queries", () => {
    const adapter = fixedAdapter();

    const mapped = adapter.mapHookPayloadToQuery("session-1" as SessionId, {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{ question: "What should I name this release?" }],
      },
    });

    assert.equal(mapped.query.kind, "freetext");
    assert.equal(mapped.query.prompt_text, "What should I name this release?");
    assert.equal(mapped.query.options, undefined);
    assert.equal(mapped.metadata.prompt_type, "question");
  });

  it("maps ExitPlanMode and EnterPlanMode hooks to approval queries", () => {
    const adapter = fixedAdapter();

    const exitPlan = adapter.mapHookPayloadToQuery("session-1" as SessionId, {
      tool_name: "ExitPlanMode",
    });
    const enterPlan = adapter.mapHookPayloadToQuery("session-1" as SessionId, {
      tool_name: "EnterPlanMode",
    });

    assert.equal(exitPlan.query.kind, "approval");
    assert.equal(exitPlan.metadata.prompt_type, "plan_approval");
    assert.match(exitPlan.query.prompt_text, /finished planning/);
    assert.equal(enterPlan.query.kind, "approval");
    assert.equal(enterPlan.metadata.prompt_type, "plan_entry");
    assert.match(enterPlan.query.prompt_text, /plan mode/);
  });

  it("translates approval resolutions back to Claude hook decisions", () => {
    const adapter = fixedAdapter();
    const { query } = adapter.mapHookPayloadToQuery("session-1" as SessionId, {
      tool_name: "Bash",
    });

    assert.deepEqual(
      claudeDecisionFromResolution(query, decision("allow")),
      { decision: { behavior: "allow" } },
    );
    assert.deepEqual(
      claudeDecisionFromResolution(query, decision("deny")),
      { decision: { behavior: "deny" } },
    );
  });
});

function fixedAdapter(): ClaudeAgentAdapter {
  return new ClaudeAgentAdapter({
    now: () => 1000,
    defaultTtlSeconds: 60,
    queryIdFactory: () => "query-fixed" as QueryId,
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
