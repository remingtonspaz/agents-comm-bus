import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { IPC_PROTOCOL_VERSION } from "../config.js";
import type { DaemonHello } from "../ipc/protocol.js";
import { normalizeDaemonRootPath, resolveDiscoveryPaths } from "../paths.js";
import { currentProcessStartEpochMs } from "../runtime/process-start-epoch.js";
import { JsonlAuditStore } from "../storage/audit.js";
import { probeDaemon as defaultProbeDaemon } from "./handshake.js";
import { tryAcquireSpawnLock } from "./spawn-lock.js";

export interface DiscoveryClaim {
  pid: number;
  port: number;
  stateRoot: string;
  startedAt: number | null;
  protocolVersion: string;
}

export type ClaimDiscoveryResult =
  | { ok: true; claim: DiscoveryClaim }
  | { ok: false; reason: "incumbent"; winner: DiscoveryClaim }
  | { ok: false; reason: "incumbent_busy"; incumbent: DiscoveryClaim };

export class DiscoveryClaimLostError extends Error {
  readonly winner: DiscoveryClaim;

  constructor(winner: DiscoveryClaim) {
    super(
      `agents-comm-bus daemon already running on port ${winner.port} ` +
        `(pid ${winner.pid}, state root ${winner.stateRoot})`,
    );
    this.name = "DiscoveryClaimLostError";
    this.winner = winner;
  }
}

export type DiscoverySpawnLock = { release(): Promise<void> };

export interface ClaimDiscoveryInput {
  stateRoot: string;
  discoveryRoot?: string;
  pid?: number;
  port: number;
  startedAt?: number | null;
  protocolVersion?: string;
  isPidAlive?: (pid: number) => boolean;
  probeDaemon?: (port: number) => Promise<DaemonHello>;
  /** When set, stale/foreign replacement audits are written here. */
  auditStateRoot?: string;
  acquireLock?: (lockPath: string) => Promise<DiscoverySpawnLock | undefined>;
  /** Invoked immediately before an exclusive owner.json create attempt. */
  beforeCreate?: () => Promise<void>;
}

export interface WriteDaemonDiscoveryFilesInput {
  stateRoot?: string;
  discoveryRoot?: string;
  pid?: number;
  port: number;
  startedAt?: number | null;
  isPidAlive?: (pid: number) => boolean;
  probeDaemon?: (port: number) => Promise<DaemonHello>;
}

const OWNER_FILE = "owner.json";

export function discoveryOwnerFile(discoveryRoot: string): string {
  return path.join(discoveryRoot, OWNER_FILE);
}

export async function readDiscoveryClaim(discoveryRoot: string): Promise<DiscoveryClaim | undefined> {
  try {
    const raw = await readFile(discoveryOwnerFile(discoveryRoot), "utf8");
    return parseDiscoveryClaim(raw);
  } catch {
    return undefined;
  }
}

export function parseDiscoveryClaim(raw: string): DiscoveryClaim | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<DiscoveryClaim>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.port !== "number" ||
      !Number.isInteger(parsed.port) ||
      parsed.port <= 0 ||
      parsed.port >= 65_536 ||
      typeof parsed.stateRoot !== "string" ||
      parsed.stateRoot.length === 0 ||
      typeof parsed.protocolVersion !== "string" ||
      parsed.protocolVersion.length === 0
    ) {
      return undefined;
    }
    const startedAt =
      parsed.startedAt === null || parsed.startedAt === undefined
        ? null
        : typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)
          ? parsed.startedAt
          : undefined;
    if (startedAt === undefined && parsed.startedAt !== null && parsed.startedAt !== undefined) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      port: parsed.port,
      stateRoot: parsed.stateRoot,
      startedAt: startedAt ?? null,
      protocolVersion: parsed.protocolVersion,
    };
  } catch {
    return undefined;
  }
}

export function discoveryClaimIdentityMatches(
  claim: DiscoveryClaim,
  selfPid: number,
  selfStartedAt: number | null,
): boolean {
  if (claim.pid !== selfPid) return false;
  if (claim.startedAt == null || selfStartedAt == null) return true;
  return claim.startedAt === selfStartedAt;
}

export async function claimDiscovery(input: ClaimDiscoveryInput): Promise<ClaimDiscoveryResult> {
  const paths = resolveDiscoveryPaths({
    stateRoot: input.stateRoot,
    discoveryRoot: input.discoveryRoot,
  });
  await mkdir(paths.root, { recursive: true });

  const selfPid = input.pid ?? process.pid;
  const selfStartedAt = input.startedAt ?? currentProcessStartEpochMs();
  const selfClaim: DiscoveryClaim = {
    pid: selfPid,
    port: input.port,
    stateRoot: input.stateRoot,
    startedAt: selfStartedAt,
    protocolVersion: input.protocolVersion ?? IPC_PROTOCOL_VERSION,
  };
  const isPidAlive = input.isPidAlive ?? defaultIsPidAlive;
  const probe = input.probeDaemon ?? ((port: number) => defaultProbeDaemon({ port }));
  const auditRoot = input.auditStateRoot ?? input.stateRoot;

  const acquireLock =
    input.acquireLock ??
    ((lockPath: string) => tryAcquireSpawnLock(lockPath, { isPidAlive }));
  const lock = await acquireLock(paths.spawnLock);
  try {
    return await claimDiscoveryUnderLock({
      paths,
      selfClaim,
      isPidAlive,
      probe,
      auditRoot,
      beforeCreate: input.beforeCreate,
    });
  } finally {
    await lock?.release();
  }
}

interface ClaimUnderLockInput {
  paths: ReturnType<typeof resolveDiscoveryPaths>;
  selfClaim: DiscoveryClaim;
  isPidAlive: (pid: number) => boolean;
  probe: (port: number) => Promise<DaemonHello>;
  auditRoot: string;
  beforeCreate?: () => Promise<void>;
}

async function claimDiscoveryUnderLock(input: ClaimUnderLockInput): Promise<ClaimDiscoveryResult> {
  const ownerFile = discoveryOwnerFile(input.paths.root);
  const incumbent = await readDiscoveryClaim(input.paths.root);

  if (incumbent) {
    const decision = await classifyIncumbent({
      incumbent,
      selfClaim: input.selfClaim,
      isPidAlive: input.isPidAlive,
      probe: input.probe,
      normalizedSelfRoot: normalizeDaemonRootPath(input.selfClaim.stateRoot),
    });
    if (decision.action === "return") {
      return decision.result!;
    }
    if (decision.action === "replace") {
      await writeOwnerClaimAtomic(ownerFile, input.selfClaim, { replace: true });
      if (decision.auditStale) {
        await auditStaleCleanup(input.auditRoot, incumbent, input.paths);
      }
      if (decision.auditForeign) {
        await auditForeignReplaced(input.auditRoot, incumbent, input.selfClaim);
      }
      await writeDerivedDiscoveryFiles(input.paths, input.selfClaim);
      return { ok: true, claim: input.selfClaim };
    }
  }

  const legacy = await readLegacyIncumbent(input.paths);
  if (legacy) {
    const decision = await classifyIncumbent({
      incumbent: legacy,
      selfClaim: input.selfClaim,
      isPidAlive: input.isPidAlive,
      probe: input.probe,
      normalizedSelfRoot: normalizeDaemonRootPath(input.selfClaim.stateRoot),
    });
    if (decision.action === "return") {
      return decision.result!;
    }
    if (decision.action !== "replace") {
      throw new Error("unexpected legacy incumbent decision");
    }
    await writeOwnerClaimAtomic(ownerFile, input.selfClaim, { replace: true });
    if (decision.auditStale || legacy.pid !== input.selfClaim.pid) {
      await auditStaleCleanup(input.auditRoot, legacy, input.paths);
    }
    if (decision.auditForeign) {
      await auditForeignReplaced(input.auditRoot, legacy, input.selfClaim);
    }
    await writeDerivedDiscoveryFiles(input.paths, input.selfClaim);
    return { ok: true, claim: input.selfClaim };
  }

  try {
    await writeOwnerClaimAtomic(ownerFile, input.selfClaim, {
      replace: false,
      beforeCreate: input.beforeCreate,
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    const raced = await readDiscoveryClaim(input.paths.root);
    if (!raced) throw error;
    const decision = await classifyIncumbent({
      incumbent: raced,
      selfClaim: input.selfClaim,
      isPidAlive: input.isPidAlive,
      probe: input.probe,
      normalizedSelfRoot: normalizeDaemonRootPath(input.selfClaim.stateRoot),
    });
    if (decision.action === "return") return decision.result!;
    if (decision.action === "replace") {
      await writeOwnerClaimAtomic(ownerFile, input.selfClaim, { replace: true });
      if (decision.auditStale) await auditStaleCleanup(input.auditRoot, raced, input.paths);
      if (decision.auditForeign) await auditForeignReplaced(input.auditRoot, raced, input.selfClaim);
      await writeDerivedDiscoveryFiles(input.paths, input.selfClaim);
      return { ok: true, claim: input.selfClaim };
    }
    throw error;
  }
  await writeDerivedDiscoveryFiles(input.paths, input.selfClaim);
  return { ok: true, claim: input.selfClaim };
}

type IncumbentDecision =
  | { action: "return"; result: ClaimDiscoveryResult }
  | { action: "replace"; auditStale?: boolean; auditForeign?: boolean };

async function classifyIncumbent(input: {
  incumbent: DiscoveryClaim;
  selfClaim: DiscoveryClaim;
  isPidAlive: (pid: number) => boolean;
  probe: (port: number) => Promise<DaemonHello>;
  normalizedSelfRoot: string;
}): Promise<IncumbentDecision> {
  if (
    discoveryClaimIdentityMatches(input.incumbent, input.selfClaim.pid, input.selfClaim.startedAt ?? null) &&
    input.incumbent.port === input.selfClaim.port
  ) {
    return { action: "return", result: { ok: true, claim: input.incumbent } };
  }

  const alive = input.isPidAlive(input.incumbent.pid);
  if (!alive) {
    return { action: "replace", auditStale: true };
  }

  let hello: DaemonHello | undefined;
  try {
    hello = await input.probe(input.incumbent.port);
  } catch (error) {
    const refused = (error as NodeJS.ErrnoException)?.code === "ECONNREFUSED";
    if (refused) {
      return { action: "replace", auditStale: true };
    }
    return {
      action: "return",
      result: { ok: false, reason: "incumbent_busy", incumbent: input.incumbent },
    };
  }

  const reported = hello.metadata?.stateRoot;
  const normalizedIncumbentRoot =
    typeof reported === "string" && reported.length > 0
      ? normalizeDaemonRootPath(reported)
      : normalizeDaemonRootPath(input.incumbent.stateRoot);

  if (normalizedIncumbentRoot === input.normalizedSelfRoot) {
    return {
      action: "return",
      result: { ok: false, reason: "incumbent", winner: input.incumbent },
    };
  }

  // Legacy pid/port files carry no state root; a live hello without stateRoot is
  // treated as incumbent (AGE-106 legacy compatibility), not a foreign squatter.
  if (
    input.incumbent.stateRoot === "" &&
    (typeof reported !== "string" || reported.length === 0)
  ) {
    return {
      action: "return",
      result: { ok: false, reason: "incumbent", winner: input.incumbent },
    };
  }

  return { action: "replace", auditForeign: true };
}

async function readLegacyIncumbent(
  paths: ReturnType<typeof resolveDiscoveryPaths>,
): Promise<DiscoveryClaim | undefined> {
  const pid = await readPidFile(paths.pidFile);
  const port = await readPortFile(paths.portFile);
  if (pid === undefined || port === undefined) return undefined;
  return {
    pid,
    port,
    stateRoot: "",
    startedAt: null,
    protocolVersion: IPC_PROTOCOL_VERSION,
  };
}

async function writeOwnerClaimAtomic(
  ownerFile: string,
  claim: DiscoveryClaim,
  options: { replace: boolean; beforeCreate?: () => Promise<void> },
): Promise<void> {
  const payload = `${JSON.stringify(claim)}\n`;
  const tempFile = `${ownerFile}.tmp.${claim.pid}.${Date.now()}`;
  await writeFile(tempFile, payload, "utf8");

  if (!options.replace) {
    await options.beforeCreate?.();
    try {
      const handle = await open(ownerFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      await handle.writeFile(payload, "utf8");
      await handle.close();
      await rm(tempFile, { force: true });
      return;
    } catch (error) {
      await rm(tempFile, { force: true });
      if (!isAlreadyExistsError(error)) throw error;
      // Lost race: caller re-enters via read path on retry.
      throw error;
    }
  }

  await rename(tempFile, ownerFile);
}

async function writeDerivedDiscoveryFiles(
  paths: ReturnType<typeof resolveDiscoveryPaths>,
  claim: DiscoveryClaim,
): Promise<void> {
  await writeFile(paths.pidFile, `${claim.pid}\n`, "utf8");
  const portTemp = `${paths.portFile}.tmp.${claim.pid}.${Date.now()}`;
  await writeFile(portTemp, `${claim.port}\n`, "utf8");
  await rename(portTemp, paths.portFile);
}

async function auditStaleCleanup(
  stateRoot: string,
  stale: DiscoveryClaim,
  paths: ReturnType<typeof resolveDiscoveryPaths>,
): Promise<void> {
  const audit = new JsonlAuditStore(stateRoot);
  await audit.append({
    timestamp: Date.now(),
    kind: "discovery_stale_cleanup",
    detail: {
      stale_pid: stale.pid,
      stale_port: stale.port,
      pid_file: paths.pidFile,
      port_file: paths.portFile,
      owner_file: discoveryOwnerFile(paths.root),
    },
  });
}

async function auditForeignReplaced(
  stateRoot: string,
  previous: DiscoveryClaim,
  current: DiscoveryClaim,
): Promise<void> {
  const audit = new JsonlAuditStore(stateRoot);
  await audit.append({
    timestamp: Date.now(),
    kind: "daemon_discovery_foreign_owner_replaced",
    detail: {
      previous_pid: previous.pid,
      previous_state_root: previous.stateRoot,
      previous_port: previous.port,
      pid: current.pid,
      state_root: current.stateRoot,
      port: current.port,
    },
  });
}

export async function writeDaemonDiscoveryFiles(input: WriteDaemonDiscoveryFilesInput): Promise<void> {
  const stateRoot = input.stateRoot;
  if (!stateRoot) {
    throw new Error("writeDaemonDiscoveryFiles requires stateRoot");
  }
  const result = await claimDiscovery({
    stateRoot,
    discoveryRoot: input.discoveryRoot,
    pid: input.pid,
    port: input.port,
    startedAt: input.startedAt,
    isPidAlive: input.isPidAlive,
    probeDaemon: input.probeDaemon,
    auditStateRoot: stateRoot,
  });
  if (!result.ok) {
    if (result.reason === "incumbent") {
      throw new DiscoveryClaimLostError(result.winner);
    }
    throw new Error(
      `agents-comm-bus daemon pid ${result.incumbent.pid} is alive but unresponsive; ` +
        `refusing to overwrite discovery with port ${input.port}`,
    );
  }
}

async function readPortFile(portFile: string): Promise<number | undefined> {
  try {
    const raw = (await readFile(portFile, "utf8")).trim();
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
  } catch {
    return undefined;
  }
}

async function readPidFile(pidFile: string): Promise<number | undefined> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
