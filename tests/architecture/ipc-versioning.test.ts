import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { connectIpc } from "../../core-daemon/ipc/client.js";
import { startIpcServer } from "../../core-daemon/ipc/server.js";

describe("agents-comm-bus IPC version handshake", () => {
  it("accepts compatible protocol versions and returns daemon diagnostics", async () => {
    const server = await startIpcServer({
      protocolVersion: "1.2.0",
      daemonVersion: "0.1.0-test",
      metadata: { stateRoot: "test-root" },
    });

    try {
      const client = await connectIpc({
        port: server.port,
        protocolVersion: "1.0.0",
        clientVersion: "shim-test",
        metadata: { pluginInstanceId: "plugin-1", shimName: "claude-hook" },
      });

      assert.equal(client.hello.protocolVersion, "1.2.0");
      assert.equal(client.hello.daemonVersion, "0.1.0-test");
      assert.equal(client.hello.metadata.stateRoot, "test-root");
      client.close();
    } finally {
      await server.close();
    }
  });

  it("fails loudly when protocol major versions are incompatible", async () => {
    const server = await startIpcServer({
      protocolVersion: "2.0.0",
      daemonVersion: "0.2.0-test",
    });

    try {
      await assert.rejects(
        connectIpc({
          port: server.port,
          protocolVersion: "1.0.0",
          clientVersion: "old-shim",
        }),
        /IPC protocol mismatch: daemon supports 2\.0\.0, client requested 1\.0\.0/,
      );
    } finally {
      await server.close();
    }
  });
});
