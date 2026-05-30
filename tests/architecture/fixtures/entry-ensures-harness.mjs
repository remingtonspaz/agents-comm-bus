/**
 * Subprocess harness for the entryEnsures real-installed-path proof.
 *
 * Invoked as: node entry-ensures-harness.mjs <fromDir> <stateRoot>
 *
 * Calls entryEnsures the way a wired hook does — fromDir resolves the plugin
 * install dir (and any dev marker) from the real filesystem, env is empty so we
 * exercise the strict PRODUCTION path, and ensureDaemon is stubbed (we are
 * proving the real central-install file effects, not spawning a daemon). On
 * success prints a JSON line; on failure prints to stderr and exits non-zero —
 * so the test can assert install-before-daemon and fail-before-daemon against
 * the real state root, not a mock.
 */
import { entryEnsures } from "../../../hosts/common/install/entry-ensures.js";

const [, , fromDir, stateRoot] = process.argv;

try {
  const result = await entryEnsures({
    fromDir,
    agent: "claude",
    stateRoot,
    env: {}, // no AGENTS_COMM_BUS_BIN -> strict production path
    deps: {
      ensureDaemon: async () => ({ port: 1, hello: { daemonName: "stub" }, spawned: false }),
    },
    ensureDaemonOptions: {},
  });
  process.stdout.write(
    JSON.stringify({ ok: true, mode: result.centralInstall?.mode, port: result.port }) + "\n",
  );
} catch (error) {
  process.stderr.write(`ENTRY_ENSURES_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(3);
}
