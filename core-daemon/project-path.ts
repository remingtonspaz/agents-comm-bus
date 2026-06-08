import path from "node:path";

/**
 * Canonical project-root string for storage, scope keys, and wake-dir hashing.
 * Pure-string / deterministic — no filesystem calls.
 */
export function normalizeProjectPath(project: string): string {
  let resolved = path.resolve(project);
  if (path.sep === "\\") {
    resolved = resolved.replace(/\//g, "\\");
  } else {
    resolved = resolved.replace(/\\/g, "/");
  }
  if (/^[A-Za-z]:/.test(resolved)) {
    resolved = resolved[0]!.toUpperCase() + resolved.slice(1);
  }
  const isBareRoot =
    resolved === path.sep ||
    (path.sep === "\\" && /^[A-Za-z]:\\$/.test(resolved));
  if (resolved.length > 1 && resolved.endsWith(path.sep) && !isBareRoot) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

/**
 * True when two project strings differ but canonicalize to the same path
 * (e.g. Windows drive-letter casing or separator drift).
 */
export function isProjectPathNearMatch(a: string, b: string): boolean {
  return a !== b && normalizeProjectPath(a) === normalizeProjectPath(b);
}
