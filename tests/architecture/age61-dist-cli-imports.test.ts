import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// AGE-61 regression (caught in cross-review): after the entryEnsures cluster moved
// into core-daemon/host-runtime and the copy-assets `dist/hosts/...` hop-back shim
// was removed, the PACKAGED dist CLI must not import that removed shim. The bug:
// `core-daemon/cli/identity-probe.ts` still imported
// `../../hosts/common/install/entry-ensures.js`, which dangles in the package dist
// (ERR_MODULE_NOT_FOUND) once the shim is gone. Source-side tests miss it because
// they exercise the still-present `hosts/` SOURCE re-exports, not the dist module.

const distCliUrl = new URL(
  "../../agents-comm-bus/dist/core-daemon/cli/identity-probe.js",
  import.meta.url,
);

describe("AGE-61 packaged dist CLI imports cleanly", () => {
  it("dist identity-probe.js has no dist/hosts reachback and loads from the package dist", async () => {
    const src = await readFile(fileURLToPath(distCliUrl), "utf8");
    assert.doesNotMatch(
      src,
      /hosts[\\/]common[\\/]install/,
      "packaged dist CLI must not import the removed dist/hosts install shim",
    );

    // Actually import it — proves every transitive import resolves from the
    // package dist (this is exactly the ERR_MODULE_NOT_FOUND repro from review).
    const mod = await import(distCliUrl.href);
    assert.equal(typeof mod.probeIdentityViaDaemon, "function");
  });
});
