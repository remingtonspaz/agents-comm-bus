import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export const PI_CORE_VERSION = "0.1.1";
export const PER_COMM_VERSION = "0.1.3";
export const PI_COMMS = ["curl", "discord", "matrix", "telegram"];
export const CORE_GIT_REPO = "git+https://github.com/remingtonspaz/agents-comm-bus-pi-core.git";

const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);

/** Workspace-only paths omitted from pi-core release output. */
const CORE_SOURCE_EXCLUDE_REL = new Set(["package.json", "package-lock.json", "tsconfig.json"]);

/** Workspace-only paths omitted from per-comm release output. */
const PER_COMM_SOURCE_EXCLUDE_REL = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "scripts/link-workspace-core.mjs",
]);

const CORE_GITIGNORE = `# Dev workspace link (created by per-comm packages' postinstall, not shipped)
node_modules/@agents-comm-bus/pi-telegram
`;

const CORE_POSTINSTALL =
  "node -e \"const fs=require('fs');const path=require('path');fs.mkdirSync(path.join('node_modules','agents-comm-bus'),{recursive:true});fs.cpSync('vendor-agents-comm-bus',path.join('node_modules','agents-comm-bus'),{recursive:true})\"";

/** Production postinstall shipped in pi-telegram release (not the monorepo workspace helper). */
export const TELEGRAM_PRODUCTION_POSTINSTALL = `/**
 * Postinstall for @agents-comm-bus/pi-telegram.
 *
 * Two jobs:
 * 1. Dev mode: if a sibling \`core/\` directory exists (monorepo workspace),
 *    symlink node_modules/@agents-comm-bus/pi-core to it (npm workspaces hoist
 *    it to the repo root; Pi's manifest expects it nested).
 * 2. Prod mode (git-source install): copy the vendored agents-comm-bus dist/
 *    from pi-core's vendor directory into THIS package's root node_modules/,
 *    so both the telegram extension AND the core extension can resolve
 *    \`agents-comm-bus/host-entry\`. (npm installs pi-core as a git dep, and
 *    pi-core's own postinstall copies to its nested node_modules/ — but that's
 *    only reachable from the core extension's files, not the telegram
 *    extension's files, because Node walks UP the tree, not into siblings.)
 */
import { cpSync, existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- 1. Dev mode: symlink sibling core/ ---
const coreTarget = resolve(pkgRoot, "..", "core");
const linkParent = join(pkgRoot, "node_modules", "@agents-comm-bus");
const linkPath = join(linkParent, "pi-core");

if (existsSync(coreTarget)) {
  if (!existsSync(linkPath)) {
    mkdirSync(linkParent, { recursive: true });
    symlinkSync(coreTarget, linkPath, "junction");
  } else {
    try {
      if (lstatSync(linkPath).isSymbolicLink()) {
        // already linked
      }
    } catch {
      // real install — leave it
    }
  }
}

// --- 2. Prod mode: copy vendored agents-comm-bus into root node_modules ---
const vendorSource = join(pkgRoot, "node_modules", "@agents-comm-bus", "pi-core", "vendor-agents-comm-bus");
const acbDest = join(pkgRoot, "node_modules", "agents-comm-bus");

if (existsSync(vendorSource) && !existsSync(acbDest)) {
  mkdirSync(join(pkgRoot, "node_modules"), { recursive: true });
  cpSync(vendorSource, acbDest, { recursive: true });
}
`;

export function validateCoreRef(coreRef) {
  if (typeof coreRef !== "string" || !/^[0-9a-f]{40}$/.test(coreRef)) {
    throw new Error(
      `--core-ref must be a 40-character lowercase git commit SHA (got ${JSON.stringify(coreRef)})`,
    );
  }
  return coreRef;
}

export function coreGitDependency(coreRef) {
  validateCoreRef(coreRef);
  return `${CORE_GIT_REPO}#${coreRef}`;
}

function normalizeRel(p) {
  return p.split(path.sep).join("/");
}

function isGitRepo(destRoot) {
  return existsSync(path.join(destRoot, ".git"));
}

/**
 * Recursively mirror a source directory, skipping node_modules/.git before
 * descending and applying explicit relative-path exclusions only.
 */
export function walkMirroredSourceFiles(rootDir, { excludeRel = new Set() } = {}) {
  const out = [];
  function walk(currentDir, prefix) {
    for (const name of readdirSync(currentDir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (excludeRel.has(rel)) continue;
      const abs = path.join(currentDir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        walk(abs, rel);
        continue;
      }
      out.push({ rel: normalizeRel(rel), abs });
    }
  }
  if (existsSync(rootDir)) {
    walk(rootDir, "");
  }
  return out;
}

function walkVendorFiles(rootDir, vendorPrefix) {
  const out = [];
  function walk(currentDir, prefix) {
    for (const name of readdirSync(currentDir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const abs = path.join(currentDir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        walk(abs, rel);
        continue;
      }
      out.push({ rel: `${vendorPrefix}/${rel}`, abs });
    }
  }
  walk(rootDir, "");
  return out;
}

function readJsonFile(abs) {
  return JSON.parse(readFileSync(abs, "utf8"));
}

function stableJson(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function buildCorePackageJson(sourcePkg) {
  return {
    name: "@agents-comm-bus/pi-core",
    version: PI_CORE_VERSION,
    description:
      "Bundled core for agents-comm-bus Pi per-comm packages. Bundles agents-comm-bus dist/ so the whole chain resolves from git without npm.",
    type: "module",
    private: false,
    scripts: {
      postinstall: CORE_POSTINSTALL,
    },
    peerDependencies: sourcePkg.peerDependencies ?? {},
    engines: sourcePkg.engines ?? { node: ">=22" },
    license: sourcePkg.license ?? "MIT",
  };
}

function buildPerCommPackageJson(sourcePkg, coreRef) {
  const dep = coreGitDependency(coreRef);
  return {
    name: sourcePkg.name,
    version: PER_COMM_VERSION,
    description: sourcePkg.description,
    type: sourcePkg.type ?? "module",
    keywords: sourcePkg.keywords,
    pi: sourcePkg.pi,
    dependencies: {
      "@agents-comm-bus/pi-core": dep,
    },
    bundledDependencies: sourcePkg.bundledDependencies ?? ["@agents-comm-bus/pi-core"],
    peerDependencies: sourcePkg.peerDependencies ?? {},
    engines: sourcePkg.engines ?? { node: ">=22" },
    scripts: {
      postinstall: "node ./scripts/postinstall.mjs",
    },
    license: sourcePkg.license ?? "MIT",
  };
}

function vendorAgentsCommBusFiles(monorepoRoot) {
  const vendorRoot = path.join(monorepoRoot, "agents-comm-bus");
  const files = [
    { rel: "vendor-agents-comm-bus/package.json", abs: path.join(vendorRoot, "package.json") },
    ...walkVendorFiles(path.join(vendorRoot, "dist"), "vendor-agents-comm-bus/dist"),
    ...walkVendorFiles(path.join(vendorRoot, "scripts"), "vendor-agents-comm-bus/scripts"),
  ];
  return files;
}

function applyPerCommSourceTransform(comm, rel, content) {
  if (comm === "telegram" && rel === "scripts/postinstall.mjs") {
    return TELEGRAM_PRODUCTION_POSTINSTALL;
  }
  return content;
}

/**
 * Build the expected pi-core release tree (relative path -> utf8 text or buffer).
 */
export function buildCoreReleaseTree(monorepoRoot) {
  const coreSrc = path.join(monorepoRoot, "plugins", "pi", "core");
  const sourcePkg = readJsonFile(path.join(coreSrc, "package.json"));
  const tree = new Map();

  tree.set(".gitignore", CORE_GITIGNORE);
  tree.set("package.json", stableJson(buildCorePackageJson(sourcePkg)));

  for (const { rel, abs } of walkMirroredSourceFiles(coreSrc, {
    excludeRel: CORE_SOURCE_EXCLUDE_REL,
  })) {
    tree.set(rel, readFileSync(abs));
  }

  for (const { rel, abs } of vendorAgentsCommBusFiles(monorepoRoot)) {
    tree.set(rel, readFileSync(abs));
  }

  return tree;
}

/**
 * Build the expected per-comm release tree.
 */
export function buildPerCommReleaseTree(monorepoRoot, comm, coreRef) {
  validateCoreRef(coreRef);
  const commSrc = path.join(monorepoRoot, "plugins", "pi", comm);
  const sourcePkg = readJsonFile(path.join(commSrc, "package.json"));
  const tree = new Map();

  tree.set("package.json", stableJson(buildPerCommPackageJson(sourcePkg, coreRef)));

  for (const { rel, abs } of walkMirroredSourceFiles(commSrc, {
    excludeRel: PER_COMM_SOURCE_EXCLUDE_REL,
  })) {
    const raw = readFileSync(abs);
    tree.set(rel, applyPerCommSourceTransform(comm, rel, raw));
  }

  if (comm === "telegram") {
    tree.set("scripts/postinstall.mjs", TELEGRAM_PRODUCTION_POSTINSTALL);
  }

  return tree;
}

function digestContent(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash("sha256").update(buf).digest("hex");
}

function canonicalTextBuffer(content) {
  if (content.includes(0)) return null;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
  if (/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) return null;
  return Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
}

function releaseContentsEqual(expected, actual) {
  if (actual.equals(expected)) return true;
  const expectedText = canonicalTextBuffer(expected);
  const actualText = canonicalTextBuffer(actual);
  return expectedText !== null && actualText !== null && actualText.equals(expectedText);
}

/** List every non-.git file under destRoot (for no-git temp fixtures). */
export async function listFilesystemFiles(destRoot) {
  const files = [];
  async function walk(dir, prefix = "") {
    for (const name of (await readdir(dir)).sort()) {
      if (name === ".git") continue;
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = await stat(abs);
      if (st.isDirectory()) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        await walk(abs, rel);
      } else {
        files.push(normalizeRel(rel));
      }
    }
  }
  if (existsSync(destRoot)) {
    await walk(destRoot);
  }
  return files.sort();
}

/** List git-tracked files only (for release clone destinations). */
export function listGitTrackedFiles(destRoot) {
  if (!isGitRepo(destRoot)) {
    throw new Error(`listGitTrackedFiles: not a git repo: ${destRoot}`);
  }
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: destRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizeRel)
    .filter((rel) => existsSync(path.join(destRoot, rel)))
    .sort();
}

/**
 * Choose destination enumeration mode.
 * - auto: git-tracked when destRoot is a git repo, otherwise full filesystem
 * - git: force git-tracked (throws if not a repo)
 * - filesystem: force full filesystem walk
 */
export async function listDestinationFiles(destRoot, { enumeration = "auto" } = {}) {
  const mode =
    enumeration === "auto" ? (isGitRepo(destRoot) ? "git" : "filesystem") : enumeration;
  if (mode === "git") return listGitTrackedFiles(destRoot);
  return listFilesystemFiles(destRoot);
}

export async function readTreeFile(destRoot, relPath) {
  return readFile(path.join(destRoot, ...relPath.split("/")));
}

/**
 * Compare an expected tree to files on disk. Returns mismatch details.
 */
export async function diffReleaseTree(expectedTree, destRoot, { enumeration = "auto" } = {}) {
  const mismatches = [];
  const expectedPaths = new Set(expectedTree.keys());

  for (const rel of [...expectedPaths].sort()) {
    const dest = path.join(destRoot, ...rel.split("/"));
    const expected = expectedTree.get(rel);
    if (!existsSync(dest)) {
      mismatches.push({ kind: "missing", path: rel });
      continue;
    }
    const actual = await readFile(dest);
    const expectedBuf = Buffer.isBuffer(expected) ? expected : Buffer.from(expected);
    if (!releaseContentsEqual(expectedBuf, actual)) {
      mismatches.push({
        kind: "content",
        path: rel,
        expectedDigest: digestContent(expectedBuf),
        actualDigest: digestContent(actual),
      });
    }
  }

  const actualFiles = await listDestinationFiles(destRoot, { enumeration });
  for (const rel of actualFiles) {
    if (!expectedPaths.has(rel)) {
      mismatches.push({ kind: "extra", path: rel });
    }
  }

  return mismatches;
}

export function formatMismatches(repoLabel, mismatches) {
  if (mismatches.length === 0) return "";
  const lines = [`${repoLabel} drift (${mismatches.length}):`];
  for (const m of mismatches) {
    if (m.kind === "missing") lines.push(`  missing: ${m.path}`);
    else if (m.kind === "extra") lines.push(`  extra: ${m.path}`);
    else lines.push(`  content: ${m.path} (expected ${m.expectedDigest}, actual ${m.actualDigest})`);
  }
  return lines.join("\n");
}

async function writeTree(expectedTree, destRoot, { removeStale, enumeration = "auto" }) {
  mkdirSync(destRoot, { recursive: true });

  for (const [rel, content] of expectedTree) {
    const dest = path.join(destRoot, ...rel.split("/"));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }

  if (removeStale) {
    const expectedPaths = new Set(expectedTree.keys());
    const actualFiles = await listDestinationFiles(destRoot, { enumeration });
    for (const rel of actualFiles) {
      if (!expectedPaths.has(rel)) {
        await rm(path.join(destRoot, ...rel.split("/")), { force: true });
      }
    }
  }
}

export async function syncCoreRelease({
  monorepoRoot,
  destRoot,
  removeStale = true,
  enumeration = "auto",
}) {
  const tree = buildCoreReleaseTree(monorepoRoot);
  await writeTree(tree, destRoot, { removeStale, enumeration });
  return tree;
}

export async function syncPerCommRelease({
  monorepoRoot,
  comm,
  destRoot,
  coreRef,
  removeStale = true,
  enumeration = "auto",
}) {
  const tree = buildPerCommReleaseTree(monorepoRoot, comm, coreRef);
  await writeTree(tree, destRoot, { removeStale, enumeration });
  return tree;
}

export async function verifyCoreRelease({ monorepoRoot, destRoot, enumeration = "auto" }) {
  const expected = buildCoreReleaseTree(monorepoRoot);
  const mismatches = await diffReleaseTree(expected, destRoot, { enumeration });
  return { expected, mismatches };
}

export async function verifyPerCommRelease({
  monorepoRoot,
  comm,
  destRoot,
  coreRef,
  enumeration = "auto",
}) {
  const expected = buildPerCommReleaseTree(monorepoRoot, comm, coreRef);
  const mismatches = await diffReleaseTree(expected, destRoot, { enumeration });
  return { expected, mismatches };
}

export async function verifyAllReleases({ monorepoRoot, releaseRoot, coreRef }) {
  validateCoreRef(coreRef);
  const reports = [];

  const coreDest = path.join(releaseRoot, "agents-comm-bus-pi-core");
  const core = await verifyCoreRelease({ monorepoRoot, destRoot: coreDest });
  reports.push({ repo: "agents-comm-bus-pi-core", ...core });

  for (const comm of PI_COMMS) {
    const dest = path.join(releaseRoot, `agents-comm-bus-pi-${comm}`);
    const result = await verifyPerCommRelease({ monorepoRoot, comm, destRoot: dest, coreRef });
    reports.push({ repo: `agents-comm-bus-pi-${comm}`, ...result });
  }

  const mismatches = reports.flatMap((r) =>
    r.mismatches.map((m) => ({ repo: r.repo, ...m })),
  );
  return { reports, mismatches };
}

export async function syncAllReleases({ monorepoRoot, releaseRoot, coreRef, removeStale = true }) {
  validateCoreRef(coreRef);
  await syncCoreRelease({
    monorepoRoot,
    destRoot: path.join(releaseRoot, "agents-comm-bus-pi-core"),
    removeStale,
  });
  for (const comm of PI_COMMS) {
    await syncPerCommRelease({
      monorepoRoot,
      comm,
      destRoot: path.join(releaseRoot, `agents-comm-bus-pi-${comm}`),
      coreRef,
      removeStale,
    });
  }
}

/** Run pi-core postinstall vendor copy in-place (release-style layout). */
export function runCorePostinstall(coreRoot) {
  const vendor = path.join(coreRoot, "vendor-agents-comm-bus");
  const dest = path.join(coreRoot, "node_modules", "agents-comm-bus");
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(vendor, dest, { recursive: true });
}

/** git+file dependency URL for a local pi-core release clone. */
export function coreFileGitDependency(coreRepoPath, coreRef) {
  validateCoreRef(coreRef);
  const normalized = path.resolve(coreRepoPath).replace(/\\/g, "/");
  return `git+file:///${normalized}#${coreRef}`;
}
