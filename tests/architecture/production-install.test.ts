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

// Reproduces a FRESH MARKETPLACE INSTALL (production mode) against the REAL
// staged plugin artifacts — the path an end user actually hits. The existing
// entry-ensures tests only prove the wiring with SYNTHETIC fixtured bundles, so
// they pass even though the real staged plugin can't install. These two checks
// close that gap.
//
// They are marked `todo` because they currently FAIL on known release blockers
// (so the 301-green suite stays green while the gap is tracked, but the gate is
// visible as an expected failure and actually runs the repro). When the
// packaging is fixed they go GREEN — at that point DROP the `todo` to turn them
// into a hard release gate that fails if production install regresses.
//
// Blockers (both independently reproduced):
//   B1 — stage-plugins never emits the flat daemon.bundle.js /
//        telegram.adapter.bundle.js that the production install plan copies, so
//        entryEnsures throws ENOENT before the daemon is ensured.
//   B2 — the staged agents-comm-bus/dist is raw tsc output importing
//        agents-comm-bus-core + ws + node-telegram-bot-api, none vendored or
//        bundled into the plugin, so the daemon entry can't load in isolation.

const repoRoot = path.resolve(import.meta.dirname, "../..");
const STAGED_CLAUDE_PLUGIN = path.join(repoRoot, "plugins", "claude", "telegram");
const run = promisify(execFile);

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
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

describe("production marketplace install (release gate)", () => {
  it(
    "B1: production entryEnsures completes against the REAL staged plugin",
    {
      todo:
        "stage-plugins does not emit daemon.bundle.js / telegram.adapter.bundle.js; " +
        "production entryEnsures throws ENOENT copying them before the daemon spawns",
    },
    async () => {
      const stateRoot = await tempDir("acb-prod-state-");
      const daemon = spyEnsureDaemon();

      // Point the real production install path (applyDevConfig -> ensureCentralInstall
      // -> ensureDaemon) at the ACTUAL staged marketplace artifact. env has no
      // AGENTS_COMM_BUS_BIN and the dir has no dev marker, so this is production mode.
      await entryEnsures({
        agent: "claude",
        comm: "telegram",
        stateRoot,
        pluginInstallDir: STAGED_CLAUDE_PLUGIN,
        env: {},
        deps: { ensureDaemon: daemon.fn },
      });

      assert.equal(daemon.called, 1, "central install must succeed so the daemon is ensured");
    },
  );

  it(
    "B2: the staged daemon entry loads self-contained from an isolated copy",
    {
      todo:
        "staged agents-comm-bus/dist imports agents-comm-bus-core/ws/node-telegram-bot-api " +
        "which are not vendored or bundled into the plugin; serve.js fails ERR_MODULE_NOT_FOUND in isolation",
    },
    async () => {
      // Copy the staged plugin OUTSIDE the repo so the workspace node_modules /
      // agents-comm-bus-core symlink cannot mask missing runtime deps.
      const isolatedRoot = await tempDir("acb-prod-iso-");
      const isolated = path.join(isolatedRoot, "telegram");
      await cp(STAGED_CLAUDE_PLUGIN, isolated, { recursive: true });

      const serve = path.join(isolated, "agents-comm-bus", "dist", "core-daemon", "serve.js");
      assert.ok(existsSync(serve), "staged plugin must contain the daemon entry serve.js");

      // serve.js guards main() behind an `import.meta.url === argv[1]` check, so a
      // dynamic import only resolves the static import graph (throwing on the first
      // unresolved module) WITHOUT starting a real daemon.
      const serveUrl = pathToFileURL(serve).href;
      const result = await run(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(serveUrl)}); console.log("LOADED_OK");`],
        { cwd: isolatedRoot, timeout: 30000 },
      ).catch((error: { stdout?: string; stderr?: string }) => ({
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? String(error),
      }));

      assert.match(
        result.stdout,
        /LOADED_OK/,
        `staged daemon entry is not self-contained:\n${result.stderr}`,
      );
    },
  );
});
