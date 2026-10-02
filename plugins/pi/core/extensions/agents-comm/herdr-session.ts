/**
 * Herdr session identity for Pi (parity with hosts/common/herdr-env.js).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SessionManager } from "@earendil-works/pi-coding-agent";

import { piSessionId } from "./session-id.js";

const DEV_MARKER_NAME = ".agents-comm-bus-dev.json";

function normalizeHerdrSocketPath(socketPath: string): string {
  const resolved = path.resolve(socketPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Must match `core-daemon/runtime/herdr.ts` — covered by herdr-hosts parity test. */
export function herdrSessionId(identity: HerdrIdentityPayload): string {
  const socket = normalizeHerdrSocketPath(identity.socket_path);
  const digest = crypto
    .createHash("sha256")
    .update(`${identity.agent}\n${socket}\n${identity.pane_id}`)
    .digest("hex")
    .slice(0, 24);
  return `herdr_${digest}`;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function newestHerdrStandaloneBinary(homeDir = os.homedir()): string | null {
  const releasesRoot = path.join(homeDir, ".herdr", "packages", "standalone", "releases");
  try {
    const entries = fs
      .readdirSync(releasesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const dir = path.join(releasesRoot, entries[i]);
      const exe =
        process.platform === "win32" ? path.join(dir, "herdr.exe") : path.join(dir, "herdr");
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    // no standalone install
  }
  return null;
}

function resolveHerdrBinPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (typeof env.HERDR_BIN_PATH === "string" && env.HERDR_BIN_PATH.trim()) {
    return env.HERDR_BIN_PATH.trim();
  }
  return newestHerdrStandaloneBinary() ?? undefined;
}

export interface HerdrIdentityPayload {
  type: "herdr";
  agent: "pi";
  pane_id: string;
  socket_path: string;
  workspace_id?: string;
  tab_id?: string;
  bin_path?: string;
}

export function herdrIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HerdrIdentityPayload | null {
  if (env.HERDR_ENV !== "1") return null;
  const pane_id = env.HERDR_PANE_ID;
  const socket_path = env.HERDR_SOCKET_PATH;
  if (typeof pane_id !== "string" || !pane_id.trim()) return null;
  if (typeof socket_path !== "string" || !socket_path.trim()) return null;

  const identity: HerdrIdentityPayload = {
    type: "herdr",
    agent: "pi",
    pane_id: pane_id.trim(),
    socket_path: socket_path.trim(),
  };
  if (typeof env.HERDR_WORKSPACE_ID === "string" && env.HERDR_WORKSPACE_ID.trim()) {
    identity.workspace_id = env.HERDR_WORKSPACE_ID.trim();
  }
  if (typeof env.HERDR_TAB_ID === "string" && env.HERDR_TAB_ID.trim()) {
    identity.tab_id = env.HERDR_TAB_ID.trim();
  }
  const bin_path = resolveHerdrBinPath(env);
  if (bin_path) identity.bin_path = bin_path;
  return identity;
}

export function herdrSessionIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const identity = herdrIdentityFromEnv(env);
  return identity ? herdrSessionId(identity) : null;
}

export function resolvePiDaemonSessionId(
  sm: SessionManager,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return herdrSessionIdFromEnv(env) ?? piSessionId(sm);
}

export function wakeStrictFromDevMarker(projectDir: string): "herdr" | null {
  const markerPath = path.join(projectDir, DEV_MARKER_NAME);
  if (!fs.existsSync(markerPath)) return null;
  try {
    const raw = stripBom(fs.readFileSync(markerPath, "utf8"));
    const parsed = JSON.parse(raw) as { wakeStrict?: unknown };
    return parsed.wakeStrict === "herdr" ? "herdr" : null;
  } catch {
    return null;
  }
}
