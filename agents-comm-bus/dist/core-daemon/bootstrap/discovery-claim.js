import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { IPC_PROTOCOL_VERSION } from "../config.js";
import { normalizeDaemonRootPath, resolveDiscoveryPaths } from "../paths.js";
import { currentProcessStartEpochMs } from "../runtime/process-start-epoch.js";
import { JsonlAuditStore } from "../storage/audit.js";
import { probeDaemon as defaultProbeDaemon } from "./handshake.js";
import { tryAcquireSpawnLock } from "./spawn-lock.js";
export class DiscoveryClaimLostError extends Error {
    winner;
    constructor(winner) {
        super(`agents-comm-bus daemon already running on port ${winner.port} ` +
            `(pid ${winner.pid}, state root ${winner.stateRoot})`);
        this.name = "DiscoveryClaimLostError";
        this.winner = winner;
    }
}
const OWNER_FILE = "owner.json";
export function discoveryOwnerFile(discoveryRoot) {
    return path.join(discoveryRoot, OWNER_FILE);
}
export async function readDiscoveryClaim(discoveryRoot) {
    try {
        const raw = await readFile(discoveryOwnerFile(discoveryRoot), "utf8");
        return parseDiscoveryClaim(raw);
    }
    catch {
        return undefined;
    }
}
export function parseDiscoveryClaim(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.pid !== "number" ||
            !Number.isInteger(parsed.pid) ||
            parsed.pid <= 0 ||
            typeof parsed.port !== "number" ||
            !Number.isInteger(parsed.port) ||
            parsed.port <= 0 ||
            parsed.port >= 65_536 ||
            typeof parsed.stateRoot !== "string" ||
            parsed.stateRoot.length === 0 ||
            typeof parsed.protocolVersion !== "string" ||
            parsed.protocolVersion.length === 0) {
            return undefined;
        }
        const startedAt = parsed.startedAt === null || parsed.startedAt === undefined
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
    }
    catch {
        return undefined;
    }
}
export function discoveryClaimIdentityMatches(claim, selfPid, selfStartedAt) {
    if (claim.pid !== selfPid)
        return false;
    if (claim.startedAt == null || selfStartedAt == null)
        return true;
    return claim.startedAt === selfStartedAt;
}
export async function claimDiscovery(input) {
    const paths = resolveDiscoveryPaths({
        stateRoot: input.stateRoot,
        discoveryRoot: input.discoveryRoot,
    });
    await mkdir(paths.root, { recursive: true });
    const selfPid = input.pid ?? process.pid;
    const selfStartedAt = input.startedAt ?? currentProcessStartEpochMs();
    const selfClaim = {
        pid: selfPid,
        port: input.port,
        stateRoot: input.stateRoot,
        startedAt: selfStartedAt,
        protocolVersion: input.protocolVersion ?? IPC_PROTOCOL_VERSION,
    };
    const isPidAlive = input.isPidAlive ?? defaultIsPidAlive;
    const probe = input.probeDaemon ?? ((port) => defaultProbeDaemon({ port }));
    const auditRoot = input.auditStateRoot ?? input.stateRoot;
    const lock = await tryAcquireSpawnLock(paths.spawnLock, { isPidAlive });
    try {
        return await claimDiscoveryUnderLock({
            paths,
            selfClaim,
            isPidAlive,
            probe,
            auditRoot,
        });
    }
    finally {
        await lock?.release();
    }
}
async function claimDiscoveryUnderLock(input) {
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
            return decision.result;
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
            return decision.result;
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
        await writeOwnerClaimAtomic(ownerFile, input.selfClaim, { replace: false });
    }
    catch (error) {
        if (!isAlreadyExistsError(error))
            throw error;
        const raced = await readDiscoveryClaim(input.paths.root);
        if (!raced)
            throw error;
        const decision = await classifyIncumbent({
            incumbent: raced,
            selfClaim: input.selfClaim,
            isPidAlive: input.isPidAlive,
            probe: input.probe,
            normalizedSelfRoot: normalizeDaemonRootPath(input.selfClaim.stateRoot),
        });
        if (decision.action === "return")
            return decision.result;
        if (decision.action === "replace") {
            await writeOwnerClaimAtomic(ownerFile, input.selfClaim, { replace: true });
            if (decision.auditStale)
                await auditStaleCleanup(input.auditRoot, raced, input.paths);
            if (decision.auditForeign)
                await auditForeignReplaced(input.auditRoot, raced, input.selfClaim);
            await writeDerivedDiscoveryFiles(input.paths, input.selfClaim);
            return { ok: true, claim: input.selfClaim };
        }
        throw error;
    }
    await writeDerivedDiscoveryFiles(input.paths, input.selfClaim);
    return { ok: true, claim: input.selfClaim };
}
async function classifyIncumbent(input) {
    if (discoveryClaimIdentityMatches(input.incumbent, input.selfClaim.pid, input.selfClaim.startedAt ?? null) &&
        input.incumbent.port === input.selfClaim.port) {
        return { action: "return", result: { ok: true, claim: input.incumbent } };
    }
    const alive = input.isPidAlive(input.incumbent.pid);
    if (!alive) {
        return { action: "replace", auditStale: true };
    }
    let hello;
    try {
        hello = await input.probe(input.incumbent.port);
    }
    catch (error) {
        const refused = error?.code === "ECONNREFUSED";
        if (refused) {
            return { action: "replace", auditStale: true };
        }
        return {
            action: "return",
            result: { ok: false, reason: "incumbent_busy", incumbent: input.incumbent },
        };
    }
    const reported = hello.metadata?.stateRoot;
    const normalizedIncumbentRoot = typeof reported === "string" && reported.length > 0
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
    if (input.incumbent.stateRoot === "" &&
        (typeof reported !== "string" || reported.length === 0)) {
        return {
            action: "return",
            result: { ok: false, reason: "incumbent", winner: input.incumbent },
        };
    }
    return { action: "replace", auditForeign: true };
}
async function readLegacyIncumbent(paths) {
    const pid = await readPidFile(paths.pidFile);
    const port = await readPortFile(paths.portFile);
    if (pid === undefined || port === undefined)
        return undefined;
    return {
        pid,
        port,
        stateRoot: "",
        startedAt: null,
        protocolVersion: IPC_PROTOCOL_VERSION,
    };
}
async function writeOwnerClaimAtomic(ownerFile, claim, options) {
    const payload = `${JSON.stringify(claim)}\n`;
    const tempFile = `${ownerFile}.tmp.${claim.pid}.${Date.now()}`;
    await writeFile(tempFile, payload, "utf8");
    if (!options.replace) {
        try {
            const handle = await open(ownerFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
            await handle.writeFile(payload, "utf8");
            await handle.close();
            await rm(tempFile, { force: true });
            return;
        }
        catch (error) {
            await rm(tempFile, { force: true });
            if (!isAlreadyExistsError(error))
                throw error;
            // Lost race: caller re-enters via read path on retry.
            throw error;
        }
    }
    await rename(tempFile, ownerFile);
}
async function writeDerivedDiscoveryFiles(paths, claim) {
    await writeFile(paths.pidFile, `${claim.pid}\n`, "utf8");
    const portTemp = `${paths.portFile}.tmp.${claim.pid}.${Date.now()}`;
    await writeFile(portTemp, `${claim.port}\n`, "utf8");
    await rename(portTemp, paths.portFile);
}
async function auditStaleCleanup(stateRoot, stale, paths) {
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
async function auditForeignReplaced(stateRoot, previous, current) {
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
export async function writeDaemonDiscoveryFiles(input) {
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
        throw new Error(`agents-comm-bus daemon pid ${result.incumbent.pid} is alive but unresponsive; ` +
            `refusing to overwrite discovery with port ${input.port}`);
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
        return error.code !== "ESRCH";
    }
}
function isAlreadyExistsError(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
// Test-only: non-atomic owner write to verify concurrency tests catch torn reads.
export async function __unsafeWriteOwnerClaimForMutationTests(discoveryRoot, claim) {
    await writeFile(discoveryOwnerFile(discoveryRoot), `${JSON.stringify(claim)}\n`, "utf8");
}
//# sourceMappingURL=discovery-claim.js.map