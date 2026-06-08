/**
 * Canonical project-root string for storage, scope keys, and wake-dir hashing.
 * Pure-string / deterministic — no filesystem calls.
 */
export declare function normalizeProjectPath(project: string): string;
/**
 * True when two project strings differ but canonicalize to the same path
 * (e.g. Windows drive-letter casing or separator drift).
 */
export declare function isProjectPathNearMatch(a: string, b: string): boolean;
//# sourceMappingURL=project-path.d.ts.map