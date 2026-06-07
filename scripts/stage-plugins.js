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
//   6. Write .mcp.json for Codex (cwd-independent installed-cache launcher)
//   7. Write .stage-manifest.json proving source-to-artifact lineage
//
// Staged artifacts reference only artifact-local paths.
// Dev/source install scripts (install.js, install-codex.js) remain at repo root
// and are NOT copied into artifact trees.

import { copyFile, mkdir, readFile, readdir, writeFile, access, rm } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { extname, resolve, relative, basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";

import { buildInstallStamp } from "../hosts/common/install/install-stamp.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_OUTPUT_DIR = resolve(REPO_ROOT, "plugins");
// Self-contained esbuilt artifacts produced by build-bundles.mjs.
const BUNDLE_DIR = resolve(REPO_ROOT, "agents-comm-bus", "dist-bundle");

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
  return /\.(js|json|md|ps1|ts|map|sql)$/.test(filePath) || filePath.endsWith(".d.ts");
}

function repoRelative(p) {
  return relative(REPO_ROOT, p).replace(/\\/g, "/");
}

function codexMcpLauncherScript({ marketplaceName, pluginName, shimName }) {
  const jsString = (value) => `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return [
    "const fs=require('node:fs');",
    "const os=require('node:os');",
    "const path=require('node:path');",
    "const {pathToFileURL}=require('node:url');",
    "const home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');",
    `const root=path.join(home,'plugins','cache',${jsString(marketplaceName)},${jsString(pluginName)});`,
    "const versions=fs.existsSync(root)?fs.readdirSync(root,{withFileTypes:true}).filter((entry)=>entry.isDirectory()).map((entry)=>entry.name).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})):[];",
    `const dir=versions.reverse().map((version)=>path.join(root,version)).find((candidate)=>fs.existsSync(path.join(candidate,${jsString(shimName)})));`,
    `if(!dir){console.error('[acb-mcp] unable to locate installed ${pluginName} plugin shim under '+root);process.exit(1);}`,
    `import(pathToFileURL(path.join(dir,${jsString(shimName)})).href).catch((error)=>{console.error(error);process.exit(1);});`,
  ].join(" ");
}

function sortDirents(entries) {
  return entries.toSorted((a, b) => a.name.localeCompare(b.name));
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

/** @param {string} agent @param {string} bundledShimName */
function claudeExpectedMcpArg(agent, bundledShimName) {
  return `\${CLAUDE_PLUGIN_ROOT}/${bundledShimName}`;
}

/**
 * Validate Claude plugin manifest MCP wiring for a staged comm.
 *
 * @param {object} manifest
 * @param {string} comm
 * @param {string} agent
 * @param {string} manifestLabel  provenance path for error messages
 * @param {"stage" | "verify"} mode  stage checks source shape; verify checks staged output
 */
function validateClaudeMcpServerManifest(manifest, comm, agent, manifestLabel, mode) {
  const bundledShimName = `${agent}-mcp-shim.js`;
  const expectedArg = claudeExpectedMcpArg(agent, bundledShimName);
  const prefix = `stage-plugins (claude/${comm}): ${manifestLabel}`;

  const fail = (detail) => {
    const fix =
      `Fix: declare mcpServers.${comm} with { "command": "node", "args": ["${expectedArg}"] } ` +
      `in .claude-plugin/plugin.json.`;
    throw new Error(`${prefix} — ${detail}\n  ${fix}`);
  };

  const mcpServers = manifest.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    fail(`mcpServers must be an object with a "${comm}" entry`);
  }
  const entry = mcpServers[comm];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    fail(`missing mcpServers.${comm}`);
  }
  if (entry.command !== "node") {
    fail(`mcpServers.${comm}.command must be "node" (got ${JSON.stringify(entry.command)})`);
  }
  if (!Array.isArray(entry.args)) {
    fail(`mcpServers.${comm}.args must be an array`);
  }

  if (mode === "verify") {
    if (entry.args.length === 0) {
      return {
        ok: false,
        label: `claude manifest declares mcpServers.${comm} with rooted ${bundledShimName} arg`,
      };
    }
    const primary = entry.args[0];
    if (primary !== expectedArg) {
      return {
        ok: false,
        label: `claude manifest mcpServers.${comm} args must be ["${expectedArg}"] (got ${JSON.stringify(primary)})`,
      };
    }
    for (const arg of entry.args) {
      if (typeof arg !== "string") {
        return { ok: false, label: `claude manifest mcpServers.${comm}.args must be strings` };
      }
      if (arg.includes("hosts/") || arg.startsWith("/")) {
        return { ok: false, label: `manifest arg artifact-local (${arg})` };
      }
      if (!arg.startsWith("${CLAUDE_PLUGIN_ROOT}/")) {
        return {
          ok: false,
          label: `manifest MCP arg must be \${CLAUDE_PLUGIN_ROOT}-rooted (${arg})`,
        };
      }
    }
  }

  return { ok: true, label: `claude manifest declares mcpServers.${comm}` };
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
    log(`  [dry-run] would copy ${repoRelative(src)} → ${repoRelative(dst)}`);
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
  const entries = sortDirents(await readdir(srcDir, { withFileTypes: true }));
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
    log(`  [dry-run] would write ${repoRelative(p)} (${text.length} chars)`);
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

/**
 * Load a named string export from a built dist module. Used to source the
 * install-stamp version fields from authoritative, independent sources:
 * DAEMON_VERSION (core-daemon) and ADAPTER_VERSION (per-comm adapter). Requires
 * `npm --workspace agents-comm-bus run build` to have produced dist first.
 */
async function loadDistExport(distRelPath, exportName) {
  const abs = resolve(REPO_ROOT, distRelPath);
  if (!(await pathExists(abs))) {
    throw new Error(`stage-plugins: missing ${distRelPath} (run the agents-comm-bus build first)`);
  }
  const mod = await import(pathToFileURL(abs).href);
  const value = mod[exportName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`stage-plugins: ${exportName} missing/invalid in ${distRelPath}`);
  }
  return value;
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
  const agents = sortDirents(entries)
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
      const comms = sortDirents(await readdir(skillsRoot, { withFileTypes: true }));
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
 * Localize a Claude hooks.json to the flat artifact layout while KEEPING the
 * ${CLAUDE_PLUGIN_ROOT} prefix.
 *
 * Claude Code runs plugin hook commands from the SESSION's cwd (the user's
 * project dir), NOT the plugin install dir — so the path must stay rooted at
 * ${CLAUDE_PLUGIN_ROOT}, which Claude substitutes with the plugin install dir.
 * A relative "./hooks/..." resolves against the project cwd and dies with
 * "Cannot find module" (this silently broke the ENTIRE prod install: MCP
 * disconnected + every hook failing with cjs/loader). The artifact puts hooks
 * under <plugin>/hooks/, so we only remap the source subpath
 * hosts/claude/hooks/ -> hooks/, leaving the ${CLAUDE_PLUGIN_ROOT} root intact.
 * Source: "node ${CLAUDE_PLUGIN_ROOT}/hosts/claude/hooks/user-prompt-submit.js"
 * Staged: "node ${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.js"
 */
function transformClaudeHooksJson(content) {
  const obj = JSON.parse(content);
  // Replacement via a function so the literal "${CLAUDE_PLUGIN_ROOT}" survives
  // String.replace's "$" substitution rules unmangled.
  const localize = (cmd) =>
    cmd.replace(
      /\$\{CLAUDE_PLUGIN_ROOT\}\/hosts\/claude\/hooks\//g,
      () => "${CLAUDE_PLUGIN_ROOT}/hooks/",
    );

  for (const category of Object.values(obj.hooks || {})) {
    for (const entry of category) {
      for (const hook of entry.hooks || []) {
        if (typeof hook.command === "string") {
          hook.command = localize(hook.command);
        }
      }
    }
  }
  return JSON.stringify(obj, null, 2) + "\n";
}

/**
 * Build the complete artifact tree for one (agent, comm) pair.
 */
async function stagePair(agent, comm) {
  const outDir = resolve(OUTPUT_BASE, agent, comm);
  // Clean the pair's output tree first so a re-stage never leaves stale layout
  // behind (e.g. the pre-AGE-23 agents-comm-bus/dist + common/install trees the
  // bundled design no longer ships). stage-plugins fully owns this directory.
  if (!dryRun) {
    await rm(outDir, { recursive: true, force: true });
  }
  const mapping = {
    schema_version: 1,
    agent,
    comm,
    artifacts: [],
  };

  function record(src, dst, type) {
    mapping.artifacts.push({
      source: repoRelative(src),
      artifact: repoRelative(dst),
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
          source: repoRelative(resolve(fragmentDir, e.name)),
          artifact: repoRelative(skillOutPath),
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

  /* 3. Self-contained runtime bundles (daemon, per-comm adapter, admin CLI).
     The daemon bundle is what the install hook copies to
     ~/.agents-comm-bus/bin/daemon.js; the adapter is the central adapters/<comm>.js
     copy; the CLI is the admin surface a marketplace install can run without a
     dist tree. No raw tsc dist tree and no common/install tree are staged — the
     hooks (section 4) are bundled self-contained and the daemon runs centrally. */
  const requireBundle = async (name) => {
    const src = resolve(BUNDLE_DIR, name);
    if (!(await pathExists(src))) {
      throw new Error(
        `Missing bundle ${name} in ${repoRelative(BUNDLE_DIR)}. ` +
          `Run 'npm --workspace agents-comm-bus run build:bundles'.`,
      );
    }
    return src;
  };
  for (const bundleName of ["daemon.bundle.js", `${comm}.adapter.bundle.js`, "cli.bundle.js"]) {
    const src = await requireBundle(bundleName);
    const dst = resolve(outDir, bundleName);
    await copyTextFileAtomic(src, dst, stripTrailingWhitespace);
    record(src, dst, "runtime-bundle");
  }

  /* 3b. Migration schema sidecars — copied next to daemon.bundle.js and listed
     in the install stamp's daemon_sidecars so the install hook lands them next
     to bin/daemon.js (the runner reads schema relative to its own module dir). */
  const schemaFiles = (await readdir(BUNDLE_DIR)).filter((f) => f.endsWith(".sql")).sort();
  for (const sqlName of schemaFiles) {
    const src = resolve(BUNDLE_DIR, sqlName);
    const dst = resolve(outDir, sqlName);
    await copyTextFileAtomic(src, dst);
    record(src, dst, "schema-sidecar");
  }

  /* 3c. node ESM pin — staged .js (hooks, shim, bundles) load as ESM no matter
     where the plugin is extracted (the dir has no other package.json). */
  const pkgJsonDst = resolve(outDir, "package.json");
  await writeJson(pkgJsonDst, { type: "module", private: true });
  mapping.artifacts.push({
    source: "(generated)",
    artifact: repoRelative(pkgJsonDst),
    type: "package-json",
  });

  /* 4. Hook files — bundled & self-contained, from dist-bundle/hooks/<agent>/.
     The raw hook source imports the daemon dist + common/install; the bundle
     inlines all of it (incl. helpers like wake-support.js), so the staged plugin
     needs neither tree. hooks.json (claude) is copied from source with its
     command paths localized to ./hooks/*.js. */
  const bundledHooksDir = resolve(BUNDLE_DIR, "hooks", agent);
  const hooksDstDir = resolve(outDir, "hooks");
  if (await pathExists(bundledHooksDir)) {
    const hookEntries = sortDirents(await readdir(bundledHooksDir, { withFileTypes: true }));
    for (const e of hookEntries) {
      if (!e.isFile() || !e.name.endsWith(".js")) continue;
      const src = resolve(bundledHooksDir, e.name);
      const dst = resolve(hooksDstDir, e.name);
      await copyTextFileAtomic(src, dst, stripTrailingWhitespace);
      record(src, dst, "hook-bundle");
    }
  }
  const hooksJsonSrc = resolve(REPO_ROOT, "hosts", agent, "hooks", "hooks.json");
  if (await pathExists(hooksJsonSrc)) {
    const dst = resolve(hooksDstDir, "hooks.json");
    const sourceContent = await readText(hooksJsonSrc);
    const content = agent === "claude" ? transformClaudeHooksJson(sourceContent) : sourceContent;
    await writeText(dst, content);
    record(hooksJsonSrc, dst, "hook");
  }

  /* 4. Plugin manifest */
  const manifestName = agent === "claude" ? ".claude-plugin" : ".codex-plugin";
  const manifestSrcDir = resolve(REPO_ROOT, manifestName);
  const manifestSrc = resolve(manifestSrcDir, "plugin.json");
  const manifestDst = resolve(outDir, manifestName, "plugin.json");
  let pluginVersion = null;
  if (await pathExists(manifestSrc)) {
    const manifest = await readJson(manifestSrc);
    pluginVersion = typeof manifest.version === "string" ? manifest.version : null;
    if (agent === "codex") {
      manifest.mcpServers = "./.mcp.json";
      manifest.hooks = "./hooks/hooks.json";
    } else {
      validateClaudeMcpServerManifest(manifest, comm, agent, repoRelative(manifestSrc), "stage");
      // ${CLAUDE_PLUGIN_ROOT}-rooted, NOT relative: Claude runs the plugin MCP
      // server from the session cwd, so "./" would resolve against the project
      // dir and fail to start (MCP "disconnected"). See transformClaudeHooksJson.
      manifest.mcpServers[comm].args = ["${CLAUDE_PLUGIN_ROOT}/" + bundledShimName];
    }
    // Ensure skills field points to local skills dir
    manifest.skills = "./skills/";
    await writeJson(manifestDst, manifest);
    record(manifestSrc, manifestDst, "manifest");
  }

  /* 4b. Central-install stamp — runtime-readable version source. Three
     independent fields so adapter/daemon/plugin versions can diverge without
     one masquerading as another (see install-model.md + AGE-13). No timestamp,
     so the stamp is byte-stable across stagings. */
  const daemonBundleVersion = await loadDistExport(
    "agents-comm-bus/dist/core-daemon/config.js",
    "DAEMON_VERSION",
  );
  const adapterBundleVersion = await loadDistExport(
    `agents-comm-bus/dist/adapters/${comm}/version.js`,
    "ADAPTER_VERSION",
  );
  const stampDst = resolve(outDir, "install-stamp.json");
  await writeJson(
    stampDst,
    buildInstallStamp({
      agent,
      comm,
      pluginVersion,
      daemonBundleVersion,
      adapterBundleVersion,
      daemonSidecars: schemaFiles,
    }),
  );
  mapping.artifacts.push({
    source: `core-daemon/config.ts (DAEMON_VERSION) + adapters/${comm}/version.ts (ADAPTER_VERSION) + ${manifestName}/plugin.json (version)`,
    artifact: repoRelative(stampDst),
    type: "install-stamp",
  });

  /* 5. Codex .mcp.json */
  if (agent === "codex") {
    const mcpJsonDst = resolve(outDir, ".mcp.json");
    const mcp = {
      [comm]: {
        command: "node",
        // Codex starts plugin MCP servers from the session cwd, not reliably
        // from the plugin root. Resolve the installed cache root at runtime so
        // the server starts from any project directory.
        args: [
          "-e",
          codexMcpLauncherScript({
            marketplaceName: "agents-comm-bus-codex",
            pluginName: comm,
            shimName: bundledShimName,
          }),
        ],
      },
    };
    await writeJson(mcpJsonDst, mcp);
    mapping.artifacts.push({
      source: "(generated)",
      artifact: repoRelative(mcpJsonDst),
      type: "mcp-config",
    });
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
  await assertFile("daemon.bundle.js", "self-contained daemon bundle");
  await assertFile(`${comm}.adapter.bundle.js`, "self-contained adapter bundle");
  await assertFile("cli.bundle.js", "self-contained CLI bundle");
  await assertFile("install-stamp.json", "central-install stamp");
  await assertFile("package.json", "ESM type pin");
  await assertFile("001_initial.sql", "migration schema sidecar");
  await assertFile("hooks/permission-request.js", "permission hook");
  await assertFile("hooks/user-prompt-submit.js", "prompt hook");
  await assertFile("hooks/session-start.js", "session hook");
  await assertFile(".stage-manifest.json", "mapping metadata");

  if (agent === "claude") {
    await assertFile("hooks/hooks.json", "hooks manifest");
    // wake-support.js is no longer a standalone file — it is inlined into the
    // bundled claude hooks (user-prompt-submit / permission-request / session-start).
    await assertFile("scripts/enter-watcher.ps1", "enter watcher script");
  } else if (agent === "codex") {
    await assertFile("hooks/hooks.json", "hooks manifest");
    await assertFile(".mcp.json", "standalone MCP config");
    await assertFile("scripts/bootstrap-codex-session.ps1", "bootstrap script");
  }

  // Path check: no artifact may reference absolute or source-only (hosts/...)
  // paths; and Claude plugin MCP/hook commands MUST be ${CLAUDE_PLUGIN_ROOT}-rooted.
  // Claude runs them from the SESSION cwd, not the plugin dir, so a relative
  // "./" silently breaks the entire install (MCP disconnected + every hook
  // failing with cjs/loader). This guard is what would have caught that.
  const manifestPath = resolve(outDir, `${manifestName}/plugin.json`);
  if (await pathExists(manifestPath)) {
    const manifest = await readJson(manifestPath);
    if (agent === "codex") {
      if (manifest.mcpServers !== "./.mcp.json") {
        checks.push({ label: "codex manifest points mcpServers at ./.mcp.json", ok: false, path: manifestPath });
      }
      if (manifest.hooks !== "./hooks/hooks.json") {
        checks.push({ label: "codex manifest points hooks at ./hooks/hooks.json", ok: false, path: manifestPath });
      }
    }
    if (agent === "claude") {
      try {
        const mcpCheck = validateClaudeMcpServerManifest(
          manifest,
          comm,
          agent,
          repoRelative(manifestPath),
          "verify",
        );
        checks.push({ ...mcpCheck, path: manifestPath });
      } catch (err) {
        checks.push({
          label: err instanceof Error ? err.message : String(err),
          ok: false,
          path: manifestPath,
        });
      }
    }
  }

  // Plugin hook commands must be rooted at the plugin install dir.
  if (agent === "claude" || agent === "codex") {
    const hooksJsonPath = resolve(outDir, "hooks", "hooks.json");
    if (await pathExists(hooksJsonPath)) {
      const expectedRoot = agent === "claude" ? "${CLAUDE_PLUGIN_ROOT}/" : "${PLUGIN_ROOT}/";
      const hooksObj = await readJson(hooksJsonPath);
      for (const category of Object.values(hooksObj.hooks || {})) {
        for (const entry of category) {
          for (const hook of entry.hooks || []) {
            const cmd = typeof hook.command === "string" ? hook.command : "";
            if (!cmd.includes(expectedRoot)) {
              checks.push({ label: `hook command must be plugin-rooted (${cmd})`, ok: false, path: hooksJsonPath });
            }
          }
        }
      }
    }
  }

  if (agent === "codex") {
    const mcpPath = resolve(outDir, ".mcp.json");
    if (await pathExists(mcpPath)) {
      const mcp = await readJson(mcpPath);
      const mcpServer = mcp[comm];
      const args = mcpServer?.args ?? [];
      if (mcpServer?.command !== "node" || args[0] !== "-e") {
        checks.push({ label: "codex MCP uses cwd-independent launcher", ok: false, path: mcpPath });
      }
      const launcher = String(args[1] ?? "");
      const bundledShimName = `${agent}-mcp-shim.js`;
      if (
        !launcher.includes("'plugins','cache'") ||
        !launcher.includes("agents-comm-bus-codex") ||
        !launcher.includes(comm) ||
        !launcher.includes(bundledShimName) ||
        !launcher.includes("pathToFileURL")
      ) {
        checks.push({ label: "codex MCP launcher resolves installed plugin cache", ok: false, path: mcpPath });
      }
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
      const detail = r.outDir ? ` -> ${repoRelative(r.outDir)}` : "";
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
