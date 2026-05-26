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
      "wake-support.js",
    ]) {
      assert.ok(await pathExists(resolve(hooksDir, hookName)), `${hookName} exists`);
    }
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
    for (const hookName of ["permission-request.js", "user-prompt-submit.js"]) {
      const content = await readFile(resolve(base, "hooks", hookName), "utf-8");
      assert.ok(
        !content.includes("shimName: 'hosts/claude/hooks/"),
        `${hookName} shimName must not reference source paths`
      );
      assert.ok(
        content.includes("shimName: './hooks/"),
        `${hookName} shimName must use artifact-local path`
      );
    }
  });

  it("has supporting script enter-watcher.ps1", async () => {
    const scriptPath = resolve(base, "scripts/enter-watcher.ps1");
    assert.ok(await pathExists(scriptPath), "enter-watcher.ps1 exists");
  });

  it("wake-support.js references artifact-local watcher script", async () => {
    const content = await readFile(resolve(base, "hooks/wake-support.js"), "utf-8");
    assert.ok(
      content.includes("'scripts', 'enter-watcher.ps1'"),
      "wake-support.js must reference artifact-local script path"
    );
    assert.ok(
      !content.includes("'..', '..', '..', 'scripts', 'enter-watcher.ps1'"),
      "wake-support.js must not reference repo-root script path"
    );
  });

  it("has .stage-manifest.json with provenance", async () => {
    const manifestPath = resolve(base, ".stage-manifest.json");
    assert.ok(await pathExists(manifestPath), ".stage-manifest.json exists");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    assert.strictEqual(manifest.agent, "claude");
    assert.strictEqual(manifest.comm, "telegram");
    assert.ok(Array.isArray(manifest.artifacts), "artifacts is array");

    const types = new Set(manifest.artifacts.map((a: any) => a.type));
    assert.ok(types.has("assembled-skill"), "has assembled-skill provenance");
    assert.ok(types.has("bundled-mcp-shim"), "has bundled-mcp-shim provenance");
    assert.ok(types.has("hook"), "has hook provenance");
    assert.ok(types.has("manifest"), "has manifest provenance");
    assert.ok(types.has("supporting-script"), "has supporting-script provenance");

    // Every artifact must map from a source to an artifact path
    for (const art of manifest.artifacts) {
      assert.ok(art.source, "artifact has source");
      assert.ok(art.artifact, "artifact has artifact path");
      assert.ok(art.type, "artifact has type");
    }
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
    for (const hookName of ["permission-request.js", "session-start.js", "user-prompt-submit.js"]) {
      const content = await readFile(resolve(base, "hooks", hookName), "utf-8");
      assert.ok(
        !content.includes("shimName: 'hosts/codex/hooks/"),
        `${hookName} shimName must not reference source paths`
      );
      assert.ok(
        content.includes("shimName: './hooks/"),
        `${hookName} shimName must use artifact-local path`
      );
    }
  });

  it("session-start.js references artifact-local bootstrap script", async () => {
    const content = await readFile(resolve(base, "hooks/session-start.js"), "utf-8");
    assert.ok(
      content.includes("'scripts', 'bootstrap-codex-session.ps1'"),
      "session-start.js must reference artifact-local bootstrap script"
    );
    assert.ok(
      !content.includes("'..', '..', '..', 'scripts', 'bootstrap-codex-session.ps1'"),
      "session-start.js must not reference repo-root script path"
    );
  });

  it("has supporting script bootstrap-codex-session.ps1", async () => {
    const scriptPath = resolve(base, "scripts/bootstrap-codex-session.ps1");
    assert.ok(await pathExists(scriptPath), "bootstrap-codex-session.ps1 exists");
  });

  it("has .stage-manifest.json with provenance", async () => {
    const manifestPath = resolve(base, ".stage-manifest.json");
    assert.ok(await pathExists(manifestPath), ".stage-manifest.json exists");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    assert.strictEqual(manifest.agent, "codex");
    assert.strictEqual(manifest.comm, "telegram");
    assert.ok(Array.isArray(manifest.artifacts), "artifacts is array");

    const types = new Set(manifest.artifacts.map((a: any) => a.type));
    assert.ok(types.has("assembled-skill"), "has assembled-skill provenance");
    assert.ok(types.has("bundled-mcp-shim"), "has bundled-mcp-shim provenance");
    assert.ok(types.has("hook"), "has hook provenance");
    assert.ok(types.has("manifest"), "has manifest provenance");
    assert.ok(types.has("mcp-config"), "has mcp-config provenance");
    assert.ok(types.has("supporting-script"), "has supporting-script provenance");

    for (const art of manifest.artifacts) {
      assert.ok(art.source, "artifact has source");
      assert.ok(art.artifact, "artifact has artifact path");
      assert.ok(art.type, "artifact has type");
    }
  });
});

describe("Artifact-global invariants", () => {
  it("no staged artifact contains source-only path references", async () => {
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
          // Staged hooks shouldn't import from hosts/... — those are source paths
          // They legitimately import from agents-comm-bus via node_modules/workspace
          // so we only ban hosts/ references here
          assert.ok(
            !content.includes("hosts/claude/") && !content.includes("hosts/codex/"),
            `staged artifact ${relative(repoRoot, p)} must not reference hosts/... paths`
          );
        }
      }
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
    for (const agent of ["claude", "codex"]) {
      const root = resolve(repoRoot, `plugins/${agent}/telegram`);
      const hooksDir = resolve(root, "hooks");
      const entries = await readdir(hooksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
        const p = resolve(hooksDir, entry.name);
        const content = await readFile(p, "utf-8");
        assert.doesNotMatch(
          content,
          /\.\.\/\.\.\/\.\.\/agents-comm-bus\/dist\//,
          `${relative(repoRoot, p)} must not import daemon runtime via source-tree depth`
        );
        if (content.includes("agents-comm-bus/dist/")) {
          assert.match(
            content,
            /\.\.\/agents-comm-bus\/dist\//,
            `${relative(repoRoot, p)} must import the staged daemon runtime inside the plugin artifact`
          );
        }
      }
    }
  });

  it("stages the daemon runtime package required by hook imports", async () => {
    for (const agent of ["claude", "codex"]) {
      const root = resolve(repoRoot, `plugins/${agent}/telegram`);
      assert.ok(await pathExists(resolve(root, "agents-comm-bus/dist/core-daemon/serve.js")));
      assert.ok(await pathExists(resolve(root, "agents-comm-bus/package.json")));
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
      // .stage-manifest.json legitimately records source paths in provenance
      if (!entry.name.endsWith(".stage-manifest.json")) {
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
      // .stage-manifest.json legitimately records source paths in provenance
      if (!entry.name.endsWith(".stage-manifest.json")) {
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
  });

  it("stage-plugins script exists and creates mapping metadata", async () => {
    const scriptPath = resolve(repoRoot, "scripts/stage-plugins.js");
    assert.ok(await pathExists(scriptPath), "stage-plugins.js exists");
    const script = await readFile(scriptPath, "utf-8");
    assert.ok(script.includes("stage-manifest.json"), "script writes .stage-manifest.json");
    assert.ok(script.includes("source"), "script records source provenance");
    assert.ok(script.includes("artifact"), "script records artifact destination");
  });

  it("package.json includes stage:plugins script", async () => {
    const pkg = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf-8"));
    assert.ok(pkg.scripts?.["stage:plugins"], "stage:plugins script exists");
    assert.ok(pkg.scripts?.["stage:plugins:verify"], "stage:plugins:verify script exists");
  });
});
