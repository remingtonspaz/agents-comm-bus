import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { JsonlAuditStore } from "../storage/audit.js";
import { DAEMON_VERSION, DEFAULT_BOOTSTRAP_RETRY_MS, DEFAULT_BOOTSTRAP_TIMEOUT_MS, IPC_PROTOCOL_VERSION, isProtocolCompatible, protocolMajor, } from "../config.js";
import { resolveDiscoveryPaths, normalizeDaemonRootPath, resolveStatePaths, } from "../paths.js";
import { probeDaemon as defaultProbeDaemon } from "./handshake.js";
import { defaultSpawnLockStaleTimeoutMs, removeStaleSpawnLock, tryAcquireSpawnLock, } from "./spawn-lock.js";
import { readDiscoveryClaim, writeDaemonDiscoveryFiles, } from "./discovery-claim.js";
export { writeDaemonDiscoveryFiles };
export async function ensureDaemon(options = {}) {
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
    let foreignRoot;
    let auditedForeign = false;
    let auditedUnknown = false;
    const audit = new JsonlAuditStore(paths.root);
    const probe = async (port) => {
        const pid = await readPidFile(discoveryPaths.pidFile);
        const budget = Math.max(1, Math.min(deadline - Date.now(), pid !== undefined && isPidAlive(pid) ? 5_000 : Math.min(1_000, retryMs * 4)));
        let timer;
        try {
            return await Promise.race([
                options.probeDaemon ? options.probeDaemon(port) : defaultProbeDaemon({
                    port,
                    clientVersion: options.clientVersion ?? DAEMON_VERSION,
                    protocolVersion: clientProtocolVersion,
                    metadata: options.metadata,
                    timeoutMs: budget,
                }),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error("daemon probe timed out")), budget);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    };
    const probeDiscovery = async () => {
        const claim = await readDiscoveryClaim(discoveryPaths.root);
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
                    }).catch(() => { });
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
                            }).catch(() => { });
                        }
                        return undefined;
                    }
                    foreignRoot = undefined;
                }
                return { port: claim.port, hello };
            }
            catch (error) {
                const pid = claim.pid;
                const dead = !isPidAlive(pid);
                const refused = error?.code === "ECONNREFUSED";
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
                if (warnedBusy)
                    return;
                warnedBusy = true;
                (options.log ?? console.error)(`agents-comm-bus: daemon pid ${pid} is alive but unresponsive; waiting`);
            },
        });
        if (!found)
            return undefined;
        const reported = found.hello.metadata?.stateRoot;
        if (typeof reported !== "string" || reported.length === 0) {
            if (!auditedUnknown) {
                auditedUnknown = true;
                await audit.append({ timestamp: Date.now(), kind: "daemon_discovery_state_root_unknown",
                    detail: { port: found.port, pid: found.hello.metadata?.pid, expected_state_root: paths.root } }).catch(() => { });
            }
            return found; // Legacy hello: retain protocol-only compatibility.
        }
        if (normalizeDaemonRootPath(reported) === normalizeDaemonRootPath(paths.root)) {
            foreignRoot = undefined;
            return found;
        }
        foreignRoot = reported;
        if (!auditedForeign) {
            auditedForeign = true;
            await audit.append({ timestamp: Date.now(), kind: "daemon_discovery_foreign_state_root",
                detail: { port: found.port, pid: found.hello.metadata?.pid,
                    expected_state_root: paths.root, reported_state_root: reported } }).catch(() => { });
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
            return { ...existing, spawned: false };
        }
        if (reuse === "daemon_newer") {
            throw new Error(`agents-comm-bus daemon protocol ${existing.hello.protocolVersion} is newer than this ` +
                `client's ${clientProtocolVersion}; restart this session to pick up the newer agent surface`);
        }
        // reuse === "daemon_older": incompatible OLDER protocol — terminate + respawn.
        await terminateMismatchedDaemon({
            paths: discoveryPaths,
            livePort: existing.port,
            liveProtocol: existing.hello.protocolVersion,
            clientProtocol: clientProtocolVersion,
            terminateDaemon: options.terminateDaemon ?? defaultTerminateDaemon,
            isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
            retryMs,
        });
    }
    const afterTerminate = Date.now() < deadline ? await probeDiscovery() : undefined;
    if (afterTerminate &&
        classifyDaemonReuse(afterTerminate.hello.protocolVersion, clientProtocolVersion) === "compatible") {
        return { ...afterTerminate, spawned: false };
    }
    if (foreignRoot === undefined)
        await cleanupStalePidAndPort({
            stateRoot: paths.root,
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
                const recheck = await probeDiscovery();
                if (recheck) {
                    return { ...recheck, spawned };
                }
                const incumbentPid = await readPidFile(discoveryPaths.pidFile);
                const foreignSquatter = foreignRoot !== undefined;
                if (!foreignSquatter && incumbentPid !== undefined && isPidAlive(incumbentPid)) {
                    const found = await waitForDaemon(probeDiscovery, deadline, retryMs);
                    if (found)
                        return { ...found, spawned };
                    break;
                }
                if (Date.now() >= deadline)
                    break;
                if (options.spawnDaemon) {
                    await options.spawnDaemon(paths, discoveryPaths);
                }
                else {
                    defaultSpawnDaemon(paths, discoveryPaths, env);
                }
                spawned = true;
                const found = await waitForDaemon(probeDiscovery, deadline, retryMs);
                if (found) {
                    return { ...found, spawned: true };
                }
            }
            finally {
                await lock.release();
            }
        }
        const found = await waitForDaemon(probeDiscovery, deadline, retryMs);
        if (found) {
            return { ...found, spawned };
        }
        if (foreignRoot === undefined)
            await cleanupStalePidAndPort({
                stateRoot: paths.root,
                pidFile: discoveryPaths.pidFile,
                portFile: discoveryPaths.portFile,
                isPidAlive,
            });
        await removeStaleSpawnLock(discoveryPaths.spawnLock, spawnLockOptions);
    }
    const finalPid = await readPidFile(discoveryPaths.pidFile);
    return await throwDaemonBootstrapTimeoutError(discoveryPaths.root, paths.root, finalPid !== undefined && isPidAlive(finalPid) ? finalPid : undefined, foreignRoot);
}
const DAEMON_STDERR_LOG_TAIL_MAX_BYTES = 4_096;
async function readBoundedDaemonStderrTail(stateRoot) {
    const logPath = daemonStderrLogPath(stateRoot);
    let handle;
    try {
        handle = await open(logPath, "r");
        const fileStat = await handle.stat();
        if (fileStat.size === 0)
            return "";
        const readStart = Math.max(0, fileStat.size - DAEMON_STDERR_LOG_TAIL_MAX_BYTES);
        const readLength = fileStat.size - readStart;
        const buffer = Buffer.alloc(readLength);
        const { bytesRead } = await handle.read(buffer, 0, readLength, readStart);
        return buffer.subarray(0, bytesRead).toString("utf8");
    }
    catch {
        return null;
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
async function throwDaemonBootstrapTimeoutError(discoveryRoot, stateRoot, livePid, foreignRoot) {
    const logPath = daemonStderrLogPath(stateRoot);
    let message = `Timed out starting agents-comm-bus daemon under ${discoveryRoot}.`;
    if (livePid !== undefined)
        message += ` Daemon pid ${livePid} is alive but unresponsive; no replacement spawned.`;
    if (foreignRoot !== undefined) {
        message += ` Discovery reports foreign state root ${foreignRoot}; spawn may replace the squatter.`;
    }
    message += `\nDaemon stderr log: ${logPath}`;
    const tail = await readBoundedDaemonStderrTail(stateRoot);
    if (tail === null) {
        message += " (log unavailable)";
    }
    else if (tail.length === 0) {
        message += " (log empty)";
    }
    else {
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
function classifyDaemonReuse(daemonProtocol, clientProtocol) {
    if (isProtocolCompatible(daemonProtocol, clientProtocol))
        return "compatible";
    return Number(protocolMajor(daemonProtocol)) > Number(protocolMajor(clientProtocol))
        ? "daemon_newer"
        : "daemon_older";
}
async function terminateMismatchedDaemon(input) {
    const pid = await readPidFile(input.paths.pidFile);
    if (pid === undefined) {
        throw new Error(`agents-comm-bus daemon on port ${input.livePort} speaks incompatible IPC ` +
            `protocol ${input.liveProtocol} (client ${input.clientProtocol}); cannot ` +
            `restart because ${input.paths.pidFile} is missing`);
    }
    await input.terminateDaemon(pid);
    for (let attempt = 0; attempt < 20 && input.isPidAlive(pid); attempt += 1) {
        await sleep(input.retryMs);
    }
    if (input.isPidAlive(pid)) {
        throw new Error(`agents-comm-bus daemon pid ${pid} speaks incompatible IPC protocol ` +
            `${input.liveProtocol} (client ${input.clientProtocol}); failed to terminate old daemon`);
    }
    await rm(input.paths.pidFile, { force: true });
    await rm(input.paths.portFile, { force: true });
}
async function probeFromPortFile(portFile, probe, options) {
    const port = await readPortFile(portFile);
    if (port === undefined) {
        return undefined;
    }
    try {
        return { port, hello: await probe(port) };
    }
    catch (error) {
        const pid = await readPidFile(options.pidFile);
        const dead = pid !== undefined && !options.isPidAlive(pid);
        const refused = error?.code === "ECONNREFUSED";
        // Timeout/reset/malformed hello is not evidence that an incumbent died.
        // Recheck the observed port before cleanup; never remove a replacement.
        if (options.allowCleanup?.() !== false && (dead || refused) && await readPortFile(portFile) === port) {
            await rm(portFile, { force: true });
        }
        else if (pid !== undefined && !dead) {
            options.onBusy(pid);
        }
        return undefined;
    }
}
async function waitForDaemon(probeDiscovery, deadline, retryMs) {
    while (Date.now() <= deadline) {
        const found = await probeDiscovery();
        if (found) {
            return found;
        }
        await sleep(retryMs);
    }
    return undefined;
}
export function daemonStderrLogPath(stateRoot) {
    return path.join(stateRoot, "daemon.stderr.log");
}
/** Spawn stdio for a detached daemon child: stdout+stderr share an append log fd. */
export function daemonSpawnStdio(stateRoot) {
    mkdirSync(stateRoot, { recursive: true });
    const logFd = openSync(daemonStderrLogPath(stateRoot), "a");
    return ["ignore", logFd, logFd];
}
async function cleanupStalePidAndPort(input) {
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
            .catch(() => { });
    }
}
async function readPortFile(portFile) {
    try {
        const raw = (await readFile(portFile, "utf8")).trim();
        const port = Number(raw);
        return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
    }
    catch {
        return undefined;
    }
}
async function readPidFile(pidFile) {
    try {
        const raw = (await readFile(pidFile, "utf8")).trim();
        const pid = Number(raw);
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    }
    catch {
        return undefined;
    }
}
function defaultIsPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // Permission denied is not evidence of death.
        return error.code !== "ESRCH";
    }
}
function defaultTerminateDaemon(pid) {
    if (pid === process.pid) {
        throw new Error("refusing to terminate current process as daemon");
    }
    process.kill(pid, "SIGTERM");
}
function defaultSpawnDaemon(paths, discoveryPaths, env = process.env) {
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
    }
    catch {
        // best-effort: child already inherited a dup of the log fd
    }
    child.unref();
}
function warnIfSourceModeSharesDiscoveryRoot(input) {
    if (!input.env.AGENTS_COMM_BUS_BIN)
        return;
    if (path.resolve(input.stateRoot) !== path.resolve(input.discoveryRoot))
        return;
    input.log("agents-comm-bus: source/dev daemon is sharing the production discovery root; " +
        "set discoveryRoot in .agents-comm-bus-dev.json (for example " +
        ".agents-comm-bus-discovery/) to let dev and prod daemons coexist.");
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=ensure-daemon.js.map