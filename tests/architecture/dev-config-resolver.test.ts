import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  resolveDevConfig,
  applyDevConfig,
  DEV_MARKER_NAME,
} from "../../hosts/common/install/dev-config-resolver.js";

// ---------------------------------------------------------------------------
// Dev-config resolver: gitignored marker -> validated env-shaped overrides.
// resolveInstallMode stays env-only; this layer only produces the env values.
// ---------------------------------------------------------------------------

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "acb-devcfg-"));
}

/** Write a project root with a real source daemon entry + a marker. */
async function project(
  marker: Record<string, unknown> | string | null,
  opts: { daemonBin?: string } = {},
): Promise<string> {
  const root = await tempRoot();
  const binRel = opts.daemonBin ?? "agents-comm-bus/dist/core-daemon/serve.js";
  await mkdir(path.join(root, path.dirname(binRel)), { recursive: true });
  await writeFile(path.join(root, binRel), "// fake daemon entry\n", "utf8");
  if (marker !== null) {
    const body = typeof marker === "string" ? marker : JSON.stringify(marker);
    await writeFile(path.join(root, DEV_MARKER_NAME), body, "utf8");
  }
  return root;
}

describe("resolveDevConfig — no marker", () => {
  it("returns status 'none' and no env when the marker is absent", async () => {
    const root = await project(null);
    const r = resolveDevConfig(root);
    assert.equal(r.status, "none");
    assert.deepEqual(r.env, {});
  });
});

describe("resolveDevConfig — valid marker", () => {
  it("resolves daemonBin to an absolute AGENTS_COMM_BUS_BIN inside the root", async () => {
    const root = await project({ daemonBin: "agents-comm-bus/dist/core-daemon/serve.js" });
    const r = resolveDevConfig(root);
    assert.equal(r.status, "applied");
    assert.equal(r.env.AGENTS_COMM_BUS_BIN, path.join(root, "agents-comm-bus/dist/core-daemon/serve.js"));
  });

  it("includes optional stateRoot / adaptersDir when they resolve inside the root", async () => {
    const root = await project({
      daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
      stateRoot: ".agents-comm-bus-dev",
      adaptersDir: "adapters",
    });
    const r = resolveDevConfig(root);
    assert.equal(r.status, "applied");
    assert.equal(r.env.AGENTS_COMM_BUS_ROOT, path.join(root, ".agents-comm-bus-dev"));
    assert.equal(r.env.AGENTS_COMM_BUS_ADAPTERS_DIR, path.join(root, "adapters"));
  });

  it("ignores optional overrides that escape the root, but still applies daemonBin", async () => {
    const root = await project({
      daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
      stateRoot: "../escaping-state",
    });
    const r = resolveDevConfig(root);
    assert.equal(r.status, "applied");
    assert.ok(r.env.AGENTS_COMM_BUS_BIN);
    assert.equal(r.env.AGENTS_COMM_BUS_ROOT, undefined, "escaping stateRoot must be dropped");
  });
});

describe("resolveDevConfig — rejected (negative cases)", () => {
  it("rejects a daemonBin that escapes the project root", async () => {
    const root = await project({ daemonBin: "../../evil/serve.js" });
    const r = resolveDevConfig(root);
    assert.equal(r.status, "rejected");
    assert.deepEqual(r.env, {});
  });

  it("rejects a daemonBin that points inside the root but does not exist", async () => {
    const root = await project({ daemonBin: "agents-comm-bus/dist/core-daemon/does-not-exist.js" });
    const r = resolveDevConfig(root);
    assert.equal(r.status, "rejected");
    assert.deepEqual(r.env, {});
  });

  it("rejects a marker missing the daemonBin field", async () => {
    const root = await project({ stateRoot: ".agents-comm-bus-dev" });
    const r = resolveDevConfig(root);
    assert.equal(r.status, "rejected");
    assert.deepEqual(r.env, {});
  });

  it("rejects an unparseable marker", async () => {
    const root = await project("{ not valid json");
    const r = resolveDevConfig(root);
    assert.equal(r.status, "rejected");
    assert.deepEqual(r.env, {});
  });
});

describe("applyDevConfig — merge without mutation", () => {
  it("merges overrides onto a copy and never mutates the base env", async () => {
    const root = await project({ daemonBin: "agents-comm-bus/dist/core-daemon/serve.js" });
    const base = { PATH: "/usr/bin", EXISTING: "keep" };
    const { env, devConfig } = applyDevConfig(base, root);

    assert.equal(devConfig.status, "applied");
    assert.equal(env.AGENTS_COMM_BUS_BIN, path.join(root, "agents-comm-bus/dist/core-daemon/serve.js"));
    assert.equal(env.EXISTING, "keep");
    // base must be untouched (no implicit process.env-style mutation)
    assert.equal((base as Record<string, unknown>).AGENTS_COMM_BUS_BIN, undefined);
    assert.deepEqual(base, { PATH: "/usr/bin", EXISTING: "keep" });
  });

  it("leaves the env unchanged when there is no marker", async () => {
    const root = await project(null);
    const base = { PATH: "/usr/bin" };
    const { env } = applyDevConfig(base, root);
    assert.deepEqual(env, { PATH: "/usr/bin" });
  });
});

describe("resolveDevConfig — caller parity", () => {
  it("returns identical env for the same (root, marker) regardless of caller", async () => {
    const root = await project({ daemonBin: "agents-comm-bus/dist/core-daemon/serve.js" });
    // Two independent calls model a hook process and a shim process resolving
    // the same workspace marker — they must agree on source-mode options.
    const fromHook = resolveDevConfig(root);
    const fromShim = resolveDevConfig(root);
    assert.deepEqual(fromHook.env, fromShim.env);
    assert.equal(fromHook.status, fromShim.status);
  });
});
