#!/usr/bin/env node
// stage-plugins.js — emit complete installable plugin artifact trees with
// source-to-artifact mapping metadata.
//
// Usage:
//   node scripts/stage-plugins.js [--verify] [--output-dir <dir>] [--dry-run]
//
// For each (agent, comm) pair discovered in hosts/*/skills/:
//   1. Stage the bundled MCP shim (mcp-server/dist/<agent>-mcp-shim.js)
//   2. Stage hook files from hosts/<agent>/hooks/ with artifact-local paths
//   3. Stage supporting scripts (PS1 files referenced by hooks)
//   4. Assemble skill from agent-specific + shared fragments
//   5. Write plugin manifest with artifact-local MCP args + skills path
//   6. Write .mcp.json for Codex (artifact-local paths)
//   7. Write .stage-manifest.json proving source-to-artifact lineage
//
// Staged artifacts reference only artifact-local paths.
// Dev/source install scripts (install.js, install-codex.js) remain at repo root
// and are NOT copied into artifact trees.

import { copyFile, mkdir, readFile, readdir, writeFile, access, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { extname, resolve, relative, basename, dirname } from "node:path";
import { pipeline } from "node:stream/promises";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_OUTPUT_DIR = resolve(REPO_ROOT, "plugins");

const args = process.argv.slice(2);
const verifyMode = args.includes("--verify");
const dryRun = args.includes("--dry-run");
const outputDirFlag = args.indexOf("--output-dir");

function normalizeEol(text) {
  return text.replace(/\r\n?/g, "\n");
}

function stripTrailingWhitespace(text) {
  return normalizeEol(text).replace(/[ \t]+$/gm, "");
}

function isTextArtifactPath(filePath) {
  return /\.(js|json|md|ps1|ts|map)$/.test(filePath) || filePath.endsWith(".d.ts");
}
const OUTPUT_BASE =
  outputDirFlag !== -1 && args[outputDirFlag + 1]
    ? resolve(args[outputDirFlag + 1])
    : DEFAULT_OUTPUT_DIR;

/* ── helpers ─────────────────────────────────────────────────────────────── */

function log(msg) {
  console.log(msg);
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function pathExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p) {
  if (!dryRun) await mkdir(p, { recursive: true });
}

async function copyFileAtomic(src, dst) {
  if (dryRun) {
    log(`  [dry-run] would copy ${relative(REPO_ROOT, src)} → ${relative(REPO_ROOT, dst)}`);
    return;
  }
  await ensureDir(dirname(dst));
  await pipeline(createReadStream(src), createWriteStream(dst));
}

async function copyTextFileAtomic(src, dst, transform = normalizeEol) {
  const content = transform(await readText(src));
  await writeText(dst, content);
}

async function copyTree(srcDir, dstDir, recordFn, type) {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = resolve(srcDir, entry.name);
    const dst = resolve(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dst, recordFn, type);
    } else if (entry.isFile()) {
      if (isTextArtifactPath(src)) {
        await copyTextFileAtomic(src, dst);
      } else {
        await copyFileAtomic(src, dst);
      }
      recordFn(src, dst, type);
    }
  }
}

async function readText(p) {
  return normalizeEol(await readFile(p, "utf-8"));
}

async function writeText(p, text) {
  if (dryRun) {
    log(`  [dry-run] would write ${relative(REPO_ROOT, p)} (${text.length} chars)`);
    return;
  }
  await ensureDir(dirname(p));
  await writeFile(p, normalizeEol(text), "utf-8");
}

async function readJson(p) {
  return JSON.parse(await readText(p));
}

async function writeJson(p, obj) {
  return writeText(p, JSON.stringify(obj, null, 2) + "\n");
}

/* ── skill assembly (copied from assemble-skills.js for self-containment) ── */

function parseSkill(content) {
  const normalized = normalizeEol(content);
  const trimmed = normalized.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: null, body: normalized, hasFrontmatter: false };
  }
  const endIdx = trimmed.indexOf("---", 3);
  if (endIdx === -1) {
    return { frontmatter: null, body: normalized, hasFrontmatter: false };
  }
  const frontmatter = trimmed.slice(0, endIdx + 3).trimEnd();
  const body = trimmed.slice(endIdx + 3).replace(/^\n+/, "");
  return { frontmatter, body, hasFrontmatter: true };
}

async function readFragments(dir) {
  const byKind = { prepend: [], append: [] };
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && extname(e.name) === ".md")
      .map((e) => e.name)
      .sort();
    for (const name of files) {
      const text = await readText(resolve(dir, name));
      const parsed = parseSkill(text);
      const body = parsed.hasFrontmatter ? parsed.body.trimEnd() : text.trimEnd();
      const kind = name.startsWith("prepend-") ? "prepend" : "append";
      byKind[kind].push(body);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return byKind;
}

async function assembleSkill(agent, comm) {
  const agentPath = resolve(REPO_ROOT, "hosts", agent, "skills", comm, "SKILL.md");
  const fragmentDir = resolve(REPO_ROOT, "hosts", "common", "skills", "fragments", comm);

  const agentRaw = await readText(agentPath).catch((err) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (agentRaw === null) {
    throw new Error(`Missing agent-specific skill: ${agentPath}`);
  }

  const parsed = parseSkill(agentRaw);
  if (!parsed.hasFrontmatter) {
    throw new Error(`Agent-specific skill must start with frontmatter: ${agentPath}`);
  }

  const frags = await readFragments(fragmentDir);

  const sections = [parsed.frontmatter];
  for (const piece of frags.prepend) {
    if (piece) sections.push(piece);
  }
  if (parsed.body.trim()) {
    sections.push(parsed.body.trimEnd());
  }
  for (const piece of frags.append) {
    if (piece) sections.push(piece);
  }

  return sections.join("\n\n").trimEnd() + "\n";
}

/* ── artifact tree building ──────────────────────────────────────────────── */

async function discoverPairs() {
  const hostsRoot = resolve(REPO_ROOT, "hosts");
  const entries = await readdir(hostsRoot, { withFileTypes: true });
  const agents = entries
    .filter(
      (e) =>
        e.isDirectory() &&
        e.name !== "common" &&
        e.name !== "fixtures" &&
        !e.name.startsWith(".")
    )
    .map((e) => e.name);

  const pairs = [];
  for (const agent of agents) {
    const skillsRoot = resolve(hostsRoot, agent, "skills");
    try {
      const comms = await readdir(skillsRoot, { withFileTypes: true });
      for (const comm of comms) {
        if (comm.isDirectory()) {
          pairs.push({ agent, comm: comm.name });
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return pairs;
}

/**
 * Transform a Claude hooks.json so command paths are artifact-local.
 * Source: "node ${CLAUDE_PLUGIN_ROOT}/hosts/claude/hooks/user-prompt-submit.js"
 * Staged:  "node ./hooks/user-prompt-submit.js"
 *
 * Also remove the ${CLAUDE_PLUGIN_ROOT} prefix since the artifact layout
 * puts hooks directly under <agent>/<comm>/hooks/.
 */
function transformClaudeHooksJson(content) {
  const obj = JSON.parse(content);
  const stripPrefix = (cmd) =>
    cmd
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/hosts\/claude\/hooks\//g, "./hooks/")
      .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\//g, "./");

  for (const category of Object.values(obj.hooks || {})) {
    for (const entry of category) {
      for (const hook of entry.hooks || []) {
        if (typeof hook.command === "string") {
          hook.command = stripPrefix(hook.command);
        }
      }
    }
  }
  return JSON.stringify(obj, null, 2) + "\n";
}

/**
 * Transform hook source code so diagnostic shimNames use artifact-local paths.
 */
function transformHookSource(content, agent) {
  // Replace shimName: 'hosts/<agent>/hooks/foo.js' with 'hooks/foo.js'
  content = content.replace(
    new RegExp(`shimName: ['"]hosts/${agent}/hooks/`, "g"),
    "shimName: './hooks/"
  );
  // Hooks move from hosts/<agent>/hooks/ to plugins/<agent>/<comm>/hooks/.
  // Repoint daemon imports to the staged daemon package inside the same artifact.
  content = content.replace(
    /\.\.\/\.\.\/\.\.\/agents-comm-bus\/dist\//g,
    "../agents-comm-bus/dist/"
  );
  // Replace bootstrapperPath / watcherScript repo-root references with artifact-local paths
  content = content.replace(
    /bootstrapperPath = path\.join\(repoRoot, 'scripts', 'bootstrap-codex-session\.ps1'\)/g,
    "bootstrapperPath = path.join(__dirname, '..', 'scripts', 'bootstrap-codex-session.ps1')"
  );
  content = content.replace(
    /watcherScript = path\.resolve\(__dirname, '\.\.', '\.\.', '\.\.', 'scripts', 'enter-watcher\.ps1'\)/g,
    "watcherScript = path.resolve(__dirname, '..', 'scripts', 'enter-watcher.ps1')"
  );
  return content;
}

/**
 * Build the complete artifact tree for one (agent, comm) pair.
 */
async function stagePair(agent, comm) {
  const outDir = resolve(OUTPUT_BASE, agent, comm);
  const mapping = {
    agent,
    comm,
    staged_at: new Date().toISOString(),
    artifacts: [],
  };

  function record(src, dst, type) {
    mapping.artifacts.push({
      source: relative(REPO_ROOT, src),
      artifact: relative(REPO_ROOT, dst),
      type,
    });
  }

  /* 1. Assembled skill */
  const skillText = await assembleSkill(agent, comm);
  const skillOutDir = resolve(outDir, "skills", comm);
  const skillOutPath = resolve(skillOutDir, "SKILL.md");
  await writeText(skillOutPath, skillText);
  record(
    resolve(REPO_ROOT, "hosts", agent, "skills", comm, "SKILL.md"),
    skillOutPath,
    "assembled-skill"
  );
  // Also record fragment inputs for provenance
  const fragmentDir = resolve(REPO_ROOT, "hosts", "common", "skills", "fragments", comm);
  if (await pathExists(fragmentDir)) {
    const fragEntries = await readdir(fragmentDir, { withFileTypes: true });
    for (const e of fragEntries) {
      if (e.isFile() && extname(e.name) === ".md") {
        mapping.artifacts.push({
          source: relative(REPO_ROOT, resolve(fragmentDir, e.name)),
          artifact: relative(REPO_ROOT, skillOutPath),
          type: "skill-fragment",
        });
      }
    }
  }

  /* 2. Bundled MCP shim */
  const bundledShimName = `${agent}-mcp-shim.js`;
  const bundledShimSrc = resolve(REPO_ROOT, "mcp-server", "dist", bundledShimName);
  if (!(await pathExists(bundledShimSrc))) {
    throw new Error(`Missing bundled MCP shim: ${bundledShimSrc}. Run 'npm run build' in hosts/.`);
  }
  const shimDst = resolve(outDir, bundledShimName);
  await copyTextFileAtomic(bundledShimSrc, shimDst, stripTrailingWhitespace);
  record(bundledShimSrc, shimDst, "bundled-mcp-shim");

  /* 3. Daemon runtime package used by staged hooks */
  const daemonDistSrc = resolve(REPO_ROOT, "agents-comm-bus", "dist");
  const daemonDistDst = resolve(outDir, "agents-comm-bus", "dist");
  if (!(await pathExists(daemonDistSrc))) {
    throw new Error(`Missing daemon dist: ${daemonDistSrc}. Run 'npm --workspace agents-comm-bus run build'.`);
  }
  await copyTree(daemonDistSrc, daemonDistDst, record, "daemon-runtime");
  const daemonPackageSrc = resolve(REPO_ROOT, "agents-comm-bus", "package.json");
  const daemonPackageDst = resolve(outDir, "agents-comm-bus", "package.json");
  await copyFileAtomic(daemonPackageSrc, daemonPackageDst);
  record(daemonPackageSrc, daemonPackageDst, "daemon-runtime");

  /* 4. Hook files */
  const hooksSrcDir = resolve(REPO_ROOT, "hosts", agent, "hooks");
  const hooksDstDir = resolve(outDir, "hooks");
  if (await pathExists(hooksSrcDir)) {
    const hookEntries = await readdir(hooksSrcDir, { withFileTypes: true });
    for (const e of hookEntries) {
      if (!e.isFile()) continue;
      const src = resolve(hooksSrcDir, e.name);
      const dst = resolve(hooksDstDir, e.name);

      let content = await readText(src);
      if (e.name === "hooks.json") {
        content = transformClaudeHooksJson(content);
      } else if (e.name.endsWith(".js")) {
        content = transformHookSource(content, agent);
      }
      await writeText(dst, content);
      record(src, dst, "hook");
    }
  }

  /* 4. Plugin manifest */
  const manifestName = agent === "claude" ? ".claude-plugin" : ".codex-plugin";
  const manifestSrcDir = resolve(REPO_ROOT, manifestName);
  const manifestSrc = resolve(manifestSrcDir, "plugin.json");
  const manifestDst = resolve(outDir, manifestName, "plugin.json");
  if (await pathExists(manifestSrc)) {
    const manifest = await readJson(manifestSrc);
    // Ensure MCP server args point to the staged shim. Codex stores MCP
    // server declarations in artifact-local .mcp.json, not plugin.json.
    if (agent === "codex") {
      delete manifest.mcpServers;
    } else if (manifest.mcpServers?.telegram?.args) {
      manifest.mcpServers.telegram.args = [`./${bundledShimName}`];
    }
    // Ensure skills field points to local skills dir
    manifest.skills = "./skills/";
    await writeJson(manifestDst, manifest);
    record(manifestSrc, manifestDst, "manifest");
  }

  /* 5. Codex .mcp.json */
  if (agent === "codex") {
    const mcpJsonSrc = resolve(REPO_ROOT, ".mcp.json.template");
    const mcpJsonDst = resolve(outDir, ".mcp.json");
    if (await pathExists(mcpJsonSrc)) {
      const mcp = await readJson(mcpJsonSrc);
      if (mcp.mcpServers?.telegram?.args) {
        mcp.mcpServers.telegram.args = [`./${bundledShimName}`];
      }
      await writeJson(mcpJsonDst, mcp);
      record(mcpJsonSrc, mcpJsonDst, "mcp-config");
    }
  }

  /* 6. Supporting scripts */
  const scriptsSrcDir = resolve(REPO_ROOT, "scripts");
  const scriptsDstDir = resolve(outDir, "scripts");
  const scriptsToStage = [];

  if (agent === "claude") {
    // enter-watcher.ps1 is referenced by wake-support.js
    scriptsToStage.push("enter-watcher.ps1");
  } else if (agent === "codex") {
    // bootstrap-codex-session.ps1 is referenced by session-start.js
    scriptsToStage.push("bootstrap-codex-session.ps1");
  }

  for (const scriptName of scriptsToStage) {
    const src = resolve(scriptsSrcDir, scriptName);
    if (await pathExists(src)) {
      const dst = resolve(scriptsDstDir, scriptName);
      await copyTextFileAtomic(src, dst);
      record(src, dst, "supporting-script");
    }
  }

  /* 7. Source-to-artifact mapping metadata */
  const mappingDst = resolve(outDir, ".stage-manifest.json");
  await writeJson(mappingDst, mapping);

  return { outDir, mapping };
}

/* ── verify mode ─────────────────────────────────────────────────────────── */

async function verifyPair(agent, comm) {
  const outDir = resolve(OUTPUT_BASE, agent, comm);
  const manifestName = agent === "claude" ? ".claude-plugin" : ".codex-plugin";
  const checks = [];

  const assertFile = async (relPath, label) => {
    const p = resolve(outDir, relPath);
    const ok = await pathExists(p);
    checks.push({ label, ok, path: p });
    return ok;
  };

  await assertFile(`${manifestName}/plugin.json`, "manifest");
  await assertFile(`skills/${comm}/SKILL.md`, "assembled skill");
  await assertFile(`${agent}-mcp-shim.js`, "bundled MCP shim");
  await assertFile("agents-comm-bus/dist/core-daemon/serve.js", "staged daemon runtime");
  await assertFile("agents-comm-bus/package.json", "staged daemon package metadata");
  await assertFile("hooks/permission-request.js", "permission hook");
  await assertFile("hooks/user-prompt-submit.js", "prompt hook");
  await assertFile("hooks/session-start.js", "session hook");
  await assertFile(".stage-manifest.json", "mapping metadata");

  if (agent === "claude") {
    await assertFile("hooks/hooks.json", "hooks manifest");
    await assertFile("hooks/wake-support.js", "wake support");
    await assertFile("scripts/enter-watcher.ps1", "enter watcher script");
  } else if (agent === "codex") {
    await assertFile(".mcp.json", "standalone MCP config");
    await assertFile("scripts/bootstrap-codex-session.ps1", "bootstrap script");
  }

  // Path-independence check: no artifact file should contain absolute paths
  // or source-only paths like hosts/... in its manifest or .mcp.json
  const manifestPath = resolve(outDir, `${manifestName}/plugin.json`);
  if (await pathExists(manifestPath)) {
    const manifest = await readJson(manifestPath);
    if (agent === "codex" && manifest.mcpServers !== undefined) {
      checks.push({ label: "codex manifest omits mcpServers", ok: false, path: manifestPath });
    }
    const args = manifest.mcpServers?.telegram?.args ?? [];
    for (const arg of args) {
      if (arg.includes("hosts/") || arg.startsWith("/")) {
        checks.push({ label: `manifest arg artifact-local (${arg})`, ok: false, path: manifestPath });
      }
    }
  }

  if (agent === "codex") {
    const mcpPath = resolve(outDir, ".mcp.json");
    if (await pathExists(mcpPath)) {
      const mcp = await readJson(mcpPath);
      const args = mcp.mcpServers?.telegram?.args ?? [];
      for (const arg of args) {
        if (arg.includes("hosts/") || arg.startsWith("/")) {
          checks.push({ label: `.mcp.json arg artifact-local (${arg})`, ok: false, path: mcpPath });
        }
      }
    }
  }

  const allOk = checks.every((c) => c.ok);
  return { ok: allOk, checks };
}

/* ── main ────────────────────────────────────────────────────────────────── */

async function main() {
  const pairs = await discoverPairs();
  if (pairs.length === 0) {
    die("No (agent, comm) skill pairs found in hosts/*/skills/");
  }

  let exitCode = 0;
  const results = [];

  for (const { agent, comm } of pairs) {
    try {
      if (verifyMode) {
        const result = await verifyPair(agent, comm);
        results.push({ agent, comm, ...result });
        if (!result.ok) exitCode = 1;
      } else {
        const result = await stagePair(agent, comm);
        results.push({ agent, comm, ok: true, outDir: result.outDir });
      }
    } catch (err) {
      results.push({ agent, comm, ok: false, reason: err.message });
      exitCode = 1;
    }
  }

  for (const r of results) {
    if (verifyMode) {
      const status = r.ok ? "OK" : "FAIL";
      const detail = r.checks
        ?.filter((c) => !c.ok)
        .map((c) => `  missing: ${c.label}`)
        .join("\n") || "";
      console.log(`[${status}] ${r.agent}/${r.comm}${detail ? "\n" + detail : ""}`);
    } else {
      const status = r.ok ? "OK" : "FAIL";
      const detail = r.outDir ? ` -> ${relative(REPO_ROOT, r.outDir)}` : "";
      const reason = r.reason ? ` (${r.reason})` : "";
      console.log(`[${status}] ${r.agent}/${r.comm}${detail}${reason}`);
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
