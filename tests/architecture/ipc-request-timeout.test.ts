import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

import { IPC_HOST } from "../../core-daemon/config.js";
import {
  DEFAULT_IPC_REQUEST_TIMEOUT_MS,
  IpcRequestTimeoutError,
  connectIpc,
} from "../../core-daemon/ipc/client.js";
import { startIpcServer } from "../../core-daemon/ipc/server.js";

async function startSilentSocketServer(): Promise<{ port: number; close(): Promise<void> }> {
  const server = new WebSocketServer({ host: IPC_HOST, port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test socket server did not bind to a TCP port");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("agents-comm-bus IPC request timeout", () => {
  it("exports a conservative default at least as long as Codex permission poll cap", () => {
    assert.ok(DEFAULT_IPC_REQUEST_TIMEOUT_MS >= 9 * 60 * 1_000);
  });

  it("rejects hung requests with a distinct actionable timeout error", async () => {
    const server = await startIpcServer({
      onRequest: async (request) => {
        if (request.method === "hang") {
          await new Promise(() => {});
        }
        return { ok: true };
      },
    });

    try {
      const client = await connectIpc({
        port: server.port,
        clientVersion: "ipc-timeout-test",
        requestTimeoutMs: 40,
      });

      await assert.rejects(
        client.request("hang"),
        (error: unknown) => {
          assert.ok(error instanceof IpcRequestTimeoutError);
          assert.match(error.message, /timed out after 40ms/);
          assert.equal(error.method, "hang");
          assert.match(error.message, /daemon may be hung/);
          return true;
        },
      );
      client.close();
    } finally {
      await server.close();
    }
  });

  it("clears the request timer when a matching response arrives", async () => {
    const server = await startIpcServer({
      onRequest: async (request) => ({ echo: request.method }),
    });

    try {
      const client = await connectIpc({
        port: server.port,
        clientVersion: "ipc-timeout-test",
        requestTimeoutMs: 50,
      });

      const result = await client.request("ping");
      assert.deepEqual(result, { echo: "ping" });

      await new Promise((resolve) => setTimeout(resolve, 80));
      client.close();
    } finally {
      await server.close();
    }
  });

  it("removes per-request socket listeners after a successful response", async () => {
    const server = await startIpcServer({
      onRequest: async (request) => ({ echo: request.method }),
    });

    try {
      const client = await connectIpc({
        port: server.port,
        clientVersion: "ipc-timeout-test",
        requestTimeoutMs: 50,
      });

      const baseline = {
        message: client.socket.listenerCount("message"),
        error: client.socket.listenerCount("error"),
        close: client.socket.listenerCount("close"),
      };

      for (let i = 0; i < 5; i++) {
        const result = await client.request(`ping-${i}`);
        assert.deepEqual(result, { echo: `ping-${i}` });
        assert.equal(client.socket.listenerCount("message"), baseline.message);
        assert.equal(client.socket.listenerCount("error"), baseline.error);
        assert.equal(client.socket.listenerCount("close"), baseline.close);
      }

      client.close();
    } finally {
      await server.close();
    }
  });

  it("removes per-request socket listeners after a request timeout", async () => {
    const server = await startIpcServer({
      onRequest: async (request) => {
        if (request.method === "hang") {
          await new Promise(() => {});
        }
        return { ok: true };
      },
    });

    try {
      const client = await connectIpc({
        port: server.port,
        clientVersion: "ipc-timeout-test",
        requestTimeoutMs: 40,
      });

      const baseline = {
        message: client.socket.listenerCount("message"),
        error: client.socket.listenerCount("error"),
        close: client.socket.listenerCount("close"),
      };

      await assert.rejects(client.request("hang"), IpcRequestTimeoutError);

      assert.equal(client.socket.listenerCount("message"), baseline.message);
      assert.equal(client.socket.listenerCount("error"), baseline.error);
      assert.equal(client.socket.listenerCount("close"), baseline.close);

      client.close();
    } finally {
      await server.close();
    }
  });

  it("clears the request timer and rejects on socket close before timeout", async () => {
    const server = await startIpcServer({
      onRequest: async (request) => {
        if (request.method === "hang") {
          await new Promise(() => {});
        }
        return null;
      },
    });

    try {
      const client = await connectIpc({
        port: server.port,
        clientVersion: "ipc-timeout-test",
        requestTimeoutMs: 5_000,
      });

      const pending = client.request("hang");
      client.close();

      await assert.rejects(
        pending,
        (error: unknown) => {
          assert.ok(!(error instanceof IpcRequestTimeoutError));
          assert.match(String(error), /socket closed before the request completed/);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });

  it("preserves the existing handshake timeout behavior", async () => {
    const server = await startSilentSocketServer();

    try {
      await assert.rejects(
        connectIpc({
          port: server.port,
          clientVersion: "ipc-timeout-test",
          timeoutMs: 30,
        }),
        /Timed out waiting for agents-comm-bus IPC handshake/,
      );
    } finally {
      await server.close();
    }
  });
});
