import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readCredentialFile } from "../../core-daemon/runtime/credential-resolution.js";
import { CurlCommAdapterFactory } from "../../adapters/curl/factory.js";
import { DiscordCommAdapterFactory } from "../../adapters/discord/factory.js";
import { MatrixCommAdapterFactory } from "../../adapters/matrix/factory.js";
import { TelegramCommAdapterFactory } from "../../adapters/telegram/factory.js";
import { ensureCommsForSession } from "../../core-daemon/daemon.js";
import { MessageBus } from "../../core-daemon/bus.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { JsonlTranscriptStore } from "../../core-daemon/storage/transcripts.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { CommLeaseArbiter } from "../../core-daemon/runtime/comm-lease.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import type {
  AccountRegistration,
  AgentId,
  CommId,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";

const SECRET_TOKEN = "super-secret-bot-token-12345";
const BOT_MXID = "@agents-comm-bot:matrix.example.org";

describe("readCredentialFile", () => {
  it("returns absent for non-file refs and ENOENT", async () => {
    assert.deepEqual(await readCredentialFile("env:TELEGRAM_BOT_TOKEN"), { status: "absent" });
    const dir = await mkdtemp(join(tmpdir(), "acb-cred-read-"));
    try {
      assert.deepEqual(
        await readCredentialFile(`file:${join(dir, "missing.json")}`),
        { status: "absent" },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns invalid:malformed_json for bad JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-cred-bad-json-"));
    const path = join(dir, "bad.json");
    try {
      await writeFile(path, "{not-json", "utf8");
      const result = await readCredentialFile(`file:${path}`);
      assert.equal(result.status, "invalid");
      if (result.status === "invalid") {
        assert.equal(result.failureKind, "malformed_json");
        assert.equal(result.reason, "credential file is not valid JSON");
        assert.equal(result.path, path);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns invalid:unreadable for non-ENOENT read failures", async (t) => {
    if (process.platform === "win32") {
      t.skip("chmod-based unreadable file test is not reliable on Windows");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "acb-cred-unreadable-"));
    const path = join(dir, "locked.json");
    try {
      await writeFile(path, "{}", "utf8");
      await chmod(path, 0o000);
      const result = await readCredentialFile(`file:${path}`);
      assert.equal(result.status, "invalid");
      if (result.status === "invalid") {
        assert.equal(result.failureKind, "unreadable");
        assert.match(result.reason, /^credential file unreadable:/);
        assert.equal(result.path, path);
      }
    } finally {
      await chmod(path, 0o600).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function makeRegistration(
  comm: CommId,
  credentialsRef: string,
  overrides: Partial<AccountRegistration> = {},
): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    registration_id: `reg-${comm}`,
    project: normalizeProjectPath("/tmp/cred-resolution-test"),
    comm,
    agent: "claude" as AgentId,
    account_label: "main",
    bot_user_id: comm === "matrix" ? BOT_MXID : "123456789",
    credentials_ref: credentialsRef,
    activation: "lazy",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe("factory resolveCredentials", () => {
  it("telegram: ok, absent, missing_field, malformed_json, no secrets leaked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-tg-cred-"));
    const good = join(dir, "good.json");
    const badJson = join(dir, "bad.json");
    const missingField = join(dir, "nofield.json");
    try {
      await writeFile(good, JSON.stringify({ botToken: SECRET_TOKEN }), "utf8");
      await writeFile(badJson, "{", "utf8");
      await writeFile(missingField, JSON.stringify({ userId: ["1"] }), "utf8");

      const factory = new TelegramCommAdapterFactory();
      const ok = await factory.resolveCredentials(makeRegistration("telegram", `file:${good}`), {});
      assert.equal(ok.status, "ok");
      if (ok.status === "ok") {
        assert.equal(ok.credentials.botToken, SECRET_TOKEN);
      }

      const absent = await factory.resolveCredentials(
        makeRegistration("telegram", `file:${join(dir, "missing.json")}`),
        {},
      );
      assert.equal(absent.status, "absent");

      const missing = await factory.resolveCredentials(
        makeRegistration("telegram", `file:${missingField}`),
        {},
      );
      assert.equal(missing.status, "invalid");
      if (missing.status === "invalid") {
        assert.equal(missing.failureKind, "missing_field");
        assert.match(missing.reason, /botToken/);
        assert.doesNotMatch(JSON.stringify(missing), new RegExp(SECRET_TOKEN));
      }

      const malformed = await factory.resolveCredentials(
        makeRegistration("telegram", `file:${badJson}`),
        {},
      );
      assert.equal(malformed.status, "invalid");
      if (malformed.status === "invalid") {
        assert.equal(malformed.failureKind, "malformed_json");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discord: ok, absent, missing_field, malformed_json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-discord-cred-"));
    const good = join(dir, "good.json");
    const badJson = join(dir, "bad.json");
    const missingField = join(dir, "nofield.json");
    try {
      await writeFile(good, JSON.stringify({ botToken: SECRET_TOKEN }), "utf8");
      await writeFile(badJson, "not-json", "utf8");
      await writeFile(missingField, JSON.stringify({}), "utf8");

      const factory = new DiscordCommAdapterFactory();
      assert.equal((await factory.resolveCredentials(makeRegistration("discord", `file:${good}`), {})).status, "ok");
      assert.equal(
        (await factory.resolveCredentials(makeRegistration("discord", `file:${join(dir, "x.json")}`), {})).status,
        "absent",
      );
      const missing = await factory.resolveCredentials(makeRegistration("discord", `file:${missingField}`), {});
      assert.equal(missing.status, "invalid");
      if (missing.status === "invalid") {
        assert.equal(missing.failureKind, "missing_field");
        assert.doesNotMatch(JSON.stringify(missing), new RegExp(SECRET_TOKEN));
      }
      const malformed = await factory.resolveCredentials(makeRegistration("discord", `file:${badJson}`), {});
      assert.equal(malformed.status, "invalid");
      if (malformed.status === "invalid") {
        assert.equal(malformed.failureKind, "malformed_json");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("curl: ok, absent, missing_field, malformed_json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-curl-cred-"));
    const good = join(dir, "good.json");
    const badJson = join(dir, "bad.json");
    const missingField = join(dir, "nofield.json");
    try {
      await writeFile(good, JSON.stringify({ token: SECRET_TOKEN }), "utf8");
      await writeFile(badJson, "{", "utf8");
      await writeFile(missingField, JSON.stringify({ port: 8080 }), "utf8");

      const factory = new CurlCommAdapterFactory();
      assert.equal((await factory.resolveCredentials(makeRegistration("curl", `file:${good}`), {})).status, "ok");
      assert.equal(
        (await factory.resolveCredentials(makeRegistration("curl", `file:${join(dir, "x.json")}`), {})).status,
        "absent",
      );
      const missing = await factory.resolveCredentials(makeRegistration("curl", `file:${missingField}`), {});
      assert.equal(missing.status, "invalid");
      if (missing.status === "invalid") {
        assert.equal(missing.failureKind, "missing_field");
        assert.match(missing.reason, /token/);
        assert.doesNotMatch(JSON.stringify(missing), new RegExp(SECRET_TOKEN));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("matrix: ok, validation failures for bad MXID and unknown policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-matrix-cred-"));
    const good = join(dir, "good.json");
    const badMxid = join(dir, "bad-mxid.json");
    const badPolicy = join(dir, "bad-policy.json");
    try {
      await writeFile(
        good,
        JSON.stringify({
          homeserverUrl: "https://matrix.example.org",
          accessToken: SECRET_TOKEN,
          userId: BOT_MXID,
        }),
        "utf8",
      );
      await writeFile(
        badMxid,
        JSON.stringify({
          homeserverUrl: "https://matrix.example.org",
          accessToken: SECRET_TOKEN,
          userId: "not-an-mxid",
        }),
        "utf8",
      );
      await writeFile(
        badPolicy,
        JSON.stringify({
          homeserverUrl: "https://matrix.example.org",
          accessToken: SECRET_TOKEN,
          userId: BOT_MXID,
          encryptedRoomPolicy: "allow",
        }),
        "utf8",
      );

      const factory = new MatrixCommAdapterFactory();
      assert.equal((await factory.resolveCredentials(makeRegistration("matrix", `file:${good}`), {})).status, "ok");

      const mxid = await factory.resolveCredentials(makeRegistration("matrix", `file:${badMxid}`), {});
      assert.equal(mxid.status, "invalid");
      if (mxid.status === "invalid") {
        assert.equal(mxid.failureKind, "validation");
        assert.doesNotMatch(JSON.stringify(mxid), new RegExp(SECRET_TOKEN));
      }

      const policy = await factory.resolveCredentials(makeRegistration("matrix", `file:${badPolicy}`), {});
      assert.equal(policy.status, "invalid");
      if (policy.status === "invalid") {
        assert.equal(policy.failureKind, "validation");
        assert.match(policy.reason, /encryptedRoomPolicy/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("daemon credential_resolution_failed audit", () => {
  it("emits credential_resolution_failed for invalid credentials, not for absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acb-daemon-cred-audit-"));
    const tokenFile = join(dir, "bad-token.json");
    const auditDir = join(dir, "audit-root");
    let storage: Awaited<ReturnType<typeof openSqliteStorage>> | undefined;
    try {
      await writeFile(tokenFile, JSON.stringify({}), "utf8");

      storage = await openSqliteStorage(join(dir, "storage.db"));
      const audit = new JsonlAuditStore(auditDir);
      const transcripts = new JsonlTranscriptStore(dir);
      const blobs = new ContentAddressedBlobStore(dir);
      const bus = new MessageBus({
        project: dir,
        storage,
        transcripts,
        audit,
        blobs,
        comms: [],
      });
      const leaseArbiter = new CommLeaseArbiter({
        self: {
          pid: process.pid,
          stateRoot: dir,
          checkoutRoot: dir,
          daemonBin: null,
          daemonVersion: "test",
          authorityRank: "worktree",
        },
        homeDir: dir,
      });
      const project = normalizeProjectPath(dir);
      const reg = makeRegistration("telegram", `file:${tokenFile}`, { project, bot_user_id: "999" });
      await storage.putAccountRegistration(reg);

      const events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];
      const auditSpy: JsonlAuditStore = {
        append: async (event) => {
          events.push({ kind: event.kind, detail: event.detail });
          await audit.append(event);
        },
      };

      await ensureCommsForSession({
        project,
        agent: "claude",
        factories: [new TelegramCommAdapterFactory()],
        bus,
        bridges: [],
        storage,
        env: process.env,
        blobs,
        stateRoot: dir,
        leaseArbiter,
        inFlight: new Set(),
        audit: auditSpy,
      });

      const failed = events.filter((e) => e.kind === "credential_resolution_failed");
      assert.equal(failed.length, 1, "invalid credential file should emit one audit event");
      assert.equal(failed[0].detail?.failure_kind, "missing_field");
      assert.match(String(failed[0].detail?.reason), /botToken/);
      assert.equal(failed[0].detail?.credential_path, tokenFile);
      assert.doesNotMatch(JSON.stringify(failed), new RegExp(SECRET_TOKEN));
      assert.equal(events.some((e) => e.kind === "comm_adapter_skip"), false);

      await storage.putAccountRegistration({
        ...reg,
        credentials_ref: `file:${join(dir, "does-not-exist.json")}`,
      });
      events.length = 0;
      await ensureCommsForSession({
        project,
        agent: "claude",
        factories: [new TelegramCommAdapterFactory()],
        bus,
        bridges: [],
        storage,
        env: process.env,
        blobs,
        stateRoot: dir,
        leaseArbiter,
        inFlight: new Set(),
        audit: auditSpy,
      });

      assert.equal(events.some((e) => e.kind === "credential_resolution_failed"), false);
      assert.equal(events.some((e) => e.kind === "comm_adapter_skip"), true);
    } finally {
      if (storage) await storage.close();
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
      }
    }
  });
});
