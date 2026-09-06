import { readFile, rm } from "node:fs/promises";

import type { AuditStore } from "agents-comm-bus-core";

import { resolveDiscoveryPaths } from "../paths.js";
import { discoveryOwnerFile, readDiscoveryClaim } from "./discovery-claim.js";

export const IDLE_NO_OWNED_RESOURCES_REASON = "idle_no_owned_resources";

export interface DiscoveryOwnershipInput {
  selfPid: number;
  selfPort: number;
  onDiskPid: number | null | undefined;
  onDiskPort: number | null | undefined;
}

/**
 * AGE-36: discovery files may be removed only when BOTH on-disk pid and port
 * still match this daemon. A successor/main daemon's discovery must never be
 * deleted by a retiring stray.
 */
export function discoveryFilesMatchSelf(input: DiscoveryOwnershipInput): boolean {
  return input.onDiskPid === input.selfPid && input.onDiskPort === input.selfPort;
}

export interface RemoveDiscoveryFilesInput {
  stateRoot?: string;
  discoveryRoot?: string;
  selfPid: number;
  selfPort: number;
  readPidFile?: (pidFile: string) => Promise<number | null>;
  readPortFile?: (portFile: string) => Promise<number | null>;
}

export async function removeDiscoveryFilesIfOwned(
  input: RemoveDiscoveryFilesInput,
): Promise<boolean> {
  const paths = resolveDiscoveryPaths({
    stateRoot: input.stateRoot,
    discoveryRoot: input.discoveryRoot,
  });
  const readPid = input.readPidFile ?? readDiscoveryPidFile;
  const readPort = input.readPortFile ?? readDiscoveryPortFile;
  const onDiskPid = await readPid(paths.pidFile);
  const onDiskPort = await readPort(paths.portFile);
  const owner = await readDiscoveryClaim(paths.root);
  const ownerMatches =
    owner !== undefined &&
    owner.pid === input.selfPid &&
    owner.port === input.selfPort;
  if (
    !discoveryFilesMatchSelf({
      selfPid: input.selfPid,
      selfPort: input.selfPort,
      onDiskPid,
      onDiskPort,
    }) &&
    !ownerMatches
  ) {
    return false;
  }
  await rm(paths.pidFile, { force: true });
  await rm(paths.portFile, { force: true });
  await rm(discoveryOwnerFile(paths.root), { force: true });
  return true;
}

export interface DaemonRetirementOptions {
  reason: string;
  selfPid?: number;
  port: number;
  stateRoot?: string;
  discoveryRoot?: string;
  audit?: AuditStore;
  log?: (message: string) => void;
  stopTimers?: () => void;
  stopBus?: () => Promise<void>;
  closeIpc?: () => Promise<void>;
  closeStorage?: () => Promise<void>;
  removeDiscoveryFiles?: (input: RemoveDiscoveryFilesInput) => Promise<boolean>;
  exitProcess?: (code: number) => void;
}

let globalRetiring = false;

export function resetDaemonRetirementGuardForTests(): void {
  globalRetiring = false;
}

/**
 * Idempotent daemon self-retirement path shared by AGE-36 idle reaper and AGE-12
 * pid watchdog supersede handling.
 */
export async function retireDaemon(options: DaemonRetirementOptions): Promise<boolean> {
  if (globalRetiring) return false;
  globalRetiring = true;

  const selfPid = options.selfPid ?? process.pid;
  const log = options.log ?? ((message: string) => console.error(message));
  const exit = options.exitProcess ?? ((code: number) => process.exit(code));

  try {
    bestEffortSync(options.stopTimers, "stop daemon retirement timers");
    await appendRetirementAudit(options.audit, options.reason, selfPid, options.port);
    log(
      `agents-comm-bus: retiring daemon pid=${selfPid} port=${options.port} ` +
        `reason=${options.reason}`,
    );
    await bestEffort(options.stopBus, "stop comm adapters during daemon retirement");
    await bestEffort(options.closeIpc, "close IPC server during daemon retirement");
    await bestEffort(options.closeStorage, "close storage during daemon retirement");
    const removeDiscovery = options.removeDiscoveryFiles ?? removeDiscoveryFilesIfOwned;
    await bestEffort(
      () =>
        removeDiscovery({
          stateRoot: options.stateRoot,
          discoveryRoot: options.discoveryRoot,
          selfPid,
          selfPort: options.port,
        }).then(() => undefined),
      "remove discovery files during daemon retirement",
    );
  } catch (error) {
    log(
      `agents-comm-bus: daemon retirement failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    exit(0);
  }
  return true;
}

async function appendRetirementAudit(
  audit: AuditStore | undefined,
  reason: string,
  selfPid: number,
  port: number,
): Promise<void> {
  if (!audit) return;
  await audit
    .append({
      timestamp: Date.now(),
      kind: "daemon_retired",
      detail: { reason, self_pid: selfPid, port },
    })
    .catch(() => {});
}

async function bestEffort(
  action: (() => Promise<void>) | undefined,
  label: string,
): Promise<void> {
  if (!action) return;
  try {
    await action();
  } catch (error) {
    console.error(
      `agents-comm-bus: failed to ${label}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function bestEffortSync(action: (() => void) | undefined, label: string): void {
  if (!action) return;
  try {
    action();
  } catch (error) {
    console.error(
      `agents-comm-bus: failed to ${label}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readDiscoveryPidFile(pidFile: string): Promise<number | null> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function readDiscoveryPortFile(portFile: string): Promise<number | null> {
  try {
    const raw = (await readFile(portFile, "utf8")).trim();
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
  } catch {
    return null;
  }
}
