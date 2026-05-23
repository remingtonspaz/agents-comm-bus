import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import { WebSocketCodexAppServerClient } from "../../core-daemon/adapters/agent/codex/app-server.js";

describe("Codex app-server turn control", () => {
  const seenMethods: string[] = [];
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected local WebSocket server address");
  }
  const client = new WebSocketCodexAppServerClient(`ws://127.0.0.1:${address.port}`);

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      if (request.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
        return;
      }
      seenMethods.push(request.method);
      if (request.method === "thread/loaded/list") {
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { data: ["thread-1"] },
        }));
        return;
      }
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }));
    });
  });

  after(() => {
    server.close();
  });

  it("uses turn/start for wake and turn/steer for mid-turn steering", async () => {
    const wake = await client.wakeMostRecentThread(".");
    const steer = await client.steerMostRecentThread("telegram guidance");

    assert.deepEqual(wake, { ok: true, threadId: "thread-1", method: "turn/start" });
    assert.deepEqual(steer, { ok: true, threadId: "thread-1", method: "turn/steer" });
    assert.deepEqual(seenMethods, [
      "thread/loaded/list",
      "turn/start",
      "thread/loaded/list",
      "turn/steer",
    ]);
  });
});
