import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { JsonlAuditStore } from "../storage/audit.js";

import {
  DAEMON_VERSION,
  DEFAULT_BOOTSTRAP_RETRY_MS,
  DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  IPC_PROTOCOL_VERSION,
  isProtocolCompatible,
  protocolMajor,
} from "../config.js";
import {
  resolveDiscoveryPaths,
  normalizeDaemonRootPath,
  resolveStatePaths,
  type AgentsCommBusDiscoveryPaths,
  type AgentsCommBusPaths,
  type DiscoveryPathOptions,
} from "../paths.js";
import type { DaemonHello, DiagnosticMetadata } from "../ipc/protocol.js";
import { probeDaemon as defaultProbeDaemon } from "./handshake.js";
import {
  defaultSpawnLockStaleTimeoutMs,
  removeStaleSpawnLock,
  tryAcquireSpawnLock,
} from "./spawn-lock.js";
import {
  readDiscoveryClaim,
  readDiscoveryClaimRaw,
  discoveryOwnerFile,
  writeDaemonDiscoveryFiles,
  type DiscoveryClaim,
  type WriteDaemonDiscoveryFilesInput,
} from "./discovery-claim.js";
import { withDiscoveryGuard } from "./discovery-guard.js";
import { currentProcessStartEpochMs } from "../runtime/process-start-epoch.js";

export { writeDaemonDiscoveryFiles, type WriteDaemonDiscoveryFilesInput };

interface IncumbentIdentity {
  pid?: number;
  port?: number;
  startedAt?: number | null;
}

function claimToIncumbentIdentity(claim: DiscoveryClaim): IncumbentIdentity {
  return { pid: claim.pid, port: claim.port, startedAt: claim.startedAt };
}

export interface EnsureDaemonOptions extends DiscoveryPathOptions {
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  protocolVersion?: string;
  metadata?: DiagnosticMetadata;
  timeoutMs?: number;
  retryMs?: number;
  probeDaemon?: (port: number) => Promise<DaemonHello>;
  spawnDaemon?: (paths: AgentsCommBusPaths, discoveryPaths: AgentsCommBusDiscoveryPaths) => Promise<void> | void;
  terminateDaemon?: (pid: number) => Promise<void> | void;
  isPidAlive?: (pid: number) => boolean;
  log?: (message: string) => void;
}

export interface EnsureDaemonResult {
  port: number;
  hello: DaemonHello;
  spawned: boolean;
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  const env = options.env ?? process.env;
  const stateRoot = options.stateRoot ?? env.AGENTS_COMM_BUS_ROOT ?? env.AGENTS_COMM_BUS_STATE_ROOT;
  const paths = resolveStatePaths({ stateRoot });
  const pinsDiscovery = options.stateRoot !== undefined && options.discoveryRoot === undefined;
  const discoveryPaths = resolveDiscoveryPaths({
    stateRoot: paths.root,
    discoveryRoot: options.discoveryRoot ?? (pinsDiscovery ? paths.root : env.AGENTS_COMM_BUS_DISCOVERY_ROOT),
  });
  if (pinsDiscovery && env.AGENTS_COMM_BUS_DISCOVERY_ROOT) {
    (options.log ?? console.error)(`agents-comm-bus: ignoring AGENTS_COMM_BUS_DISCOVERY_ROOT=${env.AGENTS_COMM_BUS_DISCOVERY_ROOT}; explicit stateRoot ${paths.root} without discoveryRoot pins discovery to the state root`);
  }
  // AGE-106 phase 2: explicit daemonBin plumbing belongs with entryEnsures;
  // this change isolates discovery without changing host binary selection.
  await mkdir(paths.root, { recursive: true });
  await mkdir(discoveryPaths.root, { recursive: true });
  warnIfSourceModeSharesDiscoveryRoot({
    stateRoot: paths.root,
    discoveryRoot: discoveryPaths.root,
    env,
    log: options.log ?? console.error,
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_BOOTSTRAP_RETRY_MS;
  const clientProtocolVersion = options.protocolVersion ?? IPC_PROTOCOL_VERSION;
  const deadline = Date.now() + timeoutMs;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  let warnedBusy = false;
  let foreignRoot: string | undefined;
  let auditedForeign = false;
  let auditedUnknown = false;
  let auditedTerminateSkipped = false;
  const audit = new JsonlAuditStore(paths.root);
  const probe = async (port: number): Promise<DaemonHello> => {
    const pid = await readPidFile(discoveryPaths.pidFile);
    const budget = Math.max(1, Math.min(deadline - Date.now(),
      pid !== undefined && isPidAlive(pid) ? 5_000 : Math.min(1_000, retryMs * 4)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.probeDaemon ? options.probeDaemon(port) : defaultProbeDaemon({
          port,
          clientVersion: options.clientVersion ?? DAEMON_VERSION,
          protocolVersion: clientProtocolVersion,
          metadata: options.metadata,
          timeoutMs: budget,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("daemon probe timed out")), budget);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const probeDiscovery = async (): Promise<
    | {
        port: number;
        hello: DaemonHello;
        incumbent: IncumbentIdentity;
        decisionClaim?: DiscoveryClaim;
        decisionClaimRaw?: string;
      }
    | undefined
  > => {
    const claimRead = await readDiscoveryClaimRaw(discoveryPaths.root);
    const claim = claimRead?.claim;
    const incumbent: IncumbentIdentity = claim
      ? claimToIncumbentIdentity(claim)
      : { pid: await readPidFile(discoveryPaths.pidFile) };
    if (claim) {
      const normalizedExpected = normalizeDaemonRootPath(paths.root);
      const normalizedClaimRoot = normalizeDaemonRootPath(claim.stateRoot);
      if (normalizedClaimRoot !== normalizedExpected) {
        foreignRoot = claim.stateRoot;
        if (!auditedForeign) {
          auditedForeign = true;
          await audit.append({
            timestamp: Date.now(),
            kind: "daemon_discovery_foreign_state_root",
            detail: {
              port: claim.port,
              pid: claim.pid,
              expected_state_root: paths.root,
              reported_state_root: claim.stateRoot,
            },
          }).catch(() => {});
        }
        return undefined;
      }
      try {
        const hello = await probe(claim.port);
        const reported = hello.metadata?.stateRoot;
        if (typeof reported === "string" && reported.length > 0) {
          if (normalizeDaemonRootPath(reported) !== normalizedExpected) {
            foreignRoot = reported;
            if (!auditedForeign) {
              auditedForeign = true;
              await audit.append({
                timestamp: Date.now(),
                kind: "daemon_discovery_foreign_state_root",
                detail: {
                  port: claim.port,
                  pid: hello.metadata?.pid,
                  expected_state_root: paths.root,
                  reported_state_root: reported,
                },
              }).catch(() => {});
            }
            return undefined;
          }
          foreignRoot = undefined;
        }
        return {
          port: claim.port,
          hello,
          incumbent,
          decisionClaim: claim,
          decisionClaimRaw: claimRead?.raw,
        };
      } catch (error) {
        const pid = claim.pid;
        const dead = !isPidAlive(pid);
        const refused = (error as NodeJS.ErrnoException)?.code === "ECONNREFUSED";
        if (foreignRoot === undefined && (dead || refused)) {
          return undefined;
        }
        if (!dead) {
          if (!warnedBusy) {
            warnedBusy = true;
            (options.log ?? console.error)(`agents-comm-bus: daemon pid ${pid} is alive but unresponsive; waiting`);
          }
        }
        return undefined;
      }
    }

    const found = await probeFromPortFile(discoveryPaths.portFile, probe, {
    pidFile: discoveryPaths.pidFile, isPidAlive,
    allowCleanup: () => foreignRoot === undefined,
    onBusy: (pid) => {
      if (warnedBusy) return;
      warnedBusy = true;
      (options.log ?? console.error)(`agents-comm-bus: daemon pid ${pid} is alive but unresponsive; waiting`);
    },
    });
    if (!found) return undefined;
    const reported = found.hello.metadata?.stateRoot;
    if (typeof reported !== "string" || reported.length === 0) {
      if (!auditedUnknown) {
        auditedUnknown = true;
        await audit.append({ timestamp: Date.now(), kind: "daemon_discovery_state_root_unknown",
          detail: { port: found.port, pid: found.hello.metadata?.pid, expected_state_root: paths.root } }).catch(() => {});
      }
      const fallbackIncumbent: IncumbentIdentity = {
        pid: found.hello.metadata?.pid ?? incumbent.pid,
        port: found.port,
      };
      return { ...found, incumbent: fallbackIncumbent };
    }
    if (normalizeDaemonRootPath(reported) === normalizeDaemonRootPath(paths.root)) {
      foreignRoot = undefined;
      const matchedIncumbent: IncumbentIdentity = {
        pid: found.hello.metadata?.pid ?? incumbent.pid,
        port: found.port,
      };
      return { ...found, incumbent: matchedIncumbent };
    }
    foreignRoot = reported;
    if (!auditedForeign) {
      auditedForeign = true;
      await audit.append({ timestamp: Date.now(), kind: "daemon_discovery_foreign_state_root",
        detail: { port: found.port, pid: found.hello.metadata?.pid,
          expected_state_root: paths.root, reported_state_root: reported } }).catch(() => {});
    }
    return undefined;
  };

  // Reuse is gated on the IPC PROTOCOL, never on DAEMON_VERSION. A running
  // daemon whose wire/schema contract is compatible can serve this client
  // regardless of its bundle version: DAEMON_VERSION governs central-install
  // superseding + CI, not whether an already-running daemon can be talked to.
  // The old exact daemon-version equality (in BOTH directions) is what let two
  // shims at different patch versions terminate each other's daemon forever.
  // See AGENTS.md "Daemon version vs IPC protocol".
  const existing = await probeDiscovery();
  if (existing) {
    const reuse = classifyDaemonReuse(existing.hello.protocolVersion, clientProtocolVersion);
    if (reuse === "compatible") {
      return { port: existing.port, hello: existing.hello, spawned: false };
    }
    if (reuse === "daemon_newer") {
      throw new Error(
        `agents-comm-bus daemon protocol ${existing.hello.protocolVersion} is newer than this ` +
          `client's ${clientProtocolVersion}; restart this session to pick up the newer agent surface`,
      );
    }
    // reuse === "daemon_older": incompatible OLDER protocol — terminate + respawn.
    const terminated = await terminateMismatchedDaemon({
      paths: discoveryPaths,
      stateRoot: paths.root,
      livePort: existing.port,
      liveProtocol: existing.hello.protocolVersion,
      clientProtocol: clientProtocolVersion,
      helloPid: existing.hello.metadata?.pid,
      incumbent: existing.incumbent,
      decisionClaim: existing.decisionClaim,
      decisionClaimRaw: existing.decisionClaimRaw,
      terminateDaemon: options.terminateDaemon ?? defaultTerminateDaemon,
      isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
      retryMs,
      audit,
      auditedTerminateSkipped: () => auditedTerminateSkipped,
      markTerminateSkippedAudited: () => {
        auditedTerminateSkipped = true;
      },
    });
    if (!terminated) {
      const retry = await probeDiscovery();
      if (
        retry &&
        classifyDaemonReuse(retry.hello.protocolVersion, clientProtocolVersion) === "compatible"
      ) {
        return { port: retry.port, hello: retry.hello, spawned: false };
      }
    }
  }

  const afterTerminate = Date.now() < deadline ? await probeDiscovery() : undefined;
  if (
    afterTerminate &&
    classifyDaemonReuse(afterTerminate.hello.protocolVersion, clientProtocolVersion) === "compatible"
  ) {
    return { port: afterTerminate.port, hello: afterTerminate.hello, spawned: false };
  }

  if (foreignRoot === undefined) await cleanupStalePidAndPort({
    stateRoot: paths.root,
    discoveryRoot: discoveryPaths.root,
    pidFile: discoveryPaths.pidFile,
    portFile: discoveryPaths.portFile,
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
  });

  let spawned = false;
  const spawnLockOptions = {
    isPidAlive,
    staleTimeoutMs: defaultSpawnLockStaleTimeoutMs(timeoutMs),
  };

  while (Date.now() <= deadline) {
    const lock = await tryAcquireSpawnLock(discoveryPaths.spawnLock, spawnLockOptions);

    if (lock) {
      try {
        const recheck = compatibleDiscoveryResult(await probeDiscovery(), clientProtocolVersion);
        if (recheck) {
          return { ...recheck, spawned };
        }

        const claim = await readDiscoveryClaim(discoveryPaths.root);
        const incumbentPid = claim?.pid ?? await readPidFile(discoveryPaths.pidFile);
        const foreignSquatter = foreignRoot !== undefined;
        if (!foreignSquatter && incumbentPid !== undefined && isPidAlive(incumbentPid)) {
          const found = compatibleDiscoveryResult(
            await waitForDaemon(probeDiscovery, deadline, retryMs),
            clientProtocolVersion,
          );
          if (found) return { ...found, spawned };
          break;
        }
        if (Date.now() >= deadline) break;
        if (options.spawnDaemon) {
          await options.spawnDaemon(paths, discoveryPaths);
        } else {
          defaultSpawnDaemon(paths, discoveryPaths, env);
        }
        spawned = true;

        const found = compatibleDiscoveryResult(
          await waitForDaemon(probeDiscovery, deadline, retryMs),
          clientProtocolVersion,
        );
        if (found) {
          return { ...found, spawned: true };
        }
      } finally {
        await lock.release();
      }
    }

    const found = compatibleDiscoveryResult(
      await waitForDaemon(probeDiscovery, deadline, retryMs),
      clientProtocolVersion,
    );
    if (found) {
      return { ...found, spawned };
    }

    if (foreignRoot === undefined) await cleanupStalePidAndPort({
      stateRoot: paths.root,
      discoveryRoot: discoveryPaths.root,
      pidFile: discoveryPaths.pidFile,
      portFile: discoveryPaths.portFile,
      isPidAlive,
    });
    await removeStaleSpawnLock(discoveryPaths.spawnLock, spawnLockOptions);
  }

  const finalClaim = await readDiscoveryClaim(discoveryPaths.root);
  const finalPidFile = await readPidFile(discoveryPaths.pidFile);
  const livePid =
    finalClaim?.pid !== undefined && isPidAlive(finalClaim.pid)
      ? finalClaim.pid
      : finalPidFile !== undefined && isPidAlive(finalPidFile)
        ? finalPidFile
        : undefined;
  return await throwDaemonBootstrapTimeoutError(discoveryPaths.root, paths.root, livePid, foreignRoot);
}

const DAEMON_STDERR_LOG_TAIL_MAX_BYTES = 4_096;

async function readBoundedDaemonStderrTail(stateRoot: string): Promise<string | null> {
  const logPath = daemonStderrLogPath(stateRoot);
  let handle: FileHandle | undefined;
  try {
    handle = await open(logPath, "r");
    const fileStat = await handle.stat();
    if (fileStat.size === 0) return "";
    const readStart = Math.max(0, fileStat.size - DAEMON_STDERR_LOG_TAIL_MAX_BYTES);
    const readLength = fileStat.size - readStart;
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, readStart);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function throwDaemonBootstrapTimeoutError(
  discoveryRoot: string,
  stateRoot: string,
  livePid?: number,
  foreignRoot?: string,
): Promise<never> {
  const logPath = daemonStderrLogPath(stateRoot);
  let message = `Timed out starting agents-comm-bus daemon under ${discoveryRoot}.`;
  if (livePid !== undefined) message += ` Daemon pid ${livePid} is alive but unresponsive; no replacement spawned.`;
  if (foreignRoot !== undefined) {
    message += ` Discovery reports foreign state root ${foreignRoot}; spawn may replace the squatter.`;
  }
  message += `\nDaemon stderr log: ${logPath}`;
  const tail = await readBoundedDaemonStderrTail(stateRoot);
  if (tail === null) {
    message += " (log unavailable)";
  } else if (tail.length === 0) {
    message += " (log empty)";
  } else {
    message += `\n--- recent stderr (last ${DAEMON_STDERR_LOG_TAIL_MAX_BYTES} bytes) ---\n${tail}\n--- end stderr ---`;
  }
  throw new Error(message);
}

/**
 * Classify a running daemon's IPC protocol against this client's, for the reuse
 * decision. Keys on protocol MAJOR only — DAEMON_VERSION is irrelevant here (it
 * gates central-install supersede + CI, not live reuse).
 *   - "compatible"  : same protocol major → reuse the running daemon as-is.
 *   - "daemon_older": daemon's protocol major is older → terminate + respawn.
 *   - "daemon_newer": daemon's protocol major is newer → do NOT downgrade it;
 *                     the session must restart to pick up the newer surface.
 */
function classifyDaemonReuse(
  daemonProtocol: string,
  clientProtocol: string,
): "compatible" | "daemon_older" | "daemon_newer" {
  if (isProtocolCompatible(daemonProtocol, clientProtocol)) return "compatible";
  return Number(protocolMajor(daemonProtocol)) > Number(protocolMajor(clientProtocol))
    ? "daemon_newer"
    : "daemon_older";
}

function compatibleDiscoveryResult(
  found: { port: number; hello: DaemonHello; incumbent: IncumbentIdentity } | undefined,
  clientProtocolVersion: string,
): { port: number; hello: DaemonHello } | undefined {
  if (!found) return undefined;
  if (classifyDaemonReuse(found.hello.protocolVersion, clientProtocolVersion) !== "compatible") {
    return undefined;
  }
  return { port: found.port, hello: found.hello };
}

async function terminateMismatchedDaemon(input: {
  paths: AgentsCommBusDiscoveryPaths;
  stateRoot: string;
  livePort: number;
  liveProtocol: string;
  clientProtocol: string;
  helloPid?: number;
  incumbent: IncumbentIdentity;
  decisionClaim?: DiscoveryClaim;
  decisionClaimRaw?: string;
  terminateDaemon: (pid: number) => Promise<void> | void;
  isPidAlive: (pid: number) => boolean;
  retryMs: number;
  audit: JsonlAuditStore;
  auditedTerminateSkipped: () => boolean;
  markTerminateSkippedAudited: () => void;
}): Promise<boolean> {
  const decisionIncumbent = input.incumbent;
  const decisionClaim = input.decisionClaim;
  const decisionClaimRaw = input.decisionClaimRaw;

  let terminatePid = input.helloPid;
  if (terminatePid === undefined || !Number.isInteger(terminatePid) || terminatePid <= 0) {
    if (!decisionClaim) {
      const legacyPid = await readPidFile(input.paths.pidFile);
      if (legacyPid !== undefined) {
        terminatePid = legacyPid;
      }
    }
  }
  if (terminatePid === undefined || !Number.isInteger(terminatePid) || terminatePid <= 0) {
    if (!input.auditedTerminateSkipped()) {
      input.markTerminateSkippedAudited();
      await input.audit.append({
        timestamp: Date.now(),
        kind: "daemon_terminate_skipped_identity_unknown",
        detail: { port: input.livePort, reason: "hello_pid_missing" },
      }).catch(() => {});
    }
    return false;
  }

  if (decisionClaim && terminatePid !== decisionClaim.pid) {
    if (!input.auditedTerminateSkipped()) {
      input.markTerminateSkippedAudited();
      await input.audit.append({
        timestamp: Date.now(),
        kind: "daemon_terminate_skipped_identity_unknown",
        detail: { port: input.livePort, claim_pid: decisionClaim.pid, hello_pid: terminatePid },
      }).catch(() => {});
    }
    return false;
  }

  if (decisionClaim && decisionClaimRaw !== undefined) {
    const reread = await readDiscoveryClaimRaw(input.paths.root);
    if (!reread || reread.raw !== decisionClaimRaw) {
      if (!input.auditedTerminateSkipped()) {
        input.markTerminateSkippedAudited();
        await input.audit.append({
          timestamp: Date.now(),
          kind: "daemon_terminate_skipped_identity_unknown",
          detail: { port: input.livePort, reason: "claim_changed" },
        }).catch(() => {});
      }
      return false;
    }
  } else {
    const ownerPresent = await readDiscoveryClaim(input.paths.root);
    const legacyPid = await readPidFile(input.paths.pidFile);
    const legacyPort = await readPortFile(input.paths.portFile);
    const decisionPid = decisionIncumbent.pid ?? terminatePid;
    if (
      ownerPresent !== undefined ||
      legacyPid !== decisionPid ||
      legacyPort !== input.livePort
    ) {
      if (!input.auditedTerminateSkipped()) {
        input.markTerminateSkippedAudited();
        await input.audit.append({
          timestamp: Date.now(),
          kind: "daemon_terminate_skipped_identity_unknown",
          detail: { port: input.livePort, reason: "legacy_changed" },
        }).catch(() => {});
      }
      return false;
    }
  }

  await input.terminateDaemon(terminatePid);
  for (let attempt = 0; attempt < 20 && input.isPidAlive(terminatePid); attempt += 1) {
    await sleep(input.retryMs);
  }
  if (input.isPidAlive(terminatePid)) {
    throw new Error(
      `agents-comm-bus daemon pid ${terminatePid} speaks incompatible IPC protocol ` +
        `${input.liveProtocol} (client ${input.clientProtocol}); failed to terminate old daemon`,
    );
  }

  const guardedCleanup = await withDiscoveryGuard(
    input.paths.root,
    { pid: process.pid, startedAt: currentProcessStartEpochMs() },
    async () => {
      if (decisionClaim && decisionClaimRaw !== undefined) {
        const reread = await readDiscoveryClaimRaw(input.paths.root);
        if (!reread || reread.raw !== decisionClaimRaw) {
          return;
        }
        await rm(discoveryOwnerFile(input.paths.root), { force: true });
        await rm(input.paths.pidFile, { force: true });
        await rm(input.paths.portFile, { force: true });
        return;
      }
      const ownerPresent = await readDiscoveryClaim(input.paths.root);
      if (ownerPresent !== undefined) {
        return;
      }
      const legacyPid = await readPidFile(input.paths.pidFile);
      const legacyPort = await readPortFile(input.paths.portFile);
      if (legacyPid !== terminatePid || legacyPort !== input.livePort) {
        return;
      }
      await rm(input.paths.pidFile, { force: true });
      await rm(input.paths.portFile, { force: true });
    },
    { isPidAlive: input.isPidAlive },
  );
  if (!guardedCleanup.ok) {
    // Best-effort: a successor may hold the guard; leave discovery files intact.
  }
  return true;
}

async function probeFromPortFile(
  portFile: string,
  probe: (port: number) => Promise<DaemonHello>,
  options: { pidFile: string; isPidAlive: (pid: number) => boolean; onBusy: (pid: number) => void; allowCleanup?: () => boolean },
): Promise<{ port: number; hello: DaemonHello } | undefined> {
  const port = await readPortFile(portFile);
  if (port === undefined) {
    return undefined;
  }

  try {
    return { port, hello: await probe(port) };
  } catch (error) {
    const pid = await readPidFile(options.pidFile);
    const dead = pid !== undefined && !options.isPidAlive(pid);
    const refused = (error as NodeJS.ErrnoException)?.code === "ECONNREFUSED";
    // Timeout/reset/malformed hello is not evidence that an incumbent died.
    // Recheck the observed port before cleanup; never remove a replacement.
    if (options.allowCleanup?.() !== false && (dead || refused) && await readPortFile(portFile) === port) {
      await rm(portFile, { force: true });
    } else if (pid !== undefined && !dead) {
      options.onBusy(pid);
    }
    return undefined;
  }
}

async function waitForDaemon(
  probeDiscovery: () => Promise<{ port: number; hello: DaemonHello; incumbent: IncumbentIdentity } | undefined>,
  deadline: number,
  retryMs: number,
): Promise<{ port: number; hello: DaemonHello; incumbent: IncumbentIdentity } | undefined> {
  while (Date.now() <= deadline) {
    const found = await probeDiscovery();
    if (found) {
      return found;
    }
    await sleep(retryMs);
  }
  return undefined;
}

export function daemonStderrLogPath(stateRoot: string): string {
  return path.join(stateRoot, "daemon.stderr.log");
}

/** Spawn stdio for a detached daemon child: stdout+stderr share an append log fd. */
export function daemonSpawnStdio(stateRoot: string): ["ignore", number, number] {
  mkdirSync(stateRoot, { recursive: true });
  const logFd = openSync(daemonStderrLogPath(stateRoot), "a");
  return ["ignore", logFd, logFd];
}

export async function cleanupStalePidAndPort(input: {
  stateRoot: string;
  discoveryRoot: string;
  pidFile: string;
  portFile: string;
  isPidAlive: (pid: number) => boolean;
}): Promise<void> {
  const owner = await readDiscoveryClaim(input.discoveryRoot);
  if (owner !== undefined) {
    return;
  }

  const guarded = await withDiscoveryGuard(
    input.discoveryRoot,
    { pid: process.pid, startedAt: currentProcessStartEpochMs() },
    async () => {
      const ownerInGuard = await readDiscoveryClaim(input.discoveryRoot);
      if (ownerInGuard !== undefined) {
        return;
      }
      const pid = await readPidFile(input.pidFile);
      if (pid !== undefined && !input.isPidAlive(pid)) {
        await rm(input.pidFile, { force: true });
        await rm(input.portFile, { force: true });
        const audit = new JsonlAuditStore(input.stateRoot);
        await audit
          .append({
            timestamp: Date.now(),
            kind: "discovery_stale_cleanup",
            detail: { stale_pid: pid, pid_file: input.pidFile, port_file: input.portFile },
          })
          .catch(() => {});
      }
    },
    { isPidAlive: input.isPidAlive },
  );
  if (!guarded.ok) {
    // guard_contended: skip cleanup rather than racing a successor.
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
    // Permission denied is not evidence of death.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function defaultTerminateDaemon(pid: number): void {
  if (pid === process.pid) {
    throw new Error("refusing to terminate current process as daemon");
  }
  process.kill(pid, "SIGTERM");
}

function defaultSpawnDaemon(
  paths: AgentsCommBusPaths,
  discoveryPaths: AgentsCommBusDiscoveryPaths,
  env: NodeJS.ProcessEnv = process.env,
): void {
  // Source/dev mode is signalled by AGENTS_COMM_BUS_BIN (the authoritative
  // source switch, same one resolveInstallMode keys on): run the daemon from
  // the project's source entry. Otherwise this is a production/central install,
  // and the daemon is the self-contained bundle the install hook copied to
  // `<stateRoot>/bin/daemon.js` (alongside a `bin/package.json` {"type":"module"}
  // so node treats the .js bundle as ESM regardless of cwd). Resolving relative
  // to import.meta.url is wrong in production because this module is itself
  // inlined into the staged hook bundle, where `../serve.js` does not exist.
  const binOverride = env.AGENTS_COMM_BUS_BIN;
  const daemonEntry = binOverride
    ? path.resolve(binOverride)
    : path.join(paths.root, "bin", "daemon.js");
  const stdio = daemonSpawnStdio(paths.root);
  const child = spawn(process.execPath, [daemonEntry, "serve"], {
    detached: true,
    stdio,
    env: {
      ...env,
      AGENTS_COMM_BUS_STATE_ROOT: paths.root,
      AGENTS_COMM_BUS_DISCOVERY_ROOT: discoveryPaths.root,
    },
  });
  try {
    closeSync(stdio[1]);
  } catch {
    // best-effort: child already inherited a dup of the log fd
  }
  child.unref();
}

function warnIfSourceModeSharesDiscoveryRoot(input: {
  stateRoot: string;
  discoveryRoot: string;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
}): void {
  if (!input.env.AGENTS_COMM_BUS_BIN) return;
  if (path.resolve(input.stateRoot) !== path.resolve(input.discoveryRoot)) return;
  input.log(
    "agents-comm-bus: source/dev daemon is sharing the production discovery root; " +
      "set discoveryRoot in .agents-comm-bus-dev.json (for example " +
      ".agents-comm-bus-discovery/) to let dev and prod daemons coexist.",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
