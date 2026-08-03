/**
 * AGE-91: inspect_inbound_target — read-only routing + liveness verdict.
 *
 * These tests are written to fail if the feature is removed, and each conjunct
 * of the verdict is exercised separately. The two an implementer gets wrong:
 *   - connection-lease-without-PID is `no_owner` AND deliverable (the canonical
 *     predicate is an OR, not the classifier);
 *   - ambiguity fails closed rather than picking a candidate.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { serializeAccountLabelScope } from "../../core-daemon/session-label-scope.js";
import { createSessionOwnerLiveness } from "../../core-daemon/runtime/session-owner-liveness.js";
import { handleInspectInboundTarget } from "../../core-daemon/runtime/inspect-inbound-target.js";
import type { AgentBridge, DaemonSelfIdentity } from "../../core-daemon/runtime/agent-bridge.js";
import type {
  AccountRegistration,
  AgentId,
  CommId,
  Conversation,
  ConversationId,
  SessionId,
} from "../../packages/core-contracts/src/types.js";
import {
  SCHEMA_VERSION_ACCOUNT,
  SCHEMA_VERSION_CONVERSATION,
} from "../../packages/core-contracts/src/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sessionFixture } from "./_session-fixture.js";

const DISCORD = "discord" as CommId;
const CLAUDE = "claude" as AgentId;
const PROJECT = normalizeProjectPath("project-age91");
const OUR_ROOT = "D:\\state\\discovery";
const OTHER_ROOT = "D:\\other\\discovery";

async function withStorage<T>(
  test: (storage: Awaited<ReturnType<typeof openSqliteStorage>>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-age91-"));
  const storage = await openSqliteStorage(join(dir, "storage.db"));
  try {
    return await test(storage);
  } finally {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function registration(): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    project: PROJECT,
    comm: DISCORD,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: "bot-1",
    registration_id: "reg-1",
    credentials_ref: "file:/tmp/token.json",
    created_at: 1,
    updated_at: 1,
  };
}

function conversation(): Conversation {
  return {
    schema_version: SCHEMA_VERSION_CONVERSATION,
    project: PROJECT,
    comm: DISCORD,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: "bot-1",
    chat_native_id: "chat-1",
    thread_native_id: null,
    registration_id: "reg-1",
    conversation_id: "conv-age91" as ConversationId,
    last_inbound_at: null,
    last_outbound_at: null,
    last_message_id: null,
    created_at: 1,
    metadata: null,
  } as Conversation;
}

const daemonOwner: DaemonSelfIdentity = {
  discoveryRoot: OUR_ROOT,
  checkoutRoot: null,
  stateRoot: OUR_ROOT,
  daemonBin: null,
  authorityRank: "production",
};

/** A bridge whose route-readiness we control exactly. */
function bridgeWithRoute(routeReady: boolean): AgentBridge {
  return {
    agentId: CLAUDE,
    ipcMethods: new Set<string>(),
    attach() {},
    async handleIpcMethod() {
      return undefined;
    },
    routeReady: () => routeReady,
  } as unknown as AgentBridge;
}

/** A bridge that does not implement routeReady at all (e.g. a future host). */
function bridgeWithoutRouteReady(): AgentBridge {
  return {
    agentId: CLAUDE,
    ipcMethods: new Set<string>(),
    attach() {},
    async handleIpcMethod() {
      return undefined;
    },
  } as unknown as AgentBridge;
}

function deps(storage: never, bridges: AgentBridge[]) {
  return {
    storage: storage as never,
    bridges,
    daemonOwner,
    sessionOwnerIsLive: createSessionOwnerLiveness(),
  };
}

describe("AGE-91 inspect_inbound_target", () => {
  it("resolves a live, routed, locally-owned session as deliverable", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      await storage.upsertConversation(conversation());
      await storage.upsertSession(
        sessionFixture({
          session_id: "s-live" as SessionId,
          agent: CLAUDE,
          project: PROJECT,
          lease_holder_connection_id: "conn-1",
          lease_owner_daemon_discovery_root: OUR_ROOT,
        }),
      );

      const out = (await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithRoute(true)]),
      )) as Record<string, never>;

      assert.equal(out.resolution, "resolved");
      assert.equal(out.locally_deliverable, true);
      assert.equal((out.routed_session as never as Record<string, never>).route_ready, true);
    });
  });

  it("reports a cold conversation as cold, not an error", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      await storage.upsertConversation(conversation());

      const out = (await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithRoute(true)]),
      )) as Record<string, never>;

      assert.equal(out.resolution, "cold");
      assert.equal(out.routed_session, null);
      assert.equal(out.locally_deliverable, false);
    });
  });

  it("returns not_found for an unknown conversation", async () => {
    await withStorage(async (storage) => {
      const out = (await handleInspectInboundTarget(
        { conversation_id: "conv-nope" },
        deps(storage as never, [bridgeWithRoute(true)]),
      )) as Record<string, never>;
      assert.equal(out.resolution, "not_found");
      assert.equal(out.locally_deliverable, false);
    });
  });

  it("connection lease with NO owner pid is no_owner AND still deliverable", async () => {
    // The canonical predicate is an OR. An implementer who equates
    // `owner_state !== "live"` with dead regresses every no-PID host.
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      await storage.upsertConversation(conversation());
      await storage.upsertSession(
        sessionFixture({
          session_id: "s-conn-only" as SessionId,
          agent: CLAUDE,
          project: PROJECT,
          lease_holder_connection_id: "conn-1",
          lease_owner_process_pid: null,
          lease_owner_process_registered_at: null,
          lease_owner_daemon_discovery_root: OUR_ROOT,
        }),
      );

      const out = (await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithRoute(true)]),
      )) as Record<string, never>;

      const routed = out.routed_session as never as Record<string, never>;
      assert.equal(routed.owner_state, "no_owner");
      assert.equal(out.locally_deliverable, true);
    });
  });

  it("a live, local session with NO route is not deliverable", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      await storage.upsertConversation(conversation());
      await storage.upsertSession(
        sessionFixture({
          session_id: "s-no-route" as SessionId,
          agent: CLAUDE,
          project: PROJECT,
          lease_holder_connection_id: "conn-1",
          lease_owner_daemon_discovery_root: OUR_ROOT,
        }),
      );

      const out = (await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithRoute(false)]),
      )) as Record<string, never>;

      assert.equal(out.resolution, "resolved");
      assert.equal((out.routed_session as never as Record<string, never>).route_ready, false);
      assert.equal(out.locally_deliverable, false);
    });
  });

  it("a bridge without routeReady fails closed rather than assuming a route", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      await storage.upsertConversation(conversation());
      await storage.upsertSession(
        sessionFixture({
          session_id: "s-no-hook" as SessionId,
          agent: CLAUDE,
          project: PROJECT,
          lease_holder_connection_id: "conn-1",
          lease_owner_daemon_discovery_root: OUR_ROOT,
        }),
      );

      const out = (await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithoutRouteReady()]),
      )) as Record<string, never>;

      assert.equal(out.locally_deliverable, false);
    });
  });

  it("a session owned by another daemon is not deliverable, but is reported honestly", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      await storage.upsertConversation(conversation());
      await storage.upsertSession(
        sessionFixture({
          session_id: "s-foreign" as SessionId,
          agent: CLAUDE,
          project: PROJECT,
          lease_holder_connection_id: "conn-1",
          lease_owner_daemon_discovery_root: OTHER_ROOT,
        }),
      );

      const out = (await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithRoute(true)]),
      )) as Record<string, never>;

      const routed = out.routed_session as never as Record<string, never>;
      assert.equal(out.resolution, "resolved");
      assert.equal(routed.owner_daemon_matches, false);
      assert.equal(routed.session_id, "s-foreign");
      assert.equal(out.locally_deliverable, false);
    });
  });

  it("ambiguity fails closed: candidates are diagnostic, never a choice", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      await storage.upsertConversation(conversation());
      const scope = serializeAccountLabelScope({ discord: "main" })!;
      for (const id of ["s-amb-1", "s-amb-2"]) {
        await storage.upsertSession(
          sessionFixture({
            session_id: id as SessionId,
            agent: CLAUDE,
            project: PROJECT,
            account_label_scope: scope,
            lease_owner_process_pid: process.pid,
            lease_owner_process_registered_at: Date.now(),
            lease_owner_daemon_discovery_root: OUR_ROOT,
          }),
        );
      }

      const out = (await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithRoute(true)]),
      )) as Record<string, never>;

      assert.equal(out.resolution, "ambiguous");
      assert.equal(out.routed_session, null);
      assert.equal(out.locally_deliverable, false);
      assert.equal((out.candidate_sessions as never as unknown[]).length, 2);
    });
  });

  it("labelled and unlabelled sessions resolve distinctly (NULL-aware)", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      await storage.upsertConversation(conversation());
      // Labelled matching this conversation's comm+label wins over unlabelled.
      await storage.upsertSession(
        sessionFixture({
          session_id: "s-unlabelled" as SessionId,
          agent: CLAUDE,
          project: PROJECT,
          account_label_scope: null,
          lease_owner_process_pid: process.pid,
          lease_owner_process_registered_at: Date.now(),
          lease_owner_daemon_discovery_root: OUR_ROOT,
        }),
      );
      await storage.upsertSession(
        sessionFixture({
          session_id: "s-labelled" as SessionId,
          agent: CLAUDE,
          project: PROJECT,
          account_label_scope: serializeAccountLabelScope({ discord: "main" })!,
          lease_owner_process_pid: process.pid,
          lease_owner_process_registered_at: Date.now(),
          lease_owner_daemon_discovery_root: OUR_ROOT,
        }),
      );

      const out = (await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithRoute(true)]),
      )) as Record<string, never>;

      assert.equal(out.resolution, "resolved");
      assert.equal(
        (out.routed_session as never as Record<string, never>).session_id,
        "s-labelled",
      );
    });
  });

  it("performs no writes", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      await storage.upsertConversation(conversation());
      await storage.upsertSession(
        sessionFixture({
          session_id: "s-live" as SessionId,
          agent: CLAUDE,
          project: PROJECT,
          lease_holder_connection_id: "conn-1",
          lease_owner_daemon_discovery_root: OUR_ROOT,
        }),
      );

      const before = JSON.stringify(
        await storage.listSessions({ project: PROJECT, agent: CLAUDE }),
      );
      await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithRoute(true)]),
      );
      const after = JSON.stringify(
        await storage.listSessions({ project: PROJECT, agent: CLAUDE }),
      );
      assert.equal(after, before);
    });
  });

  // B1 (Codex): the endpoint wiring was test-invisible — the handler was
  // exercised directly while daemon dispatch was never touched, so deleting the
  // branch left the suite green. No test boots runDaemon, so this asserts the
  // wiring at the source seam (the AGE-92 precedent). It proves the branch
  // exists and is ordered before the generic fallthrough — not that a live
  // daemon serves it.
  describe("daemon dispatch wiring", () => {
    const daemonSrc = readFileSync(
      fileURLToPath(new URL("../../core-daemon/daemon.ts", import.meta.url)),
      "utf8",
    );

    it("registers an inspect_inbound_target dispatch branch", () => {
      assert.ok(
        daemonSrc.includes('request.method === "inspect_inbound_target"'),
        "daemon.ts has no inspect_inbound_target dispatch branch",
      );
      assert.ok(
        daemonSrc.includes("handleInspectInboundTarget("),
        "daemon.ts never calls handleInspectInboundTarget",
      );
    });

    it("dispatches inspect_inbound_target before the bridge fallthrough", () => {
      const branch = daemonSrc.indexOf('request.method === "inspect_inbound_target"');
      const fallthrough = daemonSrc.indexOf("context.bridgesByMethod.get(request.method)");
      assert.ok(branch > 0, "dispatch branch missing");
      assert.ok(fallthrough > 0, "bridge fallthrough missing");
      assert.ok(branch < fallthrough, "inspect_inbound_target must dispatch before the fallthrough");
    });

    it("passes the four deps the handler needs", () => {
      const callIdx = daemonSrc.indexOf("handleInspectInboundTarget(params, {");
      assert.ok(callIdx > 0, "handler is not called with a deps object");
      const callSite = daemonSrc.slice(callIdx, callIdx + 400);
      for (const dep of ["storage:", "bridges:", "daemonOwner:", "sessionOwnerIsLive:"]) {
        assert.ok(callSite.includes(dep), `dispatch does not pass ${dep}`);
      }
    });
  });

  // B2 (Codex): the alternate lookup scanned conversation history, so a valid
  // registration that had never received a message reported not_found.
  it("registration with no conversations resolves cold, not not_found", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      const out = (await handleInspectInboundTarget(
        { comm: "discord", account: "bot-1" },
        deps(storage as never, [bridgeWithRoute(true)]),
      )) as Record<string, never>;
      assert.equal(out.resolution, "cold");
      assert.equal(out.locally_deliverable, false);
    });
  });

  // B3 (Codex): candidate_sessions is specified as present ONLY for ambiguous.
  it("omits candidate_sessions unless ambiguous", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      await storage.upsertConversation(conversation());
      const cold = (await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithRoute(true)]),
      )) as Record<string, never>;
      assert.ok(!("candidate_sessions" in cold), "cold must omit candidate_sessions");

      await storage.upsertSession(
        sessionFixture({
          session_id: "s-one" as SessionId,
          agent: CLAUDE,
          project: PROJECT,
          lease_holder_connection_id: "conn-1",
          lease_owner_daemon_discovery_root: OUR_ROOT,
        }),
      );
      const resolved = (await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithRoute(true)]),
      )) as Record<string, never>;
      assert.equal(resolved.resolution, "resolved");
      assert.ok(!("candidate_sessions" in resolved), "resolved must omit candidate_sessions");
    });
  });

  // B4 (Codex): the ad-hoc canonicalizer mishandled ".." segments, so an
  // equivalent discovery root read as foreign.
  it("treats a '..'-equivalent discovery root as the same daemon", async () => {
    await withStorage(async (storage) => {
      await storage.putAccountRegistration(registration());
      await storage.upsertConversation(conversation());
      await storage.upsertSession(
        sessionFixture({
          session_id: "s-equiv" as SessionId,
          agent: CLAUDE,
          project: PROJECT,
          lease_holder_connection_id: "conn-1",
          lease_owner_daemon_discovery_root: String.raw`D:\state\x\..\discovery`,
        }),
      );
      const out = (await handleInspectInboundTarget(
        { conversation_id: "conv-age91" },
        deps(storage as never, [bridgeWithRoute(true)]),
      )) as Record<string, never>;
      const routed = out.routed_session as never as Record<string, never>;
      assert.equal(routed.owner_daemon_matches, true);
      assert.equal(out.locally_deliverable, true);
    });
  });

});
