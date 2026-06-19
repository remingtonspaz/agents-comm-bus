import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { stripBom } from "./strip-bom.js";

export const DEV_MARKER_NAME = ".agents-comm-bus-dev.json";

export interface DevConfigResult {
  env: Record<string, string>;
  status: "none" | "applied" | "rejected";
  reasons: string[];
}

export interface DevConfigDeps {
  exists?: (p: string) => boolean;
  readFile?: (p: string) => string;
}

export function resolveDevConfig(projectRoot: string, deps: DevConfigDeps = {}): DevConfigResult {
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
  const markerPath = path.join(projectRoot, DEV_MARKER_NAME);

  if (!exists(markerPath)) {
    return { env: {}, status: "none", reasons: [`no dev marker at ${markerPath}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(readFile(markerPath)));
  } catch (error) {
    return {
      env: {},
      status: "rejected",
      reasons: [`dev marker unparseable: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const daemonBinRaw =
    parsed && typeof parsed === "object" && parsed !== null && "daemonBin" in parsed && typeof (parsed as { daemonBin?: unknown }).daemonBin === "string"
      ? (parsed as { daemonBin: string }).daemonBin
      : null;
  if (!daemonBinRaw) {
    return { env: {}, status: "rejected", reasons: ["dev marker missing string field `daemonBin`"] };
  }

  const daemonBin = path.resolve(projectRoot, daemonBinRaw);
  if (!isInside(projectRoot, daemonBin)) {
    return { env: {}, status: "rejected", reasons: [`dev marker daemonBin escapes project root: ${daemonBinRaw}`] };
  }
  if (!exists(daemonBin)) {
    return { env: {}, status: "rejected", reasons: [`dev marker daemonBin does not exist: ${daemonBin}`] };
  }

  const env: Record<string, string> = { AGENTS_COMM_BUS_BIN: daemonBin };
  const reasons = [`dev marker applied from ${markerPath}`];
  const record = parsed as Record<string, unknown>;

  if (typeof record.stateRoot === "string" && record.stateRoot.length > 0) {
    const stateRoot = path.resolve(projectRoot, record.stateRoot);
    if (isInside(projectRoot, stateRoot)) env.AGENTS_COMM_BUS_ROOT = stateRoot;
    else reasons.push(`ignoring stateRoot outside project root: ${record.stateRoot}`);
  }
  if (typeof record.discoveryRoot === "string" && record.discoveryRoot.length > 0) {
    const discoveryRoot = path.resolve(projectRoot, record.discoveryRoot);
    if (isInside(projectRoot, discoveryRoot)) env.AGENTS_COMM_BUS_DISCOVERY_ROOT = discoveryRoot;
    else reasons.push(`ignoring discoveryRoot outside project root: ${record.discoveryRoot}`);
  }
  if (typeof record.adaptersDir === "string" && record.adaptersDir.length > 0) {
    const adaptersDir = path.resolve(projectRoot, record.adaptersDir);
    if (isInside(projectRoot, adaptersDir)) env.AGENTS_COMM_BUS_ADAPTERS_DIR = adaptersDir;
    else reasons.push(`ignoring adaptersDir outside project root: ${record.adaptersDir}`);
  }

  return { env, status: "applied", reasons };
}

export function applyDevConfig(
  baseEnv: Record<string, string | undefined>,
  projectRoot: string,
  deps: DevConfigDeps = {},
): { env: Record<string, string | undefined>; devConfig: DevConfigResult } {
  const devConfig = resolveDevConfig(projectRoot, deps);
  return { env: { ...baseEnv, ...devConfig.env }, devConfig };
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}
