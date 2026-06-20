/**
 * Monorepo dev helper: Pi's pi.extensions manifest references
 * `node_modules/@agents-comm-bus/pi-core/extensions`. npm workspaces hoist
 * pi-core to the repo root, so create a local symlink when the sibling core
 * package exists and no bundled copy is already present.
 */
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreTarget = resolve(pkgRoot, "..", "core");
const linkParent = join(pkgRoot, "node_modules", "@agents-comm-bus");
const linkPath = join(linkParent, "pi-core");

if (!existsSync(coreTarget)) {
  process.exit(0);
}

if (existsSync(linkPath)) {
  try {
    if (lstatSync(linkPath).isSymbolicLink()) {
      process.exit(0);
    }
  } catch {
    process.exit(0);
  }
  // Real bundled install from registry — do not replace.
  process.exit(0);
}

mkdirSync(linkParent, { recursive: true });
symlinkSync(coreTarget, linkPath, "junction");
