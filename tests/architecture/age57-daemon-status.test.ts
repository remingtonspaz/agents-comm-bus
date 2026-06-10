import assert from "node:assert/strict";
import test from "node:test";

import { handleDaemonStatus } from "../../core-daemon/daemon.js";
import { connectIpc } from "../../core-daemon/ipc/client.js";
import { startIpcServer } from "../../core-daemon/ipc/server.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { formatDaemonStatus, daemonStatus } from "../../core-daemon/cli/status.js";
import { DAEMON_VERSION } from "../../core-daemon/config.js";
import type { PendingInboundEntry } from "../../core-daemon/runtime/pending-inbound.js";
import type { AccountId, CommId } from "../../packages/core-contracts/src/index.js";

const TELEGRAM = "telegram" as CommId;

class FakeComm {
  readonly id = TELEGRAM;
  readonly accountId: AccountId;
  constructor(accountId: string) {
    this.accountId = accountId as AccountId;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onInbound(): void {}
  onConnectionState(): void {}
  async send() {
    return { platform_message_id: "1", sent_at: 1 };
  }
  reportPressure() {
    return { backlog: 0, rateLimited: false };
  }
  classifyFailure() {
    return "transient" as const;
  }
}

test("AGE-57 handleDaemonStatus returns runtime summary fields", () => {
  const bus = new MessageBus({
    project: "/tmp/project",
    storage: {
      listConversations: async () => [],
    } as never,
    transcripts: { append: async () => {} } as never,
    audit: { append: async () => {} },
    comms: [new FakeComm("bot-1")],
  });
  const pendingInbound: PendingInboundEntry[] = [{ message: {} as never, conversation: {} as never }];
  const activeScopes = new Set(["claude:/tmp/project"]);

  const summary = handleDaemonStatus({ bus, pendingInbound, activeScopes });
  assert.equal(summary.daemon_version, DAEMON_VERSION);
  assert.deepEqual(summary.live_adapters, ["telegram:bot-1"]);
  assert.equal(summary.pending_inbound_depth, 1);
  assert.equal(summary.active_scope_count, 1);
});

test("AGE-57 daemon_status IPC method returns runtime summary", async () => {
  const pendingInbound: PendingInboundEntry[] = [];
  const activeScopes = new Set<string>();
  const bus = new MessageBus({
    project: "/tmp/project",
    storage: { listConversations: async () => [] } as never,
    transcripts: { append: async () => {} } as never,
    audit: { append: async () => {} },
  });

  const server = await startIpcServer({
    onRequest: async (request) => {
      if (request.method !== "daemon_status") {
        throw new Error(`unexpected method: ${request.method}`);
      }
      return handleDaemonStatus({ bus, pendingInbound, activeScopes });
    },
  });

  try {
    const client = await connectIpc({
      port: server.port,
      clientVersion: "test",
      metadata: { test: "daemon_status" },
    });
    try {
      const result = await client.request("daemon_status", {});
      assert.equal((result as { daemon_version: string }).daemon_version, DAEMON_VERSION);
      assert.deepEqual((result as { live_adapters: string[] }).live_adapters, []);
      assert.equal((result as { pending_inbound_depth: number }).pending_inbound_depth, 0);
      assert.equal((result as { active_scope_count: number }).active_scope_count, 0);
    } finally {
      client.close();
    }
  } finally {
    await server.close();
  }
});

test("AGE-57 status CLI formatter prints a human-readable snapshot", async () => {
  const text = formatDaemonStatus({
    daemon: { reachable: false, reason: "no daemon port file" },
    comm_leases: [],
    conversations: [],
    watchers: [{ session_key: "proj-abc", pid: null }],
  });
  assert.match(text, /agents-comm-bus status/);
  assert.match(text, /daemon: down/);
  assert.match(text, /claude watchers: 1/);

  const down = await daemonStatus({ stateRoot: "/nonexistent/agents-comm-bus-age57" });
  assert.equal(down.daemon.reachable, false);
});
