#!/usr/bin/env node
// assemble-skills.js — frontmatter-aware skill assembly for (agent, comm) plugin artifacts.
//
// Usage:
//   node scripts/assemble-skills.js [--verify] [--output-dir <dir>]
//
// Reads source-side inputs from:
//   hosts/common/skills/fragments/<comm>/   — shared prose fragments (no frontmatter)
//   hosts/<agent>/skills/<comm>/SKILL.md   — agent-specific entrypoint (has frontmatter + body)
//
// Emits exactly one assembled SKILL.md per (agent, comm) into:
//   <output-dir>/<agent>/<comm>/skills/<comm>/SKILL.md
//
// Assembly rules:
//   1. Frontmatter is taken ONLY from the agent-specific SKILL.md.
//   2. Shared fragments from hosts/common/skills/fragments/<comm>/ are appended
//      after the agent-specific body, in deterministic alphabetical order.
//   3. If a fragment file name starts with "prepend-", it is inserted BEFORE
//      the agent-specific body instead.
//   4. The resulting SKILL.md contains exactly one frontmatter block.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { extname, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_OUTPUT_DIR = resolve(REPO_ROOT, "plugins");

const args = process.argv.slice(2);
const verifyMode = args.includes("--verify");
const outputDirFlag = args.indexOf("--output-dir");

function normalizeEol(text) {
  return text.replace(/\r\n?/g, "\n");
}
const OUTPUT_BASE =
  outputDirFlag !== -1 && args[outputDirFlag + 1]
    ? resolve(args[outputDirFlag + 1])
    : DEFAULT_OUTPUT_DIR;

/**
 * Parse frontmatter and body from a markdown file.
 * Returns { frontmatter: string|null, body: string, hasFrontmatter: boolean }
 */
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

/**
 * Validate that frontmatter contains exactly one name and one description.
 */
function validateFrontmatter(fm, sourcePath) {
  const fmBody = fm.slice(3, -3).trim();
  const nameMatch = /^name:\s*(.+)$/m.exec(fmBody);
  const descriptionMatch = /^description:\s*(.+)$/m.exec(fmBody);

  if (!nameMatch) {
    throw new Error(
      `Frontmatter in ${sourcePath} is missing required 'name' field`
    );
  }
  if (!descriptionMatch) {
    throw new Error(
      `Frontmatter in ${sourcePath} is missing required 'description' field`
    );
  }

  // Count occurrences — must be exactly one each
  const nameCount = (fmBody.match(/^name:/gm) || []).length;
  const descCount = (fmBody.match(/^description:/gm) || []).length;
  if (nameCount !== 1) {
    throw new Error(
      `Frontmatter in ${sourcePath} must contain exactly one 'name' (found ${nameCount})`
    );
  }
  if (descCount !== 1) {
    throw new Error(
      `Frontmatter in ${sourcePath} must contain exactly one 'description' (found ${descCount})`
    );
  }

  return { name: nameMatch[1].trim(), description: descriptionMatch[1].trim() };
}

/**
 * Read all .md fragment files from a directory, sorted deterministically.
 * Returns Map<"prepend" | "append", string[]>
 */
async function readFragments(dir) {
  const byKind = { prepend: [], append: [] };
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && extname(e.name) === ".md")
      .map((e) => e.name)
      .sort();
    for (const name of files) {
      const text = normalizeEol(await readFile(resolve(dir, name), "utf-8"));
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

/**
 * Assemble a single SKILL.md from agent-specific and shared fragments.
 */
async function assemble(agent, comm) {
  const agentPath = resolve(
    REPO_ROOT,
    "hosts",
    agent,
    "skills",
    comm,
    "SKILL.md"
  );
  const fragmentDir = resolve(
    REPO_ROOT,
    "hosts",
    "common",
    "skills",
    "fragments",
    comm
  );

  const agentRaw = await readFile(agentPath, "utf-8").catch((err) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (agentRaw === null) {
    throw new Error(`Missing agent-specific skill: ${agentPath}`);
  }

  const parsed = parseSkill(normalizeEol(agentRaw));
  if (!parsed.hasFrontmatter) {
    throw new Error(`Agent-specific skill must start with frontmatter: ${agentPath}`);
  }

  // Validate frontmatter shape
  validateFrontmatter(parsed.frontmatter, agentPath);

  const frags = await readFragments(fragmentDir);

  // Build output deterministically with exactly one frontmatter block
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

  // Join with one blank line between sections, no trailing blank lines before final newline
  const assembled = sections.join("\n\n").trimEnd() + "\n";
  return assembled;
}

/**
 * Write assembled output to its staged artifact path.
 */
async function stage(agent, comm) {
  const assembled = await assemble(agent, comm);
  const outDir = resolve(OUTPUT_BASE, agent, comm, "skills", comm);
  const outPath = resolve(outDir, "SKILL.md");
  await mkdir(outDir, { recursive: true });
  await writeFile(outPath, assembled, "utf-8");
  return { path: outPath, bytes: Buffer.byteLength(assembled, "utf-8") };
}

/**
 * Verify mode: read staged output and compare to fresh assembly.
 */
async function verify(agent, comm) {
  const assembled = await assemble(agent, comm);
  const outPath = resolve(
    OUTPUT_BASE,
    agent,
    comm,
    "skills",
    comm,
    "SKILL.md"
  );
  let existing;
  try {
    existing = normalizeEol(await readFile(outPath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ok: false, reason: "missing staged file", path: outPath };
    }
    throw err;
  }
  if (existing === assembled) {
    return { ok: true, path: outPath };
  }
  return { ok: false, reason: "mismatch", path: outPath };
}

/**
 * Detect which (agent, comm) pairs exist in source layout.
 */
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

async function main() {
  const pairs = await discoverPairs();
  if (pairs.length === 0) {
    console.error("No (agent, comm) skill pairs found in hosts/*/skills/");
    process.exit(1);
  }

  let exitCode = 0;
  const results = [];

  for (const { agent, comm } of pairs) {
    try {
      if (verifyMode) {
        const result = await verify(agent, comm);
        results.push({ agent, comm, ...result });
        if (!result.ok) exitCode = 1;
      } else {
        const result = await stage(agent, comm);
        results.push({ agent, comm, ok: true, ...result });
      }
    } catch (err) {
      results.push({ agent, comm, ok: false, reason: err.message });
      exitCode = 1;
    }
  }

  for (const r of results) {
    const status = r.ok ? "OK" : "FAIL";
    const detail = r.path ? ` -> ${r.path}` : "";
    const reason = r.reason ? ` (${r.reason})` : "";
    console.log(`[${status}] ${r.agent}/${r.comm}${detail}${reason}`);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
