import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<any> {
  return JSON.parse(await readFile(p, "utf-8"));
}

async function readSourceConst(p: string, name: string): Promise<string> {
  const content = await readFile(p, "utf-8");
  const match = content.match(new RegExp(`export const ${name} = "([^"]+)"`));
  assert.ok(match, `${name} must be exported from ${relative(repoRoot, p)}`);
  return match[1];
}

function assertStageManifestInvariants(manifest: any) {
  assert.strictEqual(manifest.schema_version, 1, "stage manifest schema version");
  assert.strictEqual("staged_at" in manifest, false, "stage manifest must not contain timestamps");
  for (const art of manifest.artifacts) {
    assert.doesNotMatch(art.source, /\\/, "source provenance paths must use / separators");
    assert.doesNotMatch(art.artifact, /\\/, "artifact provenance paths must use / separators");
  }
}

async function assertInstallStamp(base: string, agent: "claude" | "codex") {
  const manifestName = agent === "claude" ? ".claude-plugin" : ".codex-plugin";
  const stamp = await readJson(resolve(base, "install-stamp.json"));
  const plugin = await readJson(resolve(base, `${manifestName}/plugin.json`));
  const daemonVersion = await readSourceConst(resolve(repoRoot, "core-daemon/config.ts"), "DAEMON_VERSION");
  const adapterVersion = await readSourceConst(resolve(repoRoot, "adapters/telegram/version.ts"), "ADAPTER_VERSION");

  assert.deepStrictEqual(stamp, {
    schema_version: 1,
    agent,
    comm: "telegram",
    plugin_version: plugin.version,
    daemon_bundle_version: daemonVersion,
    adapter_bundle_version: adapterVersion,
    daemon_sidecars: [
      "001_initial.sql",
      "002_conversation_agent_identity.sql",
      "003_allowlist.sql",
      "004_session_owner_process.sql",
      "005_conversation_bot_identity.sql",
      "006_registration_identity.sql",
      "007_registration_pk.sql",
      "008_conversation_registration_key.sql",
    ],
  });
}

describe("Claude Telegram artifact tree", () => {
  const base = resolve(repoRoot, "plugins/claude/telegram");

  it("has the Claude plugin manifest", async () => {
    const manifestPath = resolve(base, ".claude-plugin/plugin.json");
    assert.ok(await pathExists(manifestPath), "manifest exists");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    assert.strictEqual(manifest.name, "telegram");
    assert.ok(manifest.mcpServers?.telegram, "declares telegram MCP server");
    assert.ok(manifest.skills?.endsWith("skills/"), "skills field points to ./skills/");
  });

  it("has the assembled skill at skills/telegram/SKILL.md", async () => {
    const skillPath = resolve(base, "skills/telegram/SKILL.md");
    assert.ok(await pathExists(skillPath), "SKILL.md exists");
    const content = await readFile(skillPath, "utf-8");
    assert.ok(content.startsWith("---\n"), "starts with frontmatter");
    assert.ok(content.includes("name:"), "contains name field");
    assert.ok(content.includes("description:"), "contains description field");
    // Exactly one frontmatter block
    const fmCount = Math.floor((content.match(/^---$/gm) || []).length / 2);
    assert.strictEqual(fmCount, 1, "exactly one frontmatter block");
  });

  it("manifest MCP server args reference only local paths", async () => {
    const manifestPath = resolve(base, ".claude-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    const args = manifest.mcpServers?.telegram?.args ?? [];
    for (const arg of args) {
      assert.ok(
        !arg.includes("hosts/") && !arg.startsWith("/"),
        `MCP arg must not reference source or absolute paths: ${arg}`
      );
      assert.ok(
        arg.startsWith("./"),
        `MCP arg must use artifact-local relative path: ${arg}`
      );
    }
  });

  it("has bundled MCP shim", async () => {
    const shimPath = resolve(base, "claude-mcp-shim.js");
    assert.ok(await pathExists(shimPath), "bundled MCP shim exists");
  });

  it("has hooks directory with all expected hooks", async () => {
    const hooksDir = resolve(base, "hooks");
    assert.ok(await pathExists(hooksDir), "hooks directory exists");
    for (const hookName of [
      "hooks.json",
      "permission-request.js",
      "session-start.js",
      "user-prompt-submit.js",
    ]) {
      assert.ok(await pathExists(resolve(hooksDir, hookName)), `${hookName} exists`);
    }
    // wake-support.js is inlined into the hook bundles; it is no longer a standalone file
    assert.ok(!(await pathExists(resolve(hooksDir, "wake-support.js"))), "wake-support.js must not exist as standalone file (inlined into bundles)");
  });

  it("hooks.json commands use artifact-local paths", async () => {
    const hooksJsonPath = resolve(base, "hooks/hooks.json");
    const hooksJson = JSON.parse(await readFile(hooksJsonPath, "utf-8"));
    for (const category of Object.values(hooksJson.hooks || {}) as any[]) {
      for (const entry of category) {
        for (const hook of entry.hooks || []) {
          if (typeof hook.command === "string") {
            assert.ok(
              !hook.command.includes("hosts/") && !hook.command.includes("${CLAUDE_PLUGIN_ROOT}"),
              `hook command must not reference source paths: ${hook.command}`
            );
            assert.ok(
              hook.command.includes("./hooks/"),
              `hook command must use artifact-local path: ${hook.command}`
            );
          }
        }
      }
    }
  });

  it("hook source shimNames use artifact-local paths", async () => {
    // Hooks are now esbuilt bundles; the old path-rewrite transform no longer runs.
    // shimName is a diagnostic label only; assert self-containment via no live source-path imports.
    for (const hookName of ["permission-request.js", "user-prompt-submit.js"]) {
      const content = await readFile(resolve(base, "hooks", hookName), "utf-8");
      assert.doesNotMatch(
        content,
        /from\s+['"][^'"]*hosts\/(claude|codex)\//,
        `${hookName} must not have live import from hosts/...`
      );
      assert.doesNotMatch(
        content,
        /require\(\s*['"][^'"]*hosts\/(claude|codex)\//,
        `${hookName} must not have live require from hosts/...`
      );
    }
  });

  it("has supporting script enter-watcher.ps1", async () => {
    const scriptPath = resolve(base, "scripts/enter-watcher.ps1");
    assert.ok(await pathExists(scriptPath), "enter-watcher.ps1 exists");
  });

  it("wake-support.js references artifact-local watcher script", async () => {
    // wake-support.js is gone; its code is inlined into the hook bundles (e.g. session-start.js).
    const content = await readFile(resolve(base, "hooks/session-start.js"), "utf-8");
    assert.match(content, /enter-watcher\.ps1/, "session-start.js (inlining wake-support) must reference enter-watcher.ps1");
    // Candidate path list includes artifact-local scripts/../scripts/enter-watcher.ps1
    assert.match(
      content,
      /scripts["'],\s*["']enter-watcher\.ps1/,
      "session-start.js must contain artifact-local scripts/ candidate path for enter-watcher.ps1"
    );
  });

  it("has .stage-manifest.json with provenance", async () => {
    const manifestPath = resolve(base, ".stage-manifest.json");
    assert.ok(await pathExists(manifestPath), ".stage-manifest.json exists");
    const manifest = await readJson(manifestPath);
    assert.strictEqual(manifest.agent, "claude");
    assert.strictEqual(manifest.comm, "telegram");
    assert.ok(Array.isArray(manifest.artifacts), "artifacts is array");
    assertStageManifestInvariants(manifest);

    const types = new Set(manifest.artifacts.map((a: any) => a.type));
    assert.ok(types.has("assembled-skill"), "has assembled-skill provenance");
    assert.ok(types.has("skill-fragment"), "has skill-fragment provenance");
    assert.ok(types.has("bundled-mcp-shim"), "has bundled-mcp-shim provenance");
    assert.ok(types.has("runtime-bundle"), "has runtime-bundle provenance");
    assert.ok(types.has("schema-sidecar"), "has schema-sidecar provenance");
    assert.ok(types.has("package-json"), "has package-json provenance");
    assert.ok(types.has("hook-bundle"), "has hook-bundle provenance");
    assert.ok(types.has("hook"), "has hook provenance");
    assert.ok(types.has("install-stamp"), "has install-stamp provenance");
    assert.ok(types.has("manifest"), "has manifest provenance");
    assert.ok(types.has("supporting-script"), "has supporting-script provenance");
    // common-install is no longer staged (bundles are self-contained)
    assert.ok(!types.has("common-install"), "must NOT have common-install provenance (obsolete)");

    // Every artifact must map from a source to an artifact path
    for (const art of manifest.artifacts) {
      assert.ok(art.source, "artifact has source");
      assert.ok(art.artifact, "artifact has artifact path");
      assert.ok(art.type, "artifact has type");
    }
  });

  it("has install-stamp.json with independently sourced versions", async () => {
    await assertInstallStamp(base, "claude");
  });
});

describe("Codex Telegram artifact tree", () => {
  const base = resolve(repoRoot, "plugins/codex/telegram");

  it("has the Codex plugin manifest", async () => {
    const manifestPath = resolve(base, ".codex-plugin/plugin.json");
    assert.ok(await pathExists(manifestPath), "manifest exists");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    assert.strictEqual(manifest.name, "telegram");
    assert.strictEqual(manifest.mcpServers, undefined, "Codex manifest does not declare MCP servers");
    assert.ok(manifest.skills?.endsWith("skills/"), "skills field points to ./skills/");
  });

  it("has a standalone .mcp.json", async () => {
    const mcpPath = resolve(base, ".mcp.json");
    assert.ok(await pathExists(mcpPath), ".mcp.json exists");
    const mcp = JSON.parse(await readFile(mcpPath, "utf-8"));
    assert.ok(mcp.mcpServers?.telegram, "declares telegram MCP server");
  });

  it("has the assembled skill at skills/telegram/SKILL.md", async () => {
    const skillPath = resolve(base, "skills/telegram/SKILL.md");
    assert.ok(await pathExists(skillPath), "SKILL.md exists");
    const content = await readFile(skillPath, "utf-8");
    assert.ok(content.startsWith("---\n"), "starts with frontmatter");
    assert.ok(content.includes("name:"), "contains name field");
    assert.ok(content.includes("description:"), "contains description field");
    const fmCount = Math.floor((content.match(/^---$/gm) || []).length / 2);
    assert.strictEqual(fmCount, 1, "exactly one frontmatter block");
  });

  it("manifest and .mcp.json reference only local paths", async () => {
    const manifestPath = resolve(base, ".codex-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    assert.strictEqual(manifest.mcpServers, undefined, "Codex plugin.json must not contain MCP server declarations");

    const mcpPath = resolve(base, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf-8"));
    const mcpArgs = mcp.mcpServers?.telegram?.args ?? [];
    for (const arg of mcpArgs) {
      assert.ok(
        !arg.includes("hosts/") && !arg.startsWith("/"),
        `.mcp.json arg must not reference source or absolute paths: ${arg}`
      );
      assert.ok(
        arg.startsWith("./"),
        `.mcp.json arg must use artifact-local relative path: ${arg}`
      );
    }
  });

  it("has bundled MCP shim", async () => {
    const shimPath = resolve(base, "codex-mcp-shim.js");
    assert.ok(await pathExists(shimPath), "bundled MCP shim exists");
  });

  it("has hooks directory with expected hooks", async () => {
    const hooksDir = resolve(base, "hooks");
    assert.ok(await pathExists(hooksDir), "hooks directory exists");
    for (const hookName of ["permission-request.js", "session-start.js", "user-prompt-submit.js"]) {
      assert.ok(await pathExists(resolve(hooksDir, hookName)), `${hookName} exists`);
    }
  });

  it("hook source shimNames use artifact-local paths", async () => {
    // Hooks are now esbuilt bundles; the old path-rewrite transform no longer runs.
    // shimName is a diagnostic label only; assert self-containment via no live source-path imports.
    for (const hookName of ["permission-request.js", "session-start.js", "user-prompt-submit.js"]) {
      const content = await readFile(resolve(base, "hooks", hookName), "utf-8");
      assert.doesNotMatch(
        content,
        /from\s+['"][^'"]*hosts\/(claude|codex)\//,
        `${hookName} must not have live import from hosts/...`
      );
      assert.doesNotMatch(
        content,
        /require\(\s*['"][^'"]*hosts\/(claude|codex)\//,
        `${hookName} must not have live require from hosts/...`
      );
    }
  });

  it("session-start.js references artifact-local bootstrap script", async () => {
    const content = await readFile(resolve(base, "hooks/session-start.js"), "utf-8");
    assert.match(content, /bootstrap-codex-session\.ps1/, "session-start.js must reference bootstrap-codex-session.ps1");
    // Candidate path list includes artifact-local scripts/../scripts/bootstrap-codex-session.ps1
    assert.match(
      content,
      /scripts["'],\s*["']bootstrap-codex-session\.ps1/,
      "session-start.js must contain artifact-local scripts/ candidate path for bootstrap-codex-session.ps1"
    );
  });

  it("has supporting script bootstrap-codex-session.ps1", async () => {
    const scriptPath = resolve(base, "scripts/bootstrap-codex-session.ps1");
    assert.ok(await pathExists(scriptPath), "bootstrap-codex-session.ps1 exists");
  });

  it("has .stage-manifest.json with provenance", async () => {
    const manifestPath = resolve(base, ".stage-manifest.json");
    assert.ok(await pathExists(manifestPath), ".stage-manifest.json exists");
    const manifest = await readJson(manifestPath);
    assert.strictEqual(manifest.agent, "codex");
    assert.strictEqual(manifest.comm, "telegram");
    assert.ok(Array.isArray(manifest.artifacts), "artifacts is array");
    assertStageManifestInvariants(manifest);

    const types = new Set(manifest.artifacts.map((a: any) => a.type));
    assert.ok(types.has("assembled-skill"), "has assembled-skill provenance");
    assert.ok(types.has("skill-fragment"), "has skill-fragment provenance");
    assert.ok(types.has("bundled-mcp-shim"), "has bundled-mcp-shim provenance");
    assert.ok(types.has("runtime-bundle"), "has runtime-bundle provenance");
    assert.ok(types.has("schema-sidecar"), "has schema-sidecar provenance");
    assert.ok(types.has("package-json"), "has package-json provenance");
    assert.ok(types.has("hook-bundle"), "has hook-bundle provenance");
    // Codex has no hooks.json, so no "hook" type
    assert.ok(!types.has("hook"), "must NOT have hook provenance (codex has no hooks.json)");
    assert.ok(types.has("install-stamp"), "has install-stamp provenance");
    assert.ok(types.has("manifest"), "has manifest provenance");
    assert.ok(types.has("mcp-config"), "has mcp-config provenance");
    assert.ok(types.has("supporting-script"), "has supporting-script provenance");
    // common-install is no longer staged (bundles are self-contained)
    assert.ok(!types.has("common-install"), "must NOT have common-install provenance (obsolete)");

    for (const art of manifest.artifacts) {
      assert.ok(art.source, "artifact has source");
      assert.ok(art.artifact, "artifact has artifact path");
      assert.ok(art.type, "artifact has type");
    }
  });

  it("has install-stamp.json with independently sourced versions", async () => {
    await assertInstallStamp(base, "codex");
  });
});

describe("Artifact-global invariants", () => {
  it("no staged artifact contains source-only path references", async () => {
    // Bundled .js files legitimately contain hosts/... substrings in esbuild per-module banner
    // COMMENTS (e.g. "// hosts/claude/hooks/wake-support.js") and in shimName string labels.
    // The genuine contract is: no live import/require from source-tree paths.
    const artifactRoots = [
      resolve(repoRoot, "plugins/claude/telegram"),
      resolve(repoRoot, "plugins/codex/telegram"),
    ];
    for (const root of artifactRoots) {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const p = resolve(entry.parentPath ?? root, entry.name);
        if (p.endsWith(".js")) {
          const content = await readFile(p, "utf-8");
          // Ban live import/require statements referencing source hosts/ paths
          assert.doesNotMatch(
            content,
            /from\s+['"][^'"]*hosts\/(claude|codex)\//,
            `staged artifact ${relative(repoRoot, p)} must not have live import from hosts/... source paths`
          );
          assert.doesNotMatch(
            content,
            /require\(\s*['"][^'"]*hosts\/(claude|codex)\//,
            `staged artifact ${relative(repoRoot, p)} must not have live require from hosts/... source paths`
          );
        }
      }
    }
  });

  it("no staged text artifact contains CRLF line endings", async () => {
    const artifactRoots = [
      resolve(repoRoot, "plugins/claude/telegram"),
      resolve(repoRoot, "plugins/codex/telegram"),
    ];
    for (const root of artifactRoots) {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const p = resolve(entry.parentPath ?? root, entry.name);
        if (!/\.(js|json|md|ps1|sql|map)$/.test(entry.name) && !entry.name.endsWith(".d.ts") && !entry.name.endsWith(".mcp.json")) continue;
        const content = await readFile(p, "utf-8");
        assert.doesNotMatch(content, /\r\n?/, `${relative(repoRoot, p)} must use LF line endings`);
      }
    }
  });

  it("staged MCP shims contain no trailing whitespace", async () => {
    for (const p of [
      resolve(repoRoot, "plugins/claude/telegram/claude-mcp-shim.js"),
      resolve(repoRoot, "plugins/codex/telegram/codex-mcp-shim.js"),
    ]) {
      const content = await readFile(p, "utf-8");
      assert.doesNotMatch(content, /[ 	]+$/m, `${relative(repoRoot, p)} must be diff-check clean`);
    }
  });

  it("dev install scripts at repo root are distinct from artifact trees", async () => {
    const devScripts = [
      resolve(repoRoot, "install.js"),
      resolve(repoRoot, "install-codex.js"),
      resolve(repoRoot, "install.sh"),
      resolve(repoRoot, "INSTALL.bat"),
    ];
    for (const p of devScripts) {
      assert.ok(await pathExists(p), `dev script exists at repo root: ${relative(repoRoot, p)}`);
    }
    // Dev scripts should NOT be inside plugin artifact trees
    assert.ok(
      !(await pathExists(resolve(repoRoot, "plugins/claude/telegram/install.js"))),
      "install.js must not be in artifact tree"
    );
    assert.ok(
      !(await pathExists(resolve(repoRoot, "plugins/codex/telegram/install-codex.js"))),
      "install-codex.js must not be in artifact tree"
    );
  });
});

describe("Assembled skill determinism", () => {
  it("fixture test-skill produces a single frontmatter block", async () => {
    const skillPath = resolve(
      repoRoot,
      "hosts/fixtures/test-skill/SKILL.md"
    );
    assert.ok(await pathExists(skillPath), "fixture source exists");
    const content = await readFile(skillPath, "utf-8");
    const fmCount = Math.floor((content.match(/^---$/gm) || []).length / 2);
    assert.strictEqual(fmCount, 1, "fixture source has exactly one frontmatter block");
    assert.ok(content.includes("name:"), "fixture contains name");
    assert.ok(content.includes("description:"), "fixture contains description");
  });

  it("fixture shared fragment exists and has no frontmatter", async () => {
    const fragPath = resolve(
      repoRoot,
      "hosts/common/skills/fragments/test-skill/shared.md"
    );
    assert.ok(await pathExists(fragPath), "fixture shared fragment exists");
    const content = await readFile(fragPath, "utf-8");
    assert.ok(!content.trimStart().startsWith("---"), "shared fragment must not start with frontmatter");
  });
});

describe("Staged-skill equality assertions", () => {
  // Reimplement the assemble-skills logic inline so we can compare
  // staged artifacts against a fresh assembly from the agreed source inputs.

  async function readSourceSkill(agent, comm) {
    const p = resolve(repoRoot, "hosts", agent, "skills", comm, "SKILL.md");
    return readFile(p, "utf-8");
  }

  async function readFragments(comm) {
    const dir = resolve(repoRoot, "hosts", "common", "skills", "fragments", comm);
    const byKind = { prepend: [], append: [] };
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name)
        .sort();
      for (const name of files) {
        const text = await readFile(resolve(dir, name), "utf-8");
        const hasFm = text.trimStart().startsWith("---");
        const body = hasFm
          ? text.slice(text.indexOf("---", 3) + 3).replace(/^\n+/, "").trimEnd()
          : text.trimEnd();
        const kind = name.startsWith("prepend-") ? "prepend" : "append";
        byKind[kind].push(body);
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return byKind;
  }

  async function assembleExpected(agent, comm) {
    const raw = await readSourceSkill(agent, comm);
    const trimmed = raw.trimStart();
    const fmEnd = trimmed.indexOf("---", 3);
    const frontmatter = trimmed.slice(0, fmEnd + 3).trimEnd();
    const body = trimmed.slice(fmEnd + 3).replace(/^\n+/, "");
    const frags = await readFragments(comm);

    const sections = [frontmatter];
    for (const piece of frags.prepend) {
      if (piece) sections.push(piece);
    }
    if (body.trim()) sections.push(body.trimEnd());
    for (const piece of frags.append) {
      if (piece) sections.push(piece);
    }
    return sections.join("\n\n").trimEnd() + "\n";
  }

  it("staged Claude skill exactly matches fresh assembly from source inputs", async () => {
    const expected = await assembleExpected("claude", "telegram");
    const staged = await readFile(
      resolve(repoRoot, "plugins/claude/telegram/skills/telegram/SKILL.md"),
      "utf-8"
    );
    assert.strictEqual(staged, expected, "staged skill must equal freshly assembled output");
  });

  it("staged Codex skill exactly matches fresh assembly from source inputs", async () => {
    const expected = await assembleExpected("codex", "telegram");
    const staged = await readFile(
      resolve(repoRoot, "plugins/codex/telegram/skills/telegram/SKILL.md"),
      "utf-8"
    );
    assert.strictEqual(staged, expected, "staged skill must equal freshly assembled output");
  });
});


describe("Staged hook import locality", () => {
  it("hook imports resolve to the daemon runtime staged inside each plugin artifact", async () => {
    // Hooks are now esbuilt bundles — all dependencies are inlined; there are NO import/require
    // statements pointing at agents-comm-bus/dist/ or common/install/. esbuild banner comments
    // may contain those substrings, but only in comment form. Assert no live import paths.
    for (const agent of ["claude", "codex"]) {
      const root = resolve(repoRoot, `plugins/${agent}/telegram`);
      const hooksDir = resolve(root, "hooks");
      const entries = await readdir(hooksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
        const p = resolve(hooksDir, entry.name);
        const content = await readFile(p, "utf-8");
        // No live import from source-tree agent paths
        assert.doesNotMatch(
          content,
          /from\s+['"][^'"]*hosts\/(claude|codex)\//,
          `${relative(repoRoot, p)} must not have live import from hosts/... source paths`
        );
        assert.doesNotMatch(
          content,
          /require\(\s*['"][^'"]*hosts\/(claude|codex)\//,
          `${relative(repoRoot, p)} must not have live require from hosts/... source paths`
        );
        // No live import from agents-comm-bus/dist/ (all inlined)
        assert.doesNotMatch(
          content,
          /from\s+['"][^'"]*agents-comm-bus\/dist\//,
          `${relative(repoRoot, p)} must not have live import from agents-comm-bus/dist/`
        );
        assert.doesNotMatch(
          content,
          /from\s+['"][^'"]*\.\.\/\.\.\/\.\.\//,
          `${relative(repoRoot, p)} must not have live import via source-tree depth (../../../)`
        );
      }
    }
  });

  it("stages the daemon runtime package required by hook imports", async () => {
    // Hooks are self-contained bundles; the old dist tree is gone. Assert the new runtime artifacts exist.
    for (const agent of ["claude", "codex"]) {
      const root = resolve(repoRoot, `plugins/${agent}/telegram`);
      assert.ok(await pathExists(resolve(root, "daemon.bundle.js")), `${agent}: daemon.bundle.js must exist`);
      assert.ok(await pathExists(resolve(root, "telegram.adapter.bundle.js")), `${agent}: telegram.adapter.bundle.js must exist`);
      assert.ok(await pathExists(resolve(root, "cli.bundle.js")), `${agent}: cli.bundle.js must exist`);
      assert.ok(await pathExists(resolve(root, "package.json")), `${agent}: package.json must exist`);
      assert.ok(await pathExists(resolve(root, "001_initial.sql")), `${agent}: 001_initial.sql must exist`);
    }
  });
});

describe("Stale-string mechanism-side checks", () => {
  it("staged Claude artifacts contain no legacy flat-skill path expectations", async () => {
    const root = resolve(repoRoot, "plugins/claude/telegram");
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const p = resolve(entry.parentPath ?? root, entry.name);
      const content = await readFile(p, "utf-8");
      if (!entry.name.endsWith(".stage-manifest.json")) {
        assert.ok(
          !content.includes("skills/telegram/SKILL.md") || p.endsWith("SKILL.md"),
          `${relative(repoRoot, p)} must not reference legacy root skill path`
        );
      }
      // .stage-manifest.json and bundled .js legitimately contain hosts/... substrings
      // (.stage-manifest.json: source provenance; .js: esbuild banner comments and shimName labels).
      // Restrict the ban to non-.js, non-.stage-manifest.json files (manifests, SKILL.md, etc.)
      if (!entry.name.endsWith(".stage-manifest.json") && !p.endsWith(".js")) {
        assert.doesNotMatch(content, /hosts\/claude\//, `${relative(repoRoot, p)} must not reference source host paths`);
        assert.doesNotMatch(content, /hosts\/codex\//, `${relative(repoRoot, p)} must not reference source host paths`);
      }
      // Staged manifest must not reference source mcp-server/dist path
      if (p.endsWith("plugin.json") || p.endsWith(".mcp.json")) {
        assert.doesNotMatch(content, /mcp-server\/dist/, `${relative(repoRoot, p)} must not reference mcp-server/dist`);
        assert.doesNotMatch(content, /\$\{CLAUDE_PLUGIN_ROOT\}/, `${relative(repoRoot, p)} must not reference env var root`);
      }
    }
  });

  it("staged Codex artifacts contain no legacy flat-skill path expectations", async () => {
    const root = resolve(repoRoot, "plugins/codex/telegram");
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const p = resolve(entry.parentPath ?? root, entry.name);
      const content = await readFile(p, "utf-8");
      if (!entry.name.endsWith(".stage-manifest.json")) {
        assert.ok(
          !content.includes("skills/telegram/SKILL.md") || p.endsWith("SKILL.md"),
          `${relative(repoRoot, p)} must not reference legacy root skill path`
        );
      }
      // .stage-manifest.json and bundled .js legitimately contain hosts/... substrings
      // (.stage-manifest.json: source provenance; .js: esbuild banner comments and shimName labels).
      // Restrict the ban to non-.js, non-.stage-manifest.json files (manifests, SKILL.md, etc.)
      if (!entry.name.endsWith(".stage-manifest.json") && !p.endsWith(".js")) {
        assert.doesNotMatch(content, /hosts\/claude\//, `${relative(repoRoot, p)} must not reference source host paths`);
        assert.doesNotMatch(content, /hosts\/codex\//, `${relative(repoRoot, p)} must not reference source host paths`);
      }
      if (p.endsWith("plugin.json") || p.endsWith(".mcp.json")) {
        assert.doesNotMatch(content, /mcp-server\/dist/, `${relative(repoRoot, p)} must not reference mcp-server/dist`);
        assert.doesNotMatch(content, /\$\{CODEX_PLUGIN_ROOT\}/, `${relative(repoRoot, p)} must not reference env var root`);
      }
    }
  });

  it("staged hooks do not contain legacy ${AGENT}_PLUGIN_ROOT path interpolation", async () => {
    const artifactRoots = [
      resolve(repoRoot, "plugins/claude/telegram"),
      resolve(repoRoot, "plugins/codex/telegram"),
    ];
    for (const root of artifactRoots) {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
        const p = resolve(entry.parentPath ?? root, entry.name);
        const content = await readFile(p, "utf-8");
        assert.doesNotMatch(content, /\$\{CLAUDE_PLUGIN_ROOT\}/, `${relative(repoRoot, p)} leak`);
        assert.doesNotMatch(content, /\$\{CODEX_PLUGIN_ROOT\}/, `${relative(repoRoot, p)} leak`);
        assert.doesNotMatch(content, /\$\{PLUGIN_ROOT\}/, `${relative(repoRoot, p)} leak`);
      }
    }
  });
});
describe("Source-to-artifact mapping invariants", () => {
  it("root skills/telegram/ has been removed (source inputs now under hosts/)", async () => {
    const legacy = resolve(repoRoot, "skills/telegram/SKILL.md");
    assert.ok(!(await pathExists(legacy)), "legacy root skill removed");
  });

  it("source-side agent skills exist under hosts/<agent>/skills/", async () => {
    for (const agent of ["claude", "codex"]) {
      const p = resolve(repoRoot, `hosts/${agent}/skills/telegram/SKILL.md`);
      assert.ok(await pathExists(p), `${agent} source skill exists`);
    }
  });

  it("assemble-skills script produces deterministic output", async () => {
    const scriptPath = resolve(repoRoot, "scripts/assemble-skills.js");
    assert.ok(await pathExists(scriptPath), "assemble-skills.js exists");
    const script = await readFile(scriptPath, "utf-8");
    assert.ok(script.includes("frontmatter-aware"), "script is frontmatter-aware");
    assert.ok(script.includes("validateFrontmatter"), "script validates frontmatter");
    assert.ok(script.includes("parseSkill"), "script parses skill frontmatter");
    assert.ok(script.includes("normalizeEol"), "script normalizes line endings");
  });

  it("stage-plugins script exists and creates mapping metadata", async () => {
    const scriptPath = resolve(repoRoot, "scripts/stage-plugins.js");
    assert.ok(await pathExists(scriptPath), "stage-plugins.js exists");
    const script = await readFile(scriptPath, "utf-8");
    assert.ok(script.includes("stage-manifest.json"), "script writes .stage-manifest.json");
    assert.ok(script.includes("source"), "script records source provenance");
    assert.ok(script.includes("artifact"), "script records artifact destination");
    assert.ok(script.includes("normalizeEol"), "script normalizes generated text line endings");
    assert.ok(script.includes("stripTrailingWhitespace"), "script strips generated shim trailing whitespace");
  });

  it("repository attributes pin generated text artifacts to LF", async () => {
    const attrs = await readFile(resolve(repoRoot, ".gitattributes"), "utf-8");
    for (const rule of [
      "hosts/**/skills/**/*.md text eol=lf",
      "hosts/common/skills/fragments/**/*.md text eol=lf",
      "plugins/**/skills/**/*.md text eol=lf",
      "plugins/**/*.json text eol=lf",
      "plugins/**/*.js text eol=lf",
      "plugins/**/*.d.ts text eol=lf",
      "plugins/**/*.map text eol=lf",
      "plugins/**/*.sql text eol=lf",
      "plugins/**/*.ps1 text eol=lf",
    ]) {
      assert.ok(attrs.includes(rule), `.gitattributes must include ${rule}`);
    }
  });

  it("package.json includes stage:plugins script", async () => {
    const pkg = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf-8"));
    assert.ok(pkg.scripts?.["stage:plugins"], "stage:plugins script exists");
    assert.ok(pkg.scripts?.["stage:plugins:verify"], "stage:plugins:verify script exists");
  });
});
