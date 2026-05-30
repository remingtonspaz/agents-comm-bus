/**
 * Subprocess harness for the entryEnsures real-installed-path proof.
 *
 * Invoked as: node entry-ensures-harness.mjs <fromDir>
 *
 * Calls entryEnsures exactly the way a wired hook does — fromDir resolves the
 * plugin install dir (and any dev marker) from the real filesystem, and it
 * passes process.env WITHOUT an explicit stateRoot (the real wired-hook shape;
 * the test controls the state root via AGENTS_COMM_BUS_ROOT in the child env).
 * The earlier harness passed stateRoot explicitly, which masked the production
 * crash where entryEnsures must derive the canonical root itself. ensureDaemon
 * is stubbed (we prove the real central-install file effects, not a daemon
 * spawn) and records the stateRoot it was handed so the test can assert the
 * daemon got the SAME canonical root as central install.
 */
import { entryEnsures } from "../../../hosts/common/install/entry-ensures.js";

const [, , fromDir] = process.argv;

try {
  let daemonStateRoot;
  const result = await entryEnsures({
    fromDir,
    agent: "claude",
    env: process.env, // realistic: hook passes process.env; no explicit stateRoot
    deps: {
      ensureDaemon: async (opts) => {
        daemonStateRoot = opts?.stateRoot;
        return { port: 1, hello: { daemonName: "stub" }, spawned: false };
      },
    },
    ensureDaemonOptions: {},
  });
  process.stdout.write(
    JSON.stringify({ ok: true, mode: result.centralInstall?.mode, port: result.port, daemonStateRoot }) + "\n",
  );
} catch (error) {
  process.stderr.write(`ENTRY_ENSURES_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(3);
}
