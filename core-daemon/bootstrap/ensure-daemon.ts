import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DAEMON_VERSION,
  DEFAULT_BOOTSTRAP_RETRY_MS,
  DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  IPC_PROTOCOL_VERSION,
  isProtocolCompatible,
  protocolMajor,
} from "../config.js";
import { resolveStatePaths, type StatePathOptions } from "../paths.js";
import type { DaemonHello, DiagnosticMetadata } from "../ipc/protocol.js";
import { probeDaemon as defaultProbeDaemon } from "./handshake.js";
import { removeSpawnLock, tryAcquireSpawnLock } from "./spawn-lock.js";

export interface EnsureDaemonOptions extends StatePathOptions {
  clientVersion?: string;
  protocolVersion?: string;
  metadata?: DiagnosticMetadata;
  timeoutMs?: number;
  retryMs?: number;
  probeDaemon?: (port: number) => Promise<DaemonHello>;
  spawnDaemon?: (paths: ReturnType<typeof resolveStatePaths>) => Promise<void> | void;
  terminateDaemon?: (pid: number) => Promise<void> | void;
  isPidAlive?: (pid: number) => boolean;
}

export interface EnsureDaemonResult {
  port: number;
  hello: DaemonHello;
  spawned: boolean;
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  const paths = resolveStatePaths(options);
  await mkdir(paths.root, { recursive: true });

  const timeoutMs = options.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_BOOTSTRAP_RETRY_MS;
  const clientProtocolVersion = options.protocolVersion ?? IPC_PROTOCOL_VERSION;
  const deadline = Date.now() + timeoutMs;
  const probe = options.probeDaemon ?? ((port: number) => defaultProbeDaemon({
    port,
    clientVersion: options.clientVersion ?? DAEMON_VERSION,
    protocolVersion: clientProtocolVersion,
    metadata: options.metadata,
    timeoutMs: Math.min(1_000, retryMs * 4),
  }));

  // Reuse is gated on the IPC PROTOCOL, never on DAEMON_VERSION. A running
  // daemon whose wire/schema contract is compatible can serve this client
  // regardless of its bundle version: DAEMON_VERSION governs central-install
  // superseding + CI, not whether an already-running daemon can be talked to.
  // The old exact daemon-version equality (in BOTH directions) is what let two
  // shims at different patch versions terminate each other's daemon forever.
  // See AGENTS.md "Daemon version vs IPC protocol".
  const existing = await probeFromPortFile(paths.portFile, probe);
  if (existing) {
    const reuse = classifyDaemonReuse(existing.hello.protocolVersion, clientProtocolVersion);
    if (reuse === "compatible") {
      return { ...existing, spawned: false };
    }
    if (reuse === "daemon_newer") {
      throw new Error(
        `agents-comm-bus daemon protocol ${existing.hello.protocolVersion} is newer than this ` +
          `client's ${clientProtocolVersion}; restart this session to pick up the newer agent surface`,
      );
    }
    // reuse === "daemon_older": incompatible OLDER protocol — terminate + respawn.
    await terminateMismatchedDaemon({
      paths,
      livePort: existing.port,
      liveProtocol: existing.hello.protocolVersion,
      clientProtocol: clientProtocolVersion,
      terminateDaemon: options.terminateDaemon ?? defaultTerminateDaemon,
      isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
      retryMs,
    });
  }

  const afterTerminate = await probeFromPortFile(paths.portFile, probe);
  if (
    afterTerminate &&
    classifyDaemonReuse(afterTerminate.hello.protocolVersion, clientProtocolVersion) === "compatible"
  ) {
    return { ...afterTerminate, spawned: false };
  }

  await cleanupStalePidAndPort({
    pidFile: paths.pidFile,
    portFile: paths.portFile,
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
  });

  let spawned = false;

  while (Date.now() <= deadline) {
    const lock = await tryAcquireSpawnLock(paths.spawnLock);

    if (lock) {
      try {
        const recheck = await probeFromPortFile(paths.portFile, probe);
        if (recheck) {
          return { ...recheck, spawned };
        }

        await (options.spawnDaemon ?? defaultSpawnDaemon)(paths);
        spawned = true;
      } finally {
        await lock.release();
      }
    }

    const found = await waitForDaemon(paths.portFile, probe, deadline, retryMs);
    if (found) {
      return { ...found, spawned };
    }

    await cleanupStalePidAndPort({
      pidFile: paths.pidFile,
      portFile: paths.portFile,
      isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    });
    await removeSpawnLock(paths.spawnLock);
  }

  throw new Error(`Timed out starting agents-comm-bus daemon under ${paths.root}.`);
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

async function terminateMismatchedDaemon(input: {
  paths: ReturnType<typeof resolveStatePaths>;
  livePort: number;
  liveProtocol: string;
  clientProtocol: string;
  terminateDaemon: (pid: number) => Promise<void> | void;
  isPidAlive: (pid: number) => boolean;
  retryMs: number;
}): Promise<void> {
  const pid = await readPidFile(input.paths.pidFile);
  if (pid === undefined) {
    throw new Error(
      `agents-comm-bus daemon on port ${input.livePort} speaks incompatible IPC ` +
        `protocol ${input.liveProtocol} (client ${input.clientProtocol}); cannot ` +
        `restart because ${input.paths.pidFile} is missing`,
    );
  }

  await input.terminateDaemon(pid);
  for (let attempt = 0; attempt < 20 && input.isPidAlive(pid); attempt += 1) {
    await sleep(input.retryMs);
  }
  if (input.isPidAlive(pid)) {
    throw new Error(
      `agents-comm-bus daemon pid ${pid} speaks incompatible IPC protocol ` +
        `${input.liveProtocol} (client ${input.clientProtocol}); failed to terminate old daemon`,
    );
  }

  await rm(input.paths.pidFile, { force: true });
  await rm(input.paths.portFile, { force: true });
}

async function probeFromPortFile(
  portFile: string,
  probe: (port: number) => Promise<DaemonHello>,
): Promise<{ port: number; hello: DaemonHello } | undefined> {
  const port = await readPortFile(portFile);
  if (port === undefined) {
    return undefined;
  }

  try {
    return { port, hello: await probe(port) };
  } catch {
    await rm(portFile, { force: true });
    return undefined;
  }
}

async function waitForDaemon(
  portFile: string,
  probe: (port: number) => Promise<DaemonHello>,
  deadline: number,
  retryMs: number,
): Promise<{ port: number; hello: DaemonHello } | undefined> {
  while (Date.now() <= deadline) {
    const found = await probeFromPortFile(portFile, probe);
    if (found) {
      return found;
    }
    await sleep(retryMs);
  }
  return undefined;
}

async function cleanupStalePidAndPort(input: {
  pidFile: string;
  portFile: string;
  isPidAlive: (pid: number) => boolean;
}): Promise<void> {
  const pid = await readPidFile(input.pidFile);
  if (pid !== undefined && !input.isPidAlive(pid)) {
    await rm(input.pidFile, { force: true });
    await rm(input.portFile, { force: true });
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
  } catch {
    return false;
  }
}

function defaultTerminateDaemon(pid: number): void {
  if (pid === process.pid) {
    throw new Error("refusing to terminate current process as daemon");
  }
  process.kill(pid, "SIGTERM");
}

function defaultSpawnDaemon(paths: ReturnType<typeof resolveStatePaths>): void {
  // Source/dev mode is signalled by AGENTS_COMM_BUS_BIN (the authoritative
  // source switch, same one resolveInstallMode keys on): run the daemon from
  // the project's source entry. Otherwise this is a production/central install,
  // and the daemon is the self-contained bundle the install hook copied to
  // `<stateRoot>/bin/daemon.js` (alongside a `bin/package.json` {"type":"module"}
  // so node treats the .js bundle as ESM regardless of cwd). Resolving relative
  // to import.meta.url is wrong in production because this module is itself
  // inlined into the staged hook bundle, where `../serve.js` does not exist.
  const binOverride = process.env.AGENTS_COMM_BUS_BIN;
  const daemonEntry = binOverride
    ? path.resolve(binOverride)
    : path.join(paths.root, "bin", "daemon.js");
  const child = spawn(process.execPath, [daemonEntry, "serve"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      AGENTS_COMM_BUS_STATE_ROOT: paths.root,
    },
  });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function writeDaemonDiscoveryFiles(input: {
  stateRoot?: string;
  pid?: number;
  port: number;
  probeDaemon?: (port: number) => Promise<DaemonHello>;
}): Promise<void> {
  const paths = resolveStatePaths({ stateRoot: input.stateRoot });
  await mkdir(paths.root, { recursive: true });

  const existingPort = await readPortFile(paths.portFile);
  if (existingPort !== undefined && existingPort !== input.port) {
    const probe = input.probeDaemon ?? ((port: number) => defaultProbeDaemon({ port }));
    let existingDaemonIsLive = false;
    try {
      await probe(existingPort);
      existingDaemonIsLive = true;
    } catch {
      existingDaemonIsLive = false;
    }
    if (existingDaemonIsLive) {
      throw new Error(
        `agents-comm-bus daemon already running on port ${existingPort}; ` +
          `refusing to overwrite discovery with port ${input.port}`,
      );
    }
  }

  await writeFile(paths.pidFile, `${input.pid ?? process.pid}\n`, "utf8");
  await writeFile(paths.portFile, `${input.port}\n`, "utf8");
}
