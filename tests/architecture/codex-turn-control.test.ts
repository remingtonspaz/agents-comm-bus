import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import {
  WebSocketCodexAppServerClient,
  type CodexRecordedTarget,
} from "../../core-daemon/bridges/codex/app-server.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";

const PROJECT = normalizeProjectPath("D:\\tmp\\project-a");

describe("Codex app-server turn control", () => {
  const seenMethods: string[] = [];
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected local WebSocket server address");
  }
  const client = new WebSocketCodexAppServerClient(`ws://127.0.0.1:${address.port}`);
  const target: CodexRecordedTarget = {
    threadId: "thread-1",
    expectedProject: PROJECT,
  };

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      if (request.method === "initialize") {
        assert.equal(request.params?.capabilities?.experimentalApi, true);
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
        return;
      }
      seenMethods.push(request.method);
      if (request.method === "thread/list") {
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            data: [{
              id: "thread-1",
              cwd: PROJECT,
              status: { type: "active" },
            }],
          },
        }));
        return;
      }
      if (request.method === "thread/turns/list") {
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { data: [{ id: "turn-1", status: "inProgress" }] },
        }));
        return;
      }
      if (request.method === "turn/steer") {
        assert.equal(request.params?.expectedTurnId, "turn-1");
      }
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }));
    });
  });

  after(() => {
    server.close();
  });

  it("uses turn/start for wake and turn/steer for mid-turn steering", async () => {
    const wake = await client.wakeRecordedTarget(target, ".");
    const steer = await client.steerRecordedTarget(target, "telegram guidance");

    assert.deepEqual(wake, { ok: true, threadId: "thread-1", method: "turn/start" });
    assert.deepEqual(steer, { ok: true, threadId: "thread-1", method: "turn/steer" });
    assert.ok(!seenMethods.includes("thread/loaded/list"));
    assert.deepEqual(seenMethods, [
      "thread/list",
      "turn/start",
      "thread/list",
      "thread/turns/list",
      "turn/steer",
    ]);
  });
});
