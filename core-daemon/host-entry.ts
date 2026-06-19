/**
 * AGE-60 — host-runtime package export SCAFFOLD.
 *
 * Public package entry point that any external host package (notably the Pi
 * extension, which ships outside this monorepo's `hosts/` tree and has no
 * `git-subdir` equivalent) imports to reach the shared dev/prod
 * daemon-resolution seam:
 *
 *   import { entryEnsures } from "agents-comm-bus/host-entry";
 *
 * ⚠️ SCAFFOLD ONLY (AGE-60). This stub exists purely to prove the package
 * `exports` subpath, the `.d.ts` type surface, and consumer-context resolution
 * (an external package can import this path through `package.json` `exports`
 * with NO reach-back into `hosts/` or monorepo-relative source paths).
 *
 * The REAL `entryEnsures` implementation and its `hosts/common/install`
 * dependency cluster are moved into this package in AGE-61 (the layer
 * extraction), gated by a consumer-context central-install path-resolution
 * test. Until AGE-61 lands, the stub THROWS — do not rely on it at runtime.
 *
 * This module intentionally has NO imports from `hosts/` (or anywhere else): a
 * scaffold that pulled in the real cluster would defeat the staged de-risk and
 * is exactly what AGE-61 is for.
 */

/** Options the real `entryEnsures` (AGE-61) will accept. Minimal/stable surface. */
export interface EntryEnsuresOptions {
  agent: string;
  comm: string;
  /** Caller's own dir; the resolver walks up from here to the dev marker. */
  fromDir?: string;
  stateRoot?: string;
  discoveryRoot?: string;
  env?: Record<string, string | undefined>;
  ensureDaemonOptions?: Record<string, unknown>;
}

/** Result shape the real `entryEnsures` (AGE-61) will return. */
export interface EntryEnsuresResult {
  port: number;
  hello: unknown;
  spawned: boolean;
  centralInstall: unknown;
  stateRoot: string;
  discoveryRoot: string;
  env: Record<string, string | undefined>;
}

/**
 * SCAFFOLD STUB — the real implementation lands in AGE-61 (layer extraction of
 * the `hosts/common/install` cluster into this package). Throws until then so
 * no caller silently depends on a non-functional export.
 *
 * @throws always, with a pointer to AGE-61.
 */
export async function entryEnsures(_options: EntryEnsuresOptions): Promise<EntryEnsuresResult> {
  throw new Error(
    "agents-comm-bus/host-entry: entryEnsures is an AGE-60 scaffold stub. " +
      "The real implementation is moved into this package in AGE-61; until then this export only proves the package boundary.",
  );
}

/** Marker so callers/tests can detect the scaffold phase without invoking the stub. */
export const HOST_ENTRY_SCAFFOLD = true as const;
