/**
 * Postinstall for @agents-comm-bus/pi-telegram.
 *
 * Two jobs:
 * 1. Dev mode: if a sibling `core/` directory exists (monorepo workspace),
 *    symlink node_modules/@agents-comm-bus/pi-core to it (npm workspaces hoist
 *    it to the repo root; Pi's manifest expects it nested).
 * 2. Prod mode (git-source install): copy the vendored agents-comm-bus dist/
 *    from pi-core's vendor directory into THIS package's root node_modules/,
 *    so both the telegram extension AND the core extension can resolve
 *    `agents-comm-bus/host-entry`. (npm installs pi-core as a git dep, and
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
