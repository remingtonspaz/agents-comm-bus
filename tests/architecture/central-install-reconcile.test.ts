import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  reconcileInstall,
  executeInstallPlan,
  compareVersions,
  VERSION_FILE_SCHEMA,
} from "../../hosts/common/install/reconcile-central-install.js";

// ---------------------------------------------------------------------------
// Builders — keep each test readable by defaulting the boring fields.
// ---------------------------------------------------------------------------

type Agent = "claude" | "codex";

interface ActorOverrides {
  agent?: Agent;
  comm?: string;
  pluginVersion?: string;
  daemonBundleVersion?: string;
  adapterBundleVersion?: string;
  installedAt?: string;
}

function actor(o: ActorOverrides = {}) {
  return {
    agent: o.agent ?? "claude",
    comm: o.comm ?? "telegram",
    pluginVersion: o.pluginVersion ?? "1.0.0",
    daemonBundleVersion: o.daemonBundleVersion ?? "1.0.0",
    adapterBundleVersion: o.adapterBundleVersion ?? "1.0.0",
    pluginInstallDir: "/fake/plugin",
    installedAt: o.installedAt ?? "2026-05-18T20:25:00Z",
  };
}

const EMPTY_STATE = {
  daemonExists: false,
  daemonVersionFile: null,
  adapterExists: false,
  adapterVersionFile: null,
  daemonRunning: false,
};

/** Apply a plan's resulting metadata back into a CentralState, as execute would. */
function applied(state: any, plan: any) {
  return {
    daemonExists: state.daemonExists || plan.daemon.writeBundle,
    daemonVersionFile: plan.daemon.writeVersionFile ? plan.daemon.resultingVersionFile : state.daemonVersionFile,
    adapterExists: state.adapterExists || plan.adapter.writeBundle,
    adapterVersionFile: plan.adapter.writeVersionFile ? plan.adapter.resultingVersionFile : state.adapterVersionFile,
    daemonRunning: state.daemonRunning,
  };
}

// ---------------------------------------------------------------------------
// T1 — pure reconciliation logic
// ---------------------------------------------------------------------------

describe("compareVersions", () => {
  it("orders dotted release versions numerically", () => {
    assert.equal(compareVersions("2.0.0", "1.0.0"), 1);
    assert.equal(compareVersions("1.0.0", "2.0.0"), -1);
    assert.equal(compareVersions("1.2.0", "1.10.0"), -1); // numeric, not lexical
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  });
});

describe("reconcileInstall — cold install", () => {
  it("lays down daemon + adapter from empty state", () => {
    const plan = reconcileInstall(actor(), EMPTY_STATE);

    assert.equal(plan.daemon.writeBundle, true);
    assert.equal(plan.daemon.writeVersionFile, true);
    assert.equal(plan.adapter.writeBundle, true);
    assert.equal(plan.adapter.writeVersionFile, true);
    assert.equal(plan.requiresSpawn, true); // no daemon running yet

    const dv = plan.daemon.resultingVersionFile;
    assert.equal(dv.schema_version, VERSION_FILE_SCHEMA);
    assert.equal(dv.content_kind, "daemon");
    assert.equal(dv.content_version, "1.0.0");
    assert.equal(dv.installed_by.length, 1);

    const av = plan.adapter.resultingVersionFile;
    assert.equal(av.content_kind, "adapter");
    assert.equal(av.content_id, "telegram");
  });
});

describe("reconcileInstall — idempotency", () => {
  it("same actor rerun is a no-op (no bundle copy, no version rewrite)", () => {
    const first = reconcileInstall(actor(), EMPTY_STATE);
    const state2 = applied(EMPTY_STATE, first);

    // Rerun, but a later timestamp must NOT cause churn on its own.
    const second = reconcileInstall(actor({ installedAt: "2026-05-20T00:00:00Z" }), state2);

    assert.equal(second.daemon.writeBundle, false);
    assert.equal(second.daemon.writeVersionFile, false);
    assert.equal(second.adapter.writeBundle, false);
    assert.equal(second.adapter.writeVersionFile, false);
  });
});

describe("reconcileInstall — second agent, same comm, same versions", () => {
  it("merges installed_by without rewriting the blob", () => {
    const first = reconcileInstall(actor({ agent: "claude" }), EMPTY_STATE);
    const state2 = applied(EMPTY_STATE, first);

    const second = reconcileInstall(actor({ agent: "codex" }), state2);

    assert.equal(second.daemon.writeBundle, false, "same bundle version -> no recopy");
    assert.equal(second.daemon.writeVersionFile, true, "provenance changed -> rewrite metadata");
    assert.equal(second.daemon.resultingVersionFile.content_version, "1.0.0");
    assert.equal(second.daemon.resultingVersionFile.installed_by.length, 2);
    const agents = second.daemon.resultingVersionFile.installed_by.map((e: any) => e.agent).sort();
    assert.deepEqual(agents, ["claude", "codex"]);
  });
});

describe("reconcileInstall — upgrade", () => {
  it("newer daemon bundle replaces the installed one", () => {
    const first = reconcileInstall(actor({ daemonBundleVersion: "1.0.0" }), EMPTY_STATE);
    const state2 = applied(EMPTY_STATE, first);

    const second = reconcileInstall(actor({ agent: "codex", daemonBundleVersion: "2.0.0" }), state2);

    assert.equal(second.daemon.writeBundle, true);
    assert.equal(second.daemon.contentReplaced, true);
    assert.equal(second.daemon.resultingVersionFile.content_version, "2.0.0");
    assert.equal(second.daemon.resultingVersionFile.content_source.agent, "codex");
  });
});

describe("reconcileInstall — no downgrade", () => {
  it("older daemon bundle does NOT replace a newer installed one", () => {
    const seeded = reconcileInstall(actor({ daemonBundleVersion: "2.0.0" }), EMPTY_STATE);
    const state2 = applied(EMPTY_STATE, seeded);

    const older = reconcileInstall(actor({ agent: "codex", daemonBundleVersion: "1.0.0" }), state2);

    assert.equal(older.daemon.writeBundle, false);
    assert.equal(older.daemon.contentReplaced, false);
    assert.equal(older.daemon.resultingVersionFile.content_version, "2.0.0");
    // ...but it still gets recorded as a referencing installer.
    assert.equal(older.daemon.writeVersionFile, true);
    assert.equal(older.daemon.resultingVersionFile.installed_by.length, 2);
  });
});

describe("reconcileInstall — REGRESSION: plugin_version must not drive blob replacement", () => {
  it("higher plugin_version carrying an OLDER daemon bundle does not replace the newer daemon", () => {
    // Installed: matrix plugin@1.2.0 that shipped daemon bundle 2.0.0.
    const seeded = reconcileInstall(
      actor({ agent: "claude", comm: "matrix", pluginVersion: "1.2.0", daemonBundleVersion: "2.0.0" }),
      EMPTY_STATE,
    );
    const state2 = applied(EMPTY_STATE, seeded);

    // Incoming: telegram plugin@1.3.0 (HIGHER plugin_version) re-bundling the
    // OLD daemon 1.0.0. A naive plugin-version-keyed rule would downgrade.
    const hotfix = reconcileInstall(
      actor({ agent: "claude", comm: "telegram", pluginVersion: "1.3.0", daemonBundleVersion: "1.0.0" }),
      state2,
    );

    assert.equal(hotfix.daemon.writeBundle, false, "must not overwrite the newer daemon blob");
    assert.equal(hotfix.daemon.contentReplaced, false);
    assert.equal(hotfix.daemon.resultingVersionFile.content_version, "2.0.0", "blob version is the only replace key");

    // Provenance stays honest: plugin_version and bundle_version diverge.
    const tgEntry = hotfix.daemon.resultingVersionFile.installed_by.find((e: any) => e.comm === "telegram");
    assert.ok(tgEntry);
    assert.equal(tgEntry.plugin_version, "1.3.0");
    assert.equal(tgEntry.bundle_version, "1.0.0");
    assert.equal(hotfix.daemon.resultingVersionFile.content_source.bundle_version, "2.0.0");
  });
});

describe("reconcileInstall — reference counting keyed on (agent, comm)", () => {
  it("one agent installing two comm plugins yields two distinct daemon references", () => {
    const tg = reconcileInstall(actor({ agent: "claude", comm: "telegram" }), EMPTY_STATE);

    // Installing the *matrix* adapter next: carry the shared daemon state
    // forward, but adapter state is per-comm so matrix's adapter is null (the
    // telegram adapter file is a different artifact, irrelevant here).
    const daemonState = {
      daemonExists: true,
      daemonVersionFile: tg.daemon.resultingVersionFile,
      adapterExists: false,
      adapterVersionFile: null,
      daemonRunning: false,
    };

    const mx = reconcileInstall(actor({ agent: "claude", comm: "matrix" }), daemonState);

    // claude appears twice in the shared daemon's reference set — once per comm
    // plugin — so uninstalling one comm plugin can't orphan the daemon that the
    // other still needs.
    const refs = mx.daemon.resultingVersionFile.installed_by.map((e: any) => `${e.agent}:${e.comm}`).sort();
    assert.deepEqual(refs, ["claude:matrix", "claude:telegram"]);
  });
});

describe("executeInstallPlan — partial-install guard", () => {
  it("rejects a plan that requires a bundle copy with no pluginInstallDir, writing nothing", async () => {
    const calls: string[] = [];
    const fakeFs = {
      mkdirp: async (d: string) => { calls.push(`mkdirp:${d}`); },
      copyFile: async (a: string, b: string) => { calls.push(`copy:${a}->${b}`); },
      writeFile: async (f: string, _data: string) => { calls.push(`write:${f}`); },
    };
    const paths = {
      daemonBundle: "/central/bin/daemon.js",
      daemonVersionFile: "/central/bin/version.json",
      adapterBundle: "/central/adapters/telegram.js",
      adapterVersionFile: "/central/adapters/telegram.version.json",
    };

    // Cold install plan (writeBundle=true) but actor has no pluginInstallDir.
    const noSrcActor = { ...actor(), pluginInstallDir: undefined as unknown as string };
    const plan = reconcileInstall(noSrcActor, EMPTY_STATE);
    assert.equal(plan.daemon.writeBundle, true);

    await assert.rejects(
      () => executeInstallPlan(plan, noSrcActor, paths, fakeFs),
      /pluginInstallDir is unset/,
    );
    // The critical property: nothing was written before the throw — no
    // version file claiming a blob that was never copied.
    assert.deepEqual(calls, []);
  });
});

describe("reconcileInstall — runtime signals under a live daemon", () => {
  it("flags restart on daemon upgrade and reload on adapter add while running", () => {
    const seeded = reconcileInstall(actor({ daemonBundleVersion: "1.0.0", adapterBundleVersion: "1.0.0" }), EMPTY_STATE);

    // Daemon is up and the telegram adapter is installed. We're now installing
    // the *matrix* adapter — CentralState.adapterVersionFile is scoped to the
    // adapter for the actor's comm, so for matrix it is null (not yet present).
    const running = {
      daemonExists: true,
      daemonVersionFile: seeded.daemon.resultingVersionFile,
      adapterExists: false,
      adapterVersionFile: null,
      daemonRunning: true,
    };

    // codex adds the matrix adapter and ships a newer daemon, daemon already up.
    const next = reconcileInstall(
      actor({ agent: "codex", comm: "matrix", daemonBundleVersion: "2.0.0", adapterBundleVersion: "1.0.0" }),
      running,
    );

    assert.equal(next.requiresSpawn, false, "daemon already running");
    assert.equal(next.requiresDaemonRestart, true, "daemon blob replaced under a live daemon");
    assert.equal(next.requiresAdapterReload, true, "new matrix adapter added under a live daemon");
  });
});
