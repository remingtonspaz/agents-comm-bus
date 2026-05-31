import assert from "node:assert/strict";
import { cp, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { entryEnsures } from "../../hosts/common/install/entry-ensures.js";
import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";

// Reproduces a FRESH MARKETPLACE INSTALL (production mode) against the REAL
// staged plugin artifacts — the path an end user actually hits, which the
// synthetic entry-ensures fixtures do not exercise. These are HARD release
// gates: a regression in the production packaging fails the suite.
//
// Run `npm --workspace agents-comm-bus run build:bundles` then
// `node scripts/stage-plugins.js` before this test (CI build order); the
// asserts below explain the fix if the staged artifacts are missing/stale.
//
//   B1 — production entryEnsures (applyDevConfig -> ensureCentralInstall ->
//        executeInstallPlan -> ensureDaemon) completes against the real staged
//        plugin: the flat daemon.bundle.js / <comm>.adapter.bundle.js it copies
//        exist, and the schema sidecars land next to bin/daemon.js.
//   B2 — the staged daemon bundle loads self-contained from an isolated copy
//        (no agents-comm-bus-core / ws / node-telegram-bot-api resolution error).
//   B3 — the staged hook entries (which inline the daemon client) also load
//        self-contained from an isolated copy.

const repoRoot = path.resolve(import.meta.dirname, "../..");
const run = promisify(execFile);

const PLUGINS = [
  { agent: "claude", comm: "telegram" },
  { agent: "codex", comm: "telegram" },
] as const;

function stagedPluginDir(agent: string, comm: string): string {
  return path.join(repoRoot, "plugins", agent, comm);
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Copy the staged plugin OUTSIDE the repo so the workspace node_modules /
 *  agents-comm-bus-core symlink cannot mask a missing runtime dep. */
async function isolatedCopy(agent: string, comm: string): Promise<string> {
  const root = await tempDir(`acb-prod-iso-${agent}-`);
  const dest = path.join(root, comm);
  await cp(stagedPluginDir(agent, comm), dest, { recursive: true });
  return dest;
}

function spyEnsureDaemon() {
  let calls = 0;
  const fn = async (): Promise<Record<string, unknown>> => {
    calls += 1;
    return { port: 51999, hello: { daemonName: "agents-comm-bus" }, spawned: false };
  };
  return {
    fn,
    get called() {
      return calls;
    },
  };
}

const MODULE_RESOLUTION_FAILURE = /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/i;

describe("production marketplace install (release gate)", () => {
  for (const { agent, comm } of PLUGINS) {
    it(`B1[${agent}]: production entryEnsures completes against the REAL staged plugin`, async () => {
      const staged = stagedPluginDir(agent, comm);
      assert.ok(
        existsSync(path.join(staged, "install-stamp.json")),
        `staged plugin missing — run 'npm --workspace agents-comm-bus run build:bundles' then 'node scripts/stage-plugins.js' (expected ${staged})`,
      );

      const stateRoot = await tempDir(`acb-prod-state-${agent}-`);
      const daemon = spyEnsureDaemon();

      // env has no AGENTS_COMM_BUS_BIN and the dir has no dev marker, so this is
      // production mode pointed at the ACTUAL staged marketplace artifact.
      const result = await entryEnsures({
        agent,
        comm,
        stateRoot,
        pluginInstallDir: staged,
        env: {},
        deps: { ensureDaemon: daemon.fn },
      });

      assert.equal(result.centralInstall.mode, "production");
      assert.equal(daemon.called, 1, "central install must succeed so the daemon is ensured");

      // The real central install landed the daemon bundle, its ESM pin, and the
      // migration sidecars next to bin/daemon.js — i.e. a runnable daemon.
      const paths = resolveCentralPaths(stateRoot, comm);
      const binDir = path.dirname(paths.daemonBundle);
      assert.ok(existsSync(paths.daemonBundle), "bin/daemon.js copied");
      assert.ok(existsSync(path.join(binDir, "package.json")), "bin/package.json ESM pin written");
      assert.ok(
        existsSync(path.join(binDir, "001_initial.sql")),
        "schema sidecars copied next to bin/daemon.js",
      );
      assert.ok(existsSync(paths.adapterBundle), "adapters/<comm>.js copied");
    });

    it(`B2[${agent}]: the staged daemon bundle loads self-contained from an isolated copy`, async () => {
      const isolated = await isolatedCopy(agent, comm);
      const bundle = path.join(isolated, "daemon.bundle.js");
      assert.ok(existsSync(bundle), "staged plugin must contain daemon.bundle.js");

      // serve.ts guards main() behind `import.meta.url === argv[1]`, and `node -e`
      // leaves argv[1] unset, so a dynamic import only resolves the static import
      // graph (throwing on the first unresolved module) WITHOUT starting a daemon.
      const bundleUrl = pathToFileURL(bundle).href;
      const result = await run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(bundleUrl)}); console.log("LOADED_OK");`,
        ],
        { cwd: isolated, timeout: 30000 },
      ).catch((error: { stdout?: string; stderr?: string }) => ({
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? String(error),
      }));

      assert.match(
        result.stdout,
        /LOADED_OK/,
        `staged daemon bundle is not self-contained:\n${result.stderr}`,
      );
    });

    it(`B3[${agent}]: the staged hook entries load self-contained from an isolated copy`, async () => {
      const isolated = await isolatedCopy(agent, comm);
      const hooksDir = path.join(isolated, "hooks");
      const hooks = ["user-prompt-submit.js", "permission-request.js", "session-start.js"];

      // Each hook kicks off a fire-and-forget main() at module scope, so a
      // dynamic import resolves as soon as the static import graph LINKS — an
      // unresolved module rejects first. We exit(0) immediately on link, before
      // main() does any real work, so this is fast and has no daemon/state side
      // effects. AGENTS_COMM_BUS_ROOT is pointed at a throwaway dir as a belt.
      const stateRoot = await tempDir(`acb-prod-hookroot-${agent}-`);
      for (const hook of hooks) {
        const hookPath = path.join(hooksDir, hook);
        assert.ok(existsSync(hookPath), `staged plugin must contain hooks/${hook}`);

        const hookUrl = pathToFileURL(hookPath).href;
        const result = await run(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `await import(${JSON.stringify(hookUrl)}); console.log("LINKED_OK"); process.exit(0);`,
          ],
          { cwd: isolated, timeout: 30000, env: { ...process.env, AGENTS_COMM_BUS_ROOT: stateRoot } },
        ).catch((error: { stdout?: string; stderr?: string }) => ({
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? String(error),
        }));

        assert.doesNotMatch(
          result.stderr,
          MODULE_RESOLUTION_FAILURE,
          `staged hook ${agent}/hooks/${hook} is not self-contained:\n${result.stderr}`,
        );
        assert.match(
          result.stdout,
          /LINKED_OK/,
          `staged hook ${agent}/hooks/${hook} failed to link:\n${result.stderr}`,
        );
      }
    });

    it(`B4[${agent}]: the staged CLI runs self-contained from an isolated copy`, async () => {
      const isolated = await isolatedCopy(agent, comm);
      const cli = path.join(isolated, "cli.bundle.js");
      assert.ok(existsSync(cli), "staged plugin must contain cli.bundle.js");

      // The CLI is the first user action (account-add). Run it with NO args: it
      // links the whole graph, then prints help and exits 0 — no daemon/DB.
      const result = await run(process.execPath, [cli], { cwd: isolated, timeout: 30000 }).catch(
        (error: { stdout?: string; stderr?: string }) => ({
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? String(error),
        }),
      );

      // (a) self-contained: no missing module at link time.
      assert.doesNotMatch(
        `${result.stdout}\n${result.stderr}`,
        MODULE_RESOLUTION_FAILURE,
        `staged CLI is not self-contained:\n${result.stderr}`,
      );
      // (b) it actually linked + ran (help banner on stderr).
      assert.match(
        result.stderr,
        /agents-comm-bus CLI/,
        `staged CLI failed to run:\n${result.stdout}\n${result.stderr}`,
      );
      // (c) regression guard: bundling collapses every module's import.meta.url to
      // the bundle URL, so a dependency's `import.meta.url === argv[1]` self-run
      // guard (migrate.ts) would fire on EVERY invocation and dump a legacy-state
      // scan to stdout. A no-arg CLI must print nothing to stdout.
      assert.doesNotMatch(
        result.stdout,
        /migration_scan_started|"schema_version"/,
        `staged CLI ran an unintended bundled self-run entry (stdout should be empty):\n${result.stdout.slice(0, 400)}`,
      );
    });
  }
});
