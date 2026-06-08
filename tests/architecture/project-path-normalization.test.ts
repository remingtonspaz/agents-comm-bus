import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

import {
  isProjectPathNearMatch,
  normalizeProjectPath,
} from "../../core-daemon/project-path.js";
import { claudeWakeDirForProject, hashProjectKey } from "../../core-daemon/bridges/claude/wake.js";
import { ensureCommsForSession } from "../../core-daemon/daemon.js";
import { JsonlAuditStore } from "../../core-daemon/storage/audit.js";
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
    const storage = await openSqliteStorage(join(dir, "db.sqlite"));
    const audit = new JsonlAuditStore(dir);
    const blobs = new ContentAddressedBlobStore(dir);
    const canonical = normalizeProjectPath("D:\\work\\near-miss-project");
    const requested = canonical[0]!.toLowerCase() + canonical.slice(1);
    assert.notEqual(requested, canonical);

    const registration: AccountRegistration = {
      schema_version: SCHEMA_VERSION_ACCOUNT,
      registration_id: "reg_near_miss",
      project: requested,
      comm: "telegram" as CommId,
      agent: "claude" as AgentId,
      account_label: "main",
      bot_user_id: "bot-near-miss",
      credentials_ref: "file:test",
      created_at: 1,
      updated_at: 1,
      metadata: null,
    };
    await storage.putAccountRegistration(registration);

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

describe("wake dir hashing uses canonical project", () => {
  it("matches hook and daemon wake dirs for casing variants", { skip: os.platform() !== "win32" }, () => {
    const home = "D:\\home";
    const lower = claudeWakeDirForProject("d:\\work\\example-project", home);
    const upper = claudeWakeDirForProject("D:\\work\\example-project", home);
    assert.equal(lower, upper);
    assert.equal(hashProjectKey(normalizeProjectPath("d:\\work\\example-project")), hashProjectKey("D:\\work\\example-project"));
  });
});
