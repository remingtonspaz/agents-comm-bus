import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => { prepare(sql: string): { run(...args: unknown[]): void }; close(): void };
};

import {
  isProjectPathNearMatch,
  normalizeProjectPath,
} from "../../core-daemon/project-path.js";
import { claudeWakeDirForProject, hashProjectKey } from "../../core-daemon/bridges/claude/wake.js";
import { ensureCommsForSession } from "../../core-daemon/daemon.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
import { resolveAccountByLabel } from "../../core-daemon/cli/account-selector.js";
import { openSqliteStorage } from "../../core-daemon/storage/sqlite.js";
import { ContentAddressedBlobStore } from "../../core-daemon/storage/blobs.js";
import { CommLeaseArbiter } from "../../core-daemon/runtime/comm-lease.js";
import type { AccountRegistration, AgentId, CommId } from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";

describe("normalizeProjectPath", () => {
  it("canonicalizes Windows drive-letter casing and separators", { skip: os.platform() !== "win32" }, () => {
    const upper = normalizeProjectPath("D:\\Documents");
    const lower = normalizeProjectPath("d:\\Documents");
    const forward = normalizeProjectPath("D:/Documents");
    assert.equal(lower, upper);
    assert.equal(forward, upper);
    assert.match(upper, /^D:\\/);
    assert.equal(upper, path.resolve("D:/Documents").replace(/\//g, "\\"));
  });

  it("strips trailing separators except bare roots on Windows", { skip: os.platform() !== "win32" }, () => {
    assert.equal(normalizeProjectPath("D:\\Documents\\"), normalizeProjectPath("D:\\Documents"));
    assert.equal(normalizeProjectPath("D:\\"), "D:\\");
  });

  it("leaves POSIX paths unchanged aside from resolve and trailing slash trim", { skip: os.platform() === "win32" }, () => {
    const resolved = normalizeProjectPath("/home/user/project");
    assert.equal(resolved, path.resolve("/home/user/project"));
    assert.equal(normalizeProjectPath("/home/user/project/"), resolved);
  });

  it("is idempotent", () => {
    const sample = os.platform() === "win32" ? "d:\\work\\repo" : "/tmp/work/repo";
    const once = normalizeProjectPath(sample);
    assert.equal(normalizeProjectPath(once), once);
  });
});

describe("isProjectPathNearMatch", () => {
  it("detects casing and separator drift on Windows", { skip: os.platform() !== "win32" }, () => {
    assert.equal(isProjectPathNearMatch("d:\\Documents", "D:\\Documents"), true);
    assert.equal(isProjectPathNearMatch("D:/Documents", "D:\\Documents"), true);
    assert.equal(isProjectPathNearMatch("D:\\Documents", "D:\\Documents"), false);
    assert.equal(isProjectPathNearMatch("D:\\Other", "D:\\Documents"), false);
  });
});

describe("ensureCommsForSession near-miss diagnostic", () => {
  it("audits registration_project_near_miss when casing differs from stored registration", { skip: os.platform() !== "win32" }, async () => {
    const dir = await mkdtemp(join(os.tmpdir(), "acb-near-miss-"));
    const dbPath = join(dir, "db.sqlite");
    await openSqliteStorage(dbPath).then((storage) => storage.close());
    const audit = new JsonlAuditStore(dir);
    const blobs = new ContentAddressedBlobStore(dir);
    const canonical = normalizeProjectPath("D:\\work\\near-miss-project");
    const requested = canonical[0]!.toLowerCase() + canonical.slice(1);
    assert.notEqual(requested, canonical);

    // Simulate a legacy row written before storage-boundary canonicalization.
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb
      .prepare(`
        INSERT INTO account_registrations (
          schema_version, registration_id, project, comm, agent, account_label,
          bot_user_id, credentials_ref, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        SCHEMA_VERSION_ACCOUNT,
        "reg_near_miss",
        requested,
        "telegram",
        "claude",
        "main",
        "bot-near-miss",
        "file:test",
        1,
        1,
      );
    legacyDb.close();
    const storage = await openSqliteStorage(dbPath);

    let constructed = 0;
    const factory = {
      commId: "telegram" as CommId,
      async resolveCredentials() {
        return { credentials: {} };
      },
      create() {
        constructed += 1;
        return {
          id: "telegram" as CommId,
          accountId: "bot-near-miss",
          async start() {},
          async stop() {},
        };
      },
    };

    await ensureCommsForSession({
      project: requested,
      requestedProject: requested,
      agent: "claude" as AgentId,
      factories: [factory],
      bus: { getComm: () => null } as never,
      bridges: [],
      storage,
      env: {},
      blobs,
      stateRoot: dir,
      leaseArbiter: new CommLeaseArbiter({
        self: { pid: process.pid, stateRoot: dir, authorityRank: 0 },
        lastIpcServedAt: () => Date.now(),
      }),
      inFlight: new Set<string>(),
      audit,
    });

    assert.equal(constructed, 0, "exact lookup misses non-canonical stored rows until repair");
    const auditPath = audit.pathFor(Date.now());
    const auditLines = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
    const nearMiss = auditLines
      .map((line) => JSON.parse(line) as { kind: string; detail?: { near_match_projects?: string[] } })
      .find((event) => event.kind === "registration_project_near_miss");
    assert.ok(nearMiss, "expected registration_project_near_miss audit event");
    assert.deepEqual(nearMiss.detail?.near_match_projects, [requested]);
    await storage.close();
  });
});

describe("storage boundary project normalization", () => {
  it("finds canonical registrations via non-canonical list filters", { skip: os.platform() !== "win32" }, async () => {
    const dir = await mkdtemp(join(os.tmpdir(), "acb-storage-project-"));
    const storage = await openSqliteStorage(join(dir, "db.sqlite"));
    const canonicalProject = normalizeProjectPath("D:\\Foo\\age52-storage-boundary");
    const registration: AccountRegistration = {
      schema_version: SCHEMA_VERSION_ACCOUNT,
      registration_id: "reg_storage_boundary",
      project: canonicalProject,
      comm: "telegram" as CommId,
      agent: "claude" as AgentId,
      account_label: "main",
      bot_user_id: "bot-storage-boundary",
      credentials_ref: "file:test",
      created_at: 1,
      updated_at: 1,
      metadata: null,
    };
    await storage.putAccountRegistration(registration);

    const listed = await storage.listAccountRegistrations({
      project: "d:\\Foo\\age52-storage-boundary",
      comm: "telegram" as CommId,
      agent: "claude" as AgentId,
    });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.registration_id, registration.registration_id);
    assert.equal(listed[0]?.project, canonicalProject);

    const resolved = await resolveAccountByLabel(storage, {
      comm: "telegram" as CommId,
      accountLabel: "main",
      agent: "claude",
      project: "d:\\Foo\\age52-storage-boundary",
    });
    assert.equal(resolved.registration_id, registration.registration_id);
    assert.equal(resolved.project, canonicalProject);

    await storage.close();
  });
});

describe("wake dir hashing uses canonical project", () => {
  it("matches hook and daemon wake dirs for casing variants", { skip: os.platform() !== "win32" }, () => {
    const home = "D:\\home";
    const lower = claudeWakeDirForProject("d:\\work\\example-project", home);
    const upper = claudeWakeDirForProject("D:\\work\\example-project", home);
    assert.equal(lower, upper);
    assert.equal(hashProjectKey(normalizeProjectPath("d:\\work\\example-project")), hashProjectKey("D:\\work\\example-project"));
  });
});
