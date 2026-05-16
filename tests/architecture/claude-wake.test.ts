import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ClaudeWakeRegistry,
  claudeWakeDirForProject,
  hashProjectKey,
} from "../../agents-comm-bus/src/adapters/agent/claude-wake.js";
import type { Conversation } from "../../agents-comm-bus-core/src/records/index.js";
import type { AgentId, CommId, ConversationId, MessageId, SessionId } from "../../agents-comm-bus-core/src/types.js";

describe("Claude wake path", () => {
  it("derives the same project wake key shape used by Claude hooks", () => {
    const project = path.resolve("D:/work/example-project");
    const home = path.resolve("D:/home");

    assert.equal(hashProjectKey(project).length, 8);
    assert.equal(
      claudeWakeDirForProject(project, home),
      path.join(
        home,
        ".agents-comm-bus",
        "claude-wake",
        "sessions",
        `${path.basename(project)}-${hashProjectKey(project)}`,
      ),
    );
  });

  it("writes trigger-enter for the latest registered Claude session after durable dispatch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-wake-test-"));
    const wakeDir = path.join(root, "wake");
    const registry = new ClaudeWakeRegistry(() => 1234);
    registry.register({
      session: "session-1" as SessionId,
      project: "project-a",
      wakeDir,
    });

    assert.equal(await registry.wakeConversation(conversation({ project: "project-a" })), true);
    assert.equal((await readFile(path.join(wakeDir, "trigger-enter"), "utf8")).trim(), "1234");
  });

  it("does not wake for query-consumed or non-Claude dispatch paths", async () => {
    const registry = new ClaudeWakeRegistry(() => 1234);
    registry.register({
      session: "session-1" as SessionId,
      project: "project-a",
      wakeDir: path.join(os.tmpdir(), "unused-wake-dir"),
    });

    assert.equal(
      await registry.wakeConversation(conversation({
        project: "project-a",
        agent: "codex" as AgentId,
      })),
      false,
    );
    assert.equal(await registry.wakeConversation(conversation({ project: "project-b" })), false);
  });
});

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    schema_version: 1,
    project: "project-a",
    comm: "telegram" as CommId,
    account_label: "main",
    chat_native_id: "chat-1",
    thread_native_id: null,
    conversation_id: "conversation-1" as ConversationId,
    agent: "claude" as AgentId,
    last_inbound_at: 1,
    last_outbound_at: null,
    last_message_id: "telegram:1" as MessageId,
    created_at: 1,
    metadata: null,
    ...overrides,
  };
}
