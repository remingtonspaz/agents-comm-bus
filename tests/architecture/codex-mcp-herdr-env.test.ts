import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { CODEX_MCP_ENV_VAR_NAMES } from "../../hosts/codex/mcp-env-vars.js";

// AGE-110 bug D: Codex forwards ONLY the `env_vars` allowlist to stdio MCP
// shims. The allowlist lacked HERDR_*, so the Codex MCP shim in a herdr pane
// fell back to the cwd-hash session id and took the lease on a non-herdr row,
// while the hooks + herdr plugin used the herdr_ id. Every HERDR_* variable the
// shared identity helper reads must be forwarded.

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("AGE-110: Codex MCP env allowlist forwards herdr identity", () => {
  it("every HERDR_* var read by hosts/common/herdr-env.js is in CODEX_MCP_ENV_VAR_NAMES", async () => {
    const source = await readFile(path.join(repoRoot, "hosts/common/herdr-env.js"), "utf8");
    const read = [...new Set(source.match(/HERDR_[A-Z_]+/g) ?? [])].sort();
    assert.ok(read.includes("HERDR_PANE_ID") && read.includes("HERDR_SOCKET_PATH"), `unexpected scan: ${read}`);
    const missing = read.filter((name) => !CODEX_MCP_ENV_VAR_NAMES.includes(name));
    assert.deepEqual(missing, [], `Codex MCP shims would not see: ${missing.join(", ")}`);
  });

  it("every staged Codex plugin .mcp.json forwards the same HERDR_* vars", async () => {
    for (const comm of ["telegram", "discord", "matrix", "curl"]) {
      const raw = await readFile(path.join(repoRoot, "plugins/codex", comm, ".mcp.json"), "utf8");
      const text = JSON.stringify(JSON.parse(raw));
      for (const name of CODEX_MCP_ENV_VAR_NAMES.filter((n) => n.startsWith("HERDR_"))) {
        assert.ok(text.includes(`"${name}"`), `plugins/codex/${comm}/.mcp.json does not forward ${name}`);
      }
    }
  });
});
