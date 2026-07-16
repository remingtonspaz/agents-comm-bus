#!/usr/bin/env node
/**
 * Resolve `.agents-comm-bus-dev.json` for restart-daemon.ps1 -Respawn.
 * Prints JSON `{ status, env, reasons }` from the canonical dev-config resolver.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = process.argv[2];
if (!repoRoot) {
  console.error("usage: node resolve-dev-daemon-env.mjs <repoRoot>");
  process.exit(2);
}

let resolveDevConfig;
try {
  const resolverUrl = new URL(
    "../agents-comm-bus/dist/core-daemon/host-runtime/dev-config-resolver.js",
    import.meta.url,
  );
  ({ resolveDevConfig } = await import(resolverUrl));
} catch (error) {
  console.error(
    JSON.stringify({
      status: "error",
      env: {},
      reasons: [
        `failed to import dev-config resolver: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }),
  );
  process.exit(1);
}

const result = resolveDevConfig(path.resolve(repoRoot));
console.log(JSON.stringify(result));
