/**
 * Per-comm Pi extension for curl. Calls `entryEnsures` for its own comm
 * (central-installs the curl adapter in prod; idempotent no-op in dev).
 * The comm-generic tools + lifecycle live in the bundled @agents-comm-bus/pi-core
 * extension (loaded via this package's pi.extensions manifest). This extension
 * registers NO tools (Pi's flat tool namespace forbids per-comm tool registration).
 */
import { entryEnsures } from "agents-comm-bus/host-entry";

export default async function curlCommExtension(): Promise<void> {
  try {
    await entryEnsures({
      agent: "pi",
      comm: "curl",
      fromDir: import.meta.dirname,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pi-curl] entryEnsures failed: ${message}`);
  }
}
