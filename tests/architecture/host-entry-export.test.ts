import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// AGE-60/61 — package-boundary proof for the host-runtime export.
//
// Proves an EXTERNAL consumer (a dir outside the repo source tree whose only
// view of the package is node_modules/agents-comm-bus) can import
// `agents-comm-bus/host-entry` purely through `package.json` `exports`, with NO
// reach-back into `hosts/` or a monorepo-relative/deep path.

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL("../../agents-comm-bus", import.meta.url));

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("AGE-60/61 host-entry package export boundary", () => {
  it("a consumer outside the repo imports agents-comm-bus/host-entry via exports", async () => {
    const consumer = await tempDir("acb-he-consumer-");
    const nodeModules = path.join(consumer, "node_modules");
    await mkdir(nodeModules, { recursive: true });
    await symlink(
      packageDir,
      path.join(nodeModules, "agents-comm-bus"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const probe = [
      "const url = import.meta.resolve('agents-comm-bus/host-entry');",
      "if (!url.endsWith('/dist/core-daemon/host-entry.js')) { console.error('resolved=' + url); process.exit(11); }",
      "if (/\\/hosts\\//.test(url)) { console.error('hosts reachback: ' + url); process.exit(12); }",
      "const m = await import('agents-comm-bus/host-entry');",
      "if (typeof m.entryEnsures !== 'function') process.exit(13);",
      "if (typeof m.resolveEntryContext !== 'function') process.exit(14);",
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

    const src = await readFile(path.join(packageDir, "..", "core-daemon", "host-entry.ts"), "utf8");
    assert.doesNotMatch(src, /\bfrom\s+["'][^"']*hosts\//, "host-entry must not import from hosts/");
    assert.doesNotMatch(src, /\brequire\(\s*["'][^"']*hosts\//, "host-entry must not require hosts/");
  });
});
