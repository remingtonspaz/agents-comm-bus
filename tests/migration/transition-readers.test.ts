import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  discoverLegacyInputs,
  legacySessionDirForProject,
  TRANSITION_CLEANUP_RELEASE,
  TRANSITION_ONLY_MARKER,
} from "../../core-daemon/migrations/legacy-readers.js";

describe("transition legacy readers", () => {
  it("discovers project credentials and legacy state without exposing bot tokens", () => {
    const root = mkdtempSync(join(tmpdir(), "acb-migration-"));
    const project = join(root, "project");
    const home = join(root, "home");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", "telegram.json"), JSON.stringify({ botToken: "secret-token", userId: [123, "456"] }));

    const sessionDir = legacySessionDirForProject(project, "claude", home);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "last-chat.json"), JSON.stringify({
      chat_id: 999,
      message_thread_id: 42,
      from_user_id: 123,
      updated_at: "2026-05-15T12:00:00.000Z",
    }));
    writeFileSync(join(sessionDir, "pending-permission.json"), JSON.stringify({
      timestamp: "2026-05-15T12:00:00.000Z",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      prompt_type: "permission",
      chat_id: 999,
    }));
    writeFileSync(join(sessionDir, "queue.json"), JSON.stringify({
      messages: [{ id: 10, timestamp: Date.parse("2026-05-15T12:00:30.000Z"), text: "hello", from: "User", chatId: 999 }],
    }));

    const result = discoverLegacyInputs({ projectRoot: project, homeDir: home, now: Date.parse("2026-05-15T12:01:00.000Z") });

    assert.equal(result.credentials.length, 1);
    assert.equal(result.credentials[0].hasBotToken, true);
    assert.equal(result.credentials[0].transition, TRANSITION_ONLY_MARKER);
    assert.equal(result.credentials[0].cleanupRelease, TRANSITION_CLEANUP_RELEASE);
    assert.deepEqual(result.credentials[0].userIds, ["123", "456"]);
    assert.equal(JSON.stringify(result).includes("secret-token"), false);
    assert.equal(result.sessionRoots.length, 1);
    assert.equal(result.sessionRoots[0].expectedForProject, true);
    assert.equal(result.lastChats[0].value.chat_id, "999");
    assert.equal(result.pendingPermissions[0].value.tool_name, "Bash");
    assert.equal(result.queues[0].value[0].text, "hello");
  });

  it("skips expired pending permissions with a transition marker", () => {
    const root = mkdtempSync(join(tmpdir(), "acb-migration-expired-"));
    const project = join(root, "project");
    const home = join(root, "home");
    const sessionDir = legacySessionDirForProject(project, "codex", home);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "pending-permission.json"), JSON.stringify({
      timestamp: "2026-05-15T12:00:00.000Z",
      tool_name: "Bash",
    }));

    const result = discoverLegacyInputs({ projectRoot: project, homeDir: home, now: Date.parse("2026-05-15T12:10:00.000Z") });

    assert.equal(result.pendingPermissions.length, 0);
    assert.equal(result.skipped.some((item) => item.kind === "pending-permission" && item.reason.includes("expired")), true);
    assert.equal(result.skipped[0].transition, TRANSITION_ONLY_MARKER);
  });
});
