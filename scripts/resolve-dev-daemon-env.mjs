#!/usr/bin/env node
/**
 * Resolve `.agents-comm-bus-dev.json` for restart-daemon.ps1 -Respawn and
 * bootstrap-codex-session.ps1 dev-config snapshot propagation.
 *
 * Default (marker-only): prints JSON `{ status, env, reasons }` from
 * `resolveDevConfig()` — unchanged contract for restart-daemon.ps1 -Respawn.
 *
 * --effective: prints JSON `{ status, reasons, env }` where `env` maps each of
 * the four daemon pin keys to `{ present: true, value }` or `{ present: false }`
 * after `applyDevConfig(process.env, projectRoot)`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEV_ENV_KEYS = [
  "AGENTS_COMM_BUS_BIN",
  "AGENTS_COMM_BUS_DISCOVERY_ROOT",
  "AGENTS_COMM_BUS_ADAPTERS_DIR",
  "AGENTS_COMM_BUS_ROOT",
];

/**
 * AGE-84: this helper is resolved from the PROJECT while the bootstrapper may be
 * a newer installed plugin, so the two can skew. Version the effective-snapshot
 * shape so a consumer fails loud rather than reading `.present` as null off an
 * older marker-only payload and silently applying nothing.
 */
const EFFECTIVE_SNAPSHOT_SCHEMA = "agents-comm-bus/dev-daemon-env-effective@1";

const args = process.argv.slice(2);
const effective = args.includes("--effective");
const repoRootArg = args.find((arg) => arg !== "--effective");
if (!repoRootArg) {
  console.error("usage: node resolve-dev-daemon-env.mjs <repoRoot> [--effective]");
  process.exit(2);
}

const projectRoot = path.resolve(repoRootArg);

async function loadResolver() {
  const projectResolver = path.join(
    projectRoot,
    "agents-comm-bus/dist/core-daemon/host-runtime/dev-config-resolver.js",
  );
  if (existsSync(projectResolver)) {
    return import(pathToFileURL(projectResolver).href);
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const checkoutResolver = path.join(
    scriptDir,
    "../agents-comm-bus/dist/core-daemon/host-runtime/dev-config-resolver.js",
  );
  if (existsSync(checkoutResolver)) {
    return import(pathToFileURL(checkoutResolver).href);
  }

  throw new Error(
    `dev-config resolver not found under ${projectResolver} or ${checkoutResolver}`,
  );
}

let resolveDevConfig;
let applyDevConfig;
try {
  ({ resolveDevConfig, applyDevConfig } = await loadResolver());
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

if (effective) {
  const { env, devConfig } = applyDevConfig(process.env, projectRoot);
  const envSnapshot = Object.fromEntries(
    DEV_ENV_KEYS.map((key) => {
      const value = env[key];
      if (typeof value === "string" && value.length > 0) {
        return [key, { present: true, value }];
      }
      return [key, { present: false }];
    }),
  );
  console.log(
    JSON.stringify({
      schema: EFFECTIVE_SNAPSHOT_SCHEMA,
      status: devConfig.status,
      reasons: devConfig.reasons,
      env: envSnapshot,
    }),
  );
  process.exit(devConfig.status === "rejected" ? 1 : 0);
}

const result = resolveDevConfig(projectRoot);
console.log(JSON.stringify(result));
