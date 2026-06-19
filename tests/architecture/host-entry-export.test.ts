import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// AGE-60 — package-boundary proof for the host-runtime export scaffold.
//
// Proves an EXTERNAL consumer (a dir outside the repo source tree whose only
// view of the package is node_modules/agents-comm-bus) can import
// `agents-comm-bus/host-entry` purely through `package.json` `exports`, with NO
// reach-back into `hosts/` or a monorepo-relative/deep path. Resolution is
// driven by Node's `exports` gate, which is what Pi will rely on — so this is a
// faithful "lighter proxy" per the AGE-60 acceptance criteria (no npm pack
// needed; the package has no `files` filter, so the dist tree it exposes is the
// same one a tarball would ship, and `hosts/` is a sibling dir that no
// agents-comm-bus tarball could contain).

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL("../../agents-comm-bus", import.meta.url));

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("AGE-60 host-entry package export boundary", () => {
  it("a consumer outside the repo imports agents-comm-bus/host-entry via exports", async () => {
    // Consumer dir OUTSIDE the repo source tree; its sole view of the package is
    // a node_modules link, so any resolution must go through `exports`.
    const consumer = await tempDir("acb-he-consumer-");
    const nodeModules = path.join(consumer, "node_modules");
    await mkdir(nodeModules, { recursive: true });
    // junction works on Windows without elevation; plain symlink elsewhere.
    await symlink(
      packageDir,
      path.join(nodeModules, "agents-comm-bus"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const probe = [
      "const url = import.meta.resolve('agents-comm-bus/host-entry');",
      // `exports` must map the bare subpath to the dist module — not a deep/relative path.
      "if (!url.endsWith('/dist/core-daemon/host-entry.js')) { console.error('resolved=' + url); process.exit(11); }",
      "if (/\\/hosts\\//.test(url)) { console.error('hosts reachback: ' + url); process.exit(12); }",
      "const m = await import('agents-comm-bus/host-entry');",
      "if (typeof m.entryEnsures !== 'function') process.exit(13);",
      "if (m.HOST_ENTRY_SCAFFOLD !== true) process.exit(14);",
      // a non-exported deep subpath must be blocked by the exports gate.
      "let blocked = false;",
      "try { await import('agents-comm-bus/dist/core-daemon/host-entry.js'); } catch { blocked = true; }",
      "if (!blocked) process.exit(15);",
      "console.log('OK');",
    ].join("\n");

    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: consumer,
    });
    assert.equal(stdout.trim(), "OK", "consumer-context import + exports resolution succeeded");
  });

  it("package.json exports ./host-entry → dist module, and the module has no hosts/ import", async () => {
    const pkg = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };
    const entry = pkg.exports?.["./host-entry"];
    assert.ok(entry, "package.json must declare a ./host-entry exports subpath");
    assert.equal(entry.import, "./dist/core-daemon/host-entry.js");
    assert.equal(entry.types, "./dist/core-daemon/host-entry.d.ts");

    // The scaffold must not pull in the hosts/ install cluster (that's AGE-61).
    const src = await readFile(path.join(packageDir, "..", "core-daemon", "host-entry.ts"), "utf8");
    assert.doesNotMatch(src, /\bfrom\s+["'][^"']*hosts\//, "host-entry scaffold must not import from hosts/");
    assert.doesNotMatch(src, /\brequire\(\s*["'][^"']*hosts\//, "host-entry scaffold must not require hosts/");
  });
});
