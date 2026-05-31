import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { entryEnsures } from "../../hosts/common/install/entry-ensures.js";
import { resolveCentralPaths } from "../../hosts/common/install/node-fs-seam.js";
import { connectIpc } from "../../core-daemon/ipc/client.js";
import { DAEMON_VERSION } from "../../core-daemon/config.js";

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

async function waitForPortFile(stateRoot: string, timeoutMs = 5_000): Promise<number> {
  const portFile = path.join(stateRoot, "port");
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const port = Number((await readFile(portFile, "utf8")).trim());
      if (Number.isInteger(port) && port > 0) return port;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for daemon port file at ${portFile}: ${String(lastError)}`);
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
      assert.ok(
        existsSync(path.join(path.dirname(paths.adapterBundle), "package.json")),
        "adapters/package.json ESM pin written",
      );
    });

    it(`B2[${agent}]: the staged daemon bundle loads self-contained from an isolated copy`, async () => {
      const isolated = await isolatedCopy(agent, comm);
      const bundle = path.join(isolated, "daemon.bundle.js");
      assert.ok(existsSync(bundle), "staged plugin must contain daemon.bundle.js");
      const bundleText = await readFile(bundle, "utf8");
      assert.doesNotMatch(
        bundleText,
        /node-telegram-bot-api|TelegramCommAdapterFactory/,
        "daemon bundle must be comm-neutral; Telegram belongs in the adapter bundle",
      );

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
      const cliText = await readFile(cli, "utf8");
      assert.doesNotMatch(
        cliText,
        /node-telegram-bot-api|TelegramCommAdapterFactory/,
        "CLI bundle must be comm-neutral; token identity probing belongs behind daemon IPC",
      );

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

    it(`B5[${agent}]: the real central daemon loads the installed adapter bundle`, async () => {
      const staged = stagedPluginDir(agent, comm);
      const stateRoot = await tempDir(`acb-prod-real-daemon-${agent}-`);

      const result = await entryEnsures({
        agent,
        comm,
        stateRoot,
        pluginInstallDir: staged,
        env: {},
      });

      const paths = resolveCentralPaths(stateRoot, comm);
      const pid = Number((await readFile(path.join(stateRoot, "daemon.pid"), "utf8")).trim());
      try {
        assert.ok(result.spawned, "production gate should exercise a real daemon spawn");
        assert.ok(existsSync(paths.daemonBundle), "central bin/daemon.js exists");
        assert.ok(existsSync(paths.adapterBundle), "central adapters/<comm>.js exists");

        const client = await connectIpc({
          port: result.port,
          clientVersion: DAEMON_VERSION,
          timeoutMs: 2_000,
          metadata: { test: "production-install-adapter-load", agent },
        });
        try {
          const drained = await client.request("telegram_check_messages");
          assert.deepEqual(
            drained,
            [],
            "telegram IPC method proves the dynamic adapter factory loaded",
          );
        } finally {
          client.close();
        }
      } finally {
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Best-effort cleanup: the temp daemon may have already exited.
          }
        }
      }
    });
  }

  it("source/dev daemon loads built adapter factories without central install", async () => {
    const stateRoot = await tempDir("acb-dev-source-daemon-");
    const daemonEntry = path.join(
      repoRoot,
      "agents-comm-bus",
      "dist",
      "core-daemon",
      "serve.js",
    );
    const child = spawn(process.execPath, [daemonEntry, "serve"], {
      stdio: "ignore",
      env: {
        ...process.env,
        AGENTS_COMM_BUS_BIN: daemonEntry,
        AGENTS_COMM_BUS_STATE_ROOT: stateRoot,
      },
    });
    try {
      const port = await waitForPortFile(stateRoot);
      const client = await connectIpc({
        port,
        clientVersion: DAEMON_VERSION,
        timeoutMs: 2_000,
        metadata: { test: "source-mode-adapter-load" },
      });
      try {
        const drained = await client.request("telegram_check_messages");
        assert.deepEqual(
          drained,
          [],
          "source-mode daemon should infer dist/adapters and load Telegram",
        );
      } finally {
        client.close();
      }
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("probe_comm_identity dispatches through loaded comm adapter factories", async () => {
    const stateRoot = await tempDir("acb-probe-identity-state-");
    const adaptersDir = await tempDir("acb-probe-identity-adapters-");
    await writeFile(path.join(adaptersDir, "package.json"), '{ "type": "module" }\n', "utf8");
    await writeFile(
      path.join(adaptersDir, "fake.js"),
      `export function createCommAdapterFactory() {
        return {
          commId: "fake",
          async resolveCredentials() { return undefined; },
          create() { throw new Error("not used"); },
          async probeIdentity(credentials) {
            return {
              accountId: "acct-" + String(credentials.botToken),
              accountUsername: "user-" + String(credentials.botToken),
            };
          },
        };
      }\n`,
      "utf8",
    );
    await writeFile(
      path.join(adaptersDir, "noprobe.js"),
      `export function createCommAdapterFactory() {
        return {
          commId: "noprobe",
          async resolveCredentials() { return undefined; },
          create() { throw new Error("not used"); },
        };
      }\n`,
      "utf8",
    );

    const daemonEntry = path.join(
      repoRoot,
      "agents-comm-bus",
      "dist",
      "core-daemon",
      "serve.js",
    );
    const child = spawn(process.execPath, [daemonEntry, "serve"], {
      stdio: "ignore",
      env: {
        ...process.env,
        AGENTS_COMM_BUS_BIN: daemonEntry,
        AGENTS_COMM_BUS_ADAPTERS_DIR: adaptersDir,
        AGENTS_COMM_BUS_STATE_ROOT: stateRoot,
      },
    });
    try {
      const port = await waitForPortFile(stateRoot);
      const client = await connectIpc({
        port,
        clientVersion: DAEMON_VERSION,
        timeoutMs: 2_000,
        metadata: { test: "probe-comm-identity" },
      });
      try {
        const probed = await client.request("probe_comm_identity", {
          comm: "fake",
          credentials: { botToken: "token-1" },
        });
        assert.deepEqual(probed, {
          comm: "fake",
          account_id: "acct-token-1",
          account_username: "user-token-1",
        });
        await assert.rejects(
          () => client.request("probe_comm_identity", {
            comm: "missing",
            credentials: { botToken: "token-1" },
          }),
          /no comm adapter factory is loaded for missing/,
        );
        await assert.rejects(
          () => client.request("probe_comm_identity", {
            comm: "noprobe",
            credentials: { botToken: "token-1" },
          }),
          /comm adapter noprobe does not support identity probing/,
        );
      } finally {
        client.close();
      }
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("staged CLI can bootstrap a fresh production central install before probing", async () => {
    const isolated = await isolatedCopy("claude", "telegram");
    const homeRoot = await tempDir("acb-cli-bootstrap-home-");
    const stateRoot = path.join(homeRoot, ".agents-comm-bus");
    const fakeAdapter = path.join(isolated, "telegram.adapter.bundle.js");
    const cli = path.join(isolated, "cli.bundle.js");
    assert.ok(existsSync(cli), "staged plugin must contain cli.bundle.js");

    // Replace only the staged adapter with a tiny no-network factory. The CLI
    // must still central-install and spawn the real daemon bundle before probing.
    await writeFile(
      fakeAdapter,
      `export function createCommAdapterFactory() {
        return {
          commId: "telegram",
          async resolveCredentials() { return undefined; },
          fallbackFromEnv() { return undefined; },
          create() { throw new Error("not used by this test"); },
          async probeIdentity(credentials) {
            return {
              accountId: "bot-from-" + String(credentials.botToken),
              accountUsername: "bootstrap_bot",
            };
          },
          ipcMethods() { return new Map(); },
        };
      }\n`,
      "utf8",
    );

    try {
      const result = await run(
        process.execPath,
        [
          cli,
          "account-add",
          "--project",
          isolated,
          "--agent",
          "claude",
          "--account-label",
          "main",
          "--bot-token",
          "fake-token",
        ],
        {
          cwd: isolated,
          timeout: 30000,
          env: {
            ...process.env,
            AGENTS_COMM_BUS_ROOT: stateRoot,
            HOME: homeRoot,
            USERPROFILE: homeRoot,
          },
        },
      );
      const output = JSON.parse(result.stdout);
      assert.equal(output.bot_user_id, "bot-from-fake-token");
      assert.equal(output.bot_username, "bootstrap_bot");
      assert.ok(existsSync(path.join(stateRoot, "bin", "daemon.js")), "CLI central-installed daemon");
    } finally {
      try {
        const pid = Number((await readFile(path.join(stateRoot, "daemon.pid"), "utf8")).trim());
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
      } catch {
        // The assertion failure already carries the useful signal.
      }
    }
  });
});
