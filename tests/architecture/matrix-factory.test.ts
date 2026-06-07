import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import {
  createCommAdapterFactory,
  MatrixCommAdapterFactory,
} from "../../adapters/matrix/factory.js";
import type {
  AccountRegistration,
  AgentId,
  CommId,
  Session,
  SessionId,
  Storage,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/index.js";
import type { SendRequest } from "../../core-daemon/bus.js";
import { discoverCommAdapters } from "../../scripts/comm-adapters.mjs";
import type { MatrixIdentityClient } from "../../adapters/matrix/adapter.js";

const MATRIX = "matrix" as CommId;
const CLAUDE = "claude" as AgentId;
const BOT_MXID = "@agents-comm-bot:matrix.example.org";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function makeRegistration(overrides: Partial<AccountRegistration> = {}): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    registration_id: "reg-matrix-factory-test",
    project: "/tmp/project-matrix-factory-test",
    comm: MATRIX,
    agent: CLAUDE,
    account_label: "main",
    bot_user_id: BOT_MXID,
    credentials_ref: "file:/missing/matrix.json",
    bot_username: "agents-comm-bot",
    created_at: 1,
    updated_at: 1,
    metadata: undefined,
    ...overrides,
  };
}

async function withStorage<T>(test: (dir: string, dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "acb-matrix-factory-"));
  try {
    return await test(dir, join(dir, "storage.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeCredentialFile(
  dir: string,
  body: Record<string, unknown>,
): Promise<string> {
  const path = join(dir, "matrix.json");
  await writeFile(path, JSON.stringify(body));
  return `file:${path}`;
}

function fakeIdentityClient(
  response: { user_id: string; is_guest?: boolean },
): MatrixIdentityClient {
  return {
    async whoami() {
      return response;
    },
  };
}

describe("Matrix factory discovery and shape", () => {
  it("discovers matrix as a shippable comm adapter", async () => {
    const comms = await discoverCommAdapters(repoRoot);
    assert.ok(comms.includes("matrix"), `expected matrix in ${JSON.stringify(comms)}`);
    assert.ok(comms.includes("telegram"), "telegram should remain discoverable");
  });

  it("createCommAdapterFactory returns a valid CommAdapterFactory", () => {
    const factory = createCommAdapterFactory();
    assert.equal(factory.commId, "matrix");
    assert.equal(typeof factory.resolveCredentials, "function");
    assert.equal(typeof factory.probeIdentity, "function");
    assert.equal(typeof factory.create, "function");
    assert.equal(typeof factory.ipcMethods, "function");
  });
});

describe("Matrix factory credential resolution", () => {
  it("reads valid file credentials and normalizes homeserverUrl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-matrix-creds-"));
    try {
      const factory = new MatrixCommAdapterFactory();
      const resolved = await factory.resolveCredentials(
        makeRegistration({
          credentials_ref: await writeCredentialFile(dir, {
            homeserverUrl: "https://matrix.example.org/",
            accessToken: "syt_test_token",
            userId: BOT_MXID,
          }),
        }),
        {},
      );
      assert.ok(resolved);
      assert.equal(resolved!.credentials.homeserverUrl, "https://matrix.example.org");
      assert.equal(resolved!.credentials.accessToken, "syt_test_token");
      assert.equal(resolved!.credentials.userId, BOT_MXID);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for missing required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-matrix-creds-bad-"));
    try {
      const factory = new MatrixCommAdapterFactory();
      const cases = [
        { homeserverUrl: "https://matrix.example.org", accessToken: "tok" },
        { homeserverUrl: "https://matrix.example.org", userId: BOT_MXID },
        { accessToken: "tok", userId: BOT_MXID },
        { homeserverUrl: "https://matrix.example.org", accessToken: "tok", userId: "not-an-mxid" },
      ];
      for (const body of cases) {
        const resolved = await factory.resolveCredentials(
          makeRegistration({
            credentials_ref: await writeCredentialFile(dir, body),
          }),
          {},
        );
        assert.equal(resolved, undefined, `expected undefined for ${JSON.stringify(body)}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("merges credential-file allowed users with DB allowlist rows without duplicates", async () => {
    await withStorage(async (dir, dbPath) => {
      const storage = await openSqliteStorage(dbPath);
      await storage.addAllowlistGlobal({
        comm: MATRIX,
        sender_id: "@global:matrix.example.org",
        added_at: 1,
      });
      await storage.addAllowlistPerBot({
        comm: MATRIX,
        bot_user_id: BOT_MXID,
        sender_id: "@perbot:matrix.example.org",
        added_at: 2,
      });
      await storage.addAllowlistPerBot({
        comm: MATRIX,
        bot_user_id: "@other-bot:matrix.example.org",
        sender_id: "@other-bot-sender:matrix.example.org",
        added_at: 3,
      });

      const factory = new MatrixCommAdapterFactory();
      const resolved = await factory.resolveCredentials(
        makeRegistration({
          credentials_ref: await writeCredentialFile(dir, {
            homeserverUrl: "https://matrix.example.org",
            accessToken: "syt_test_token",
            userId: BOT_MXID,
            allowedUserIds: ["@file:matrix.example.org", "@global:matrix.example.org"],
          }),
        }),
        { MATRIX_USER_ID: "@env:matrix.example.org,@global:matrix.example.org" },
        { storage },
      );

      assert.ok(resolved);
      assert.deepEqual(
        [...(resolved!.credentials.allowedUserIds as string[])].sort(),
        [
          "@env:matrix.example.org",
          "@file:matrix.example.org",
          "@global:matrix.example.org",
          "@perbot:matrix.example.org",
        ].sort(),
      );
      await storage.close();
    });
  });
});

describe("Matrix factory probeIdentity", () => {
  it("returns the Matrix MXID when whoami matches credential userId", async () => {
    const factory = new MatrixCommAdapterFactory({
      identityClient: fakeIdentityClient({ user_id: BOT_MXID }),
    });
    const result = await factory.probeIdentity!({
      homeserverUrl: "https://matrix.example.org",
      accessToken: "syt_test_token",
      userId: BOT_MXID,
    });
    assert.equal(result.accountId, BOT_MXID);
    assert.equal(result.accountUsername, "agents-comm-bot");
  });

  it("rejects mismatched user_id", async () => {
    const factory = new MatrixCommAdapterFactory({
      identityClient: fakeIdentityClient({ user_id: "@other:matrix.example.org" }),
    });
    await assert.rejects(
      () => factory.probeIdentity!({
        homeserverUrl: "https://matrix.example.org",
        accessToken: "syt_test_token",
        userId: BOT_MXID,
      }),
      /user_id mismatch/,
    );
  });

  it("rejects guest users", async () => {
    const factory = new MatrixCommAdapterFactory({
      identityClient: fakeIdentityClient({ user_id: BOT_MXID, is_guest: true }),
    });
    await assert.rejects(
      () => factory.probeIdentity!({
        homeserverUrl: "https://matrix.example.org",
        accessToken: "syt_test_token",
        userId: BOT_MXID,
      }),
      /guest accounts are not supported/,
    );
  });
});

describe("matrix_send IPC handler", () => {
  const ROOM_ID = "!room:matrix.example.org";
  const OTHER_BOT_MXID = "@acb-codex:matrix.satriodewantono.com";

  function makeSession(overrides: Partial<Session> = {}): Session {
    return {
      session_id: "matrix_session" as SessionId,
      agent: CLAUDE,
      project: "D:\\repo",
      schema_version: 1,
      created_at: 1,
      lease_holder_connection_id: null,
      lease_acquired_at: null,
      lease_released_at: null,
      lease_owner_process_pid: null,
      lease_owner_process_label: null,
      lease_owner_process_registered_at: null,
      most_recent_inbound_conversation_id: null,
      status: "active",
      ...overrides,
    };
  }

  it("routes text through bus.send with comm matrix", async () => {
    const bus = new RecordingBus();
    const factory = new MatrixCommAdapterFactory();
    const handler = factory.ipcMethods({
      bus: bus as never,
      storage: new TargetStorage([], makeSession()) as never,
      pendingInbound: [],
    } as never).get("matrix_send");

    assert.ok(handler);
    await handler({
      session: "matrix_session",
      message: "probe",
      target: {
        account: OTHER_BOT_MXID,
        chat_native_id: ROOM_ID,
      },
    });

    assert.equal(bus.lastSend?.comm, "matrix");
    assert.equal(bus.lastSend?.payload?.text, "probe");
    assert.equal(bus.lastSend?.session, "matrix_session");
  });

  it("preserves explicit Matrix MXID account and room id", async () => {
    const bus = new RecordingBus();
    const factory = new MatrixCommAdapterFactory();
    const handler = factory.ipcMethods({
      bus: bus as never,
      storage: new TargetStorage([], makeSession()) as never,
      pendingInbound: [],
    } as never).get("matrix_send");

    assert.ok(handler);
    await handler({
      message: "hello room",
      target: {
        account: OTHER_BOT_MXID,
        room_id: ROOM_ID,
      },
    });

    assert.equal(bus.lastSend?.comm, "matrix");
    assert.equal(bus.lastSend?.target?.account, OTHER_BOT_MXID);
    assert.equal(bus.lastSend?.target?.chat_native_id, ROOM_ID);
    assert.equal(bus.lastSend?.session, "mcp");
  });

  it("resolves omitted target account from the caller session scoped registration", async () => {
    const storage = new TargetStorage([
      makeRegistration({
        project: "D:\\repo",
        bot_user_id: BOT_MXID,
      }),
    ], makeSession());
    const bus = new RecordingBus();
    const factory = new MatrixCommAdapterFactory();
    const handler = factory.ipcMethods({
      bus: bus as never,
      storage: storage as never,
      pendingInbound: [],
    } as never).get("matrix_send");

    assert.ok(handler);
    await handler({
      session: "matrix_session",
      message: "scoped send",
      target: {
        chat_native_id: ROOM_ID,
      },
    });

    assert.equal(bus.lastSend?.target?.account, BOT_MXID);
    assert.equal(bus.lastSend?.target?.chat_native_id, ROOM_ID);
  });

  it("matrix_send_image routes attachment payloads through bus.send", async () => {
    const bus = new RecordingBus();
    const factory = new MatrixCommAdapterFactory();
    const handler = factory.ipcMethods({
      bus: bus as never,
      storage: new TargetStorage([], makeSession()) as never,
      pendingInbound: [],
    } as never).get("matrix_send_image");

    assert.ok(handler);
    await handler({
      session: "matrix_session",
      path: "D:\\tmp\\diagram.png",
      caption: "see attached",
      target: {
        account: OTHER_BOT_MXID,
        chat_native_id: ROOM_ID,
      },
    });

    assert.equal(bus.lastSend?.comm, "matrix");
    assert.equal(bus.lastSend?.payload?.attachments?.[0]?.local_path, "D:\\tmp\\diagram.png");
    assert.equal(bus.lastSend?.payload?.attachments?.[0]?.filename, "diagram.png");
    assert.equal(bus.lastSend?.payload?.text, "see attached");
  });

  it("rejects account labels before bus.send", async () => {
    const bus = new RecordingBus();
    const factory = new MatrixCommAdapterFactory();
    const handler = factory.ipcMethods({
      bus: bus as never,
      storage: new TargetStorage([], makeSession()) as never,
      pendingInbound: [],
    } as never).get("matrix_send");

    assert.ok(handler);
    await assert.rejects(
      () =>
        handler({
          session: "matrix_session",
          message: "nope",
          target: {
            account: "main",
            chat_native_id: ROOM_ID,
          },
        }),
      /not a Matrix MXID/i,
    );
    assert.equal(bus.lastSend, null);
  });
});

class RecordingBus {
  lastSend: SendRequest | null = null;

  async send(request: SendRequest): Promise<string> {
    this.lastSend = request;
    return "matrix:evt_1";
  }
}

class TargetStorage implements Partial<Storage> {
  constructor(
    private readonly registrations: AccountRegistration[],
    private readonly session: Session,
  ) {}

  async getSession(session: SessionId): Promise<Session | null> {
    return session === this.session.session_id ? this.session : null;
  }

  async listAccountRegistrations(filter?: {
    project?: string;
    comm?: CommId;
    agent?: AgentId;
  }): Promise<AccountRegistration[]> {
    return this.registrations.filter((registration) => {
      if (filter?.project !== undefined && registration.project !== filter.project) return false;
      if (filter?.comm !== undefined && registration.comm !== filter.comm) return false;
      if (filter?.agent !== undefined && registration.agent !== filter.agent) return false;
      return true;
    });
  }
}
