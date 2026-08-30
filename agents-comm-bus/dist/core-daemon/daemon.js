import { mkdir } from "node:fs/promises";
import os from "node:os";
import { DAEMON_VERSION } from "./config.js";
import { normalizeProjectPath } from "./project-path.js";
import { resolveDiscoveryPaths, resolveStatePaths } from "./paths.js";
import { CommLeaseArbiter, inferAuthorityRank, } from "./runtime/comm-lease.js";
import { handleInspectInboundTarget } from "./runtime/inspect-inbound-target.js";
import { startIpcServer } from "./ipc/server.js";
import { writeDaemonDiscoveryFiles } from "./bootstrap/ensure-daemon.js";
import { runBootScopeRestore } from "./bootstrap/boot-scope-restore.js";
import { IDLE_NO_OWNED_RESOURCES_REASON, retireDaemon, } from "./bootstrap/daemon-retirement.js";
import { startDaemonPidWatchdog } from "./bootstrap/pid-watchdog.js";
import { MessageBus } from "./bus.js";
import { openSqliteStorage } from "./storage/sqlite.js";
import { JsonlTranscriptStore } from "./storage/transcripts.js";
import { JsonlAuditStore } from "./storage/audit.js";
import { ContentAddressedBlobStore } from "./storage/blobs.js";
import { addAdapterForRegistration, adapterMapKey, appendCredentialResolutionFailedAudit, createAdapterFromRegistration, logInvalidCredentialResolution, removeLiveAdapter, unresolvedCredentialsReason, } from "./runtime/comm-adapter-lifecycle.js";
import { ensureRegistrationById, ensureRegistrationForAccount, reconcileEagerRegistrations, } from "./runtime/ensure-registration.js";
import { createEagerActivationRetryScheduler, } from "./runtime/eager-activation-retry.js";
import { createCommFactoryRegistry } from "./runtime/comm-factory-registry.js";
import { registerCommIpcMethods } from "./runtime/register-comm-ipc-methods.js";
import { dispatchInboundToBridges } from "./runtime/dispatch-inbound.js";
import { startIdleReaper } from "./runtime/daemon-idle-reaper.js";
import { startSessionEndSweep } from "./runtime/session-end-sweep.js";
import { runCommLeaseSweep, startCommLeaseSweep } from "./runtime/comm-lease-sweep.js";
import { scopeKey } from "./runtime/scope-release-reconcile.js";
import { createSessionOwnerLiveness } from "./runtime/session-owner-liveness.js";
import { deliveryRowFromEntry, drainAndAcknowledgePendingInbound, durableInboundKey, queueHasDurableKey, rehydratePendingInboundForScope, selectPendingInboundForDrain, } from "./runtime/durable-inbound.js";
import { filterRegistrationsByScope, } from "./session-label-scope.js";
/**
 * Generic daemon entry point. Knows nothing about specific agents or
 * comms — adapter wiring is supplied by the composition root.
 *
 * Layout:
 *   1. Resolve filesystem paths, open storage / transcript / audit / blob stores.
 *   2. For each comm factory, load matching `account_registrations`, resolve
 *      credentials, instantiate one adapter per registration, dedup by bot id.
 *   3. Construct the bus.
 *   4. For each agent bridge factory, construct the bridge with shared deps
 *      and ask it to attach to the live comms.
 *   5. Index IPC methods (bridges contribute `claude_*`-style methods;
 *      comm factories contribute their MCP-tool surface) into a single
 *      dispatcher map.
 *   6. Start the IPC server, write the discovery files, start the bus
 *      (which starts the comm pollers).
 */
export async function runDaemon(options) {
    const argv = options.argv ?? process.argv.slice(2);
    const env = options.env ?? process.env;
    const paths = resolveStatePaths({ stateRoot: options.stateRoot ?? env.AGENTS_COMM_BUS_STATE_ROOT });
    const discoveryPaths = resolveDiscoveryPaths({
        stateRoot: paths.root,
        discoveryRoot: options.discoveryRoot ?? env.AGENTS_COMM_BUS_DISCOVERY_ROOT,
    });
    if (argv.includes("--print-paths")) {
        console.log(JSON.stringify({ ...paths, discovery: discoveryPaths }, null, 2));
        return;
    }
    await mkdir(paths.root, { recursive: true });
    await mkdir(discoveryPaths.root, { recursive: true });
    const storage = await openSqliteStorage(paths.database);
    const transcripts = new JsonlTranscriptStore(paths.root);
    const audit = new JsonlAuditStore(paths.root);
    const blobs = new ContentAddressedBlobStore(paths.root);
    const pendingInbound = [];
    const sessionOwnerIsLive = createSessionOwnerLiveness();
    const scopeReconcileState = { zeroLiveSince: new Map() };
    let requestScopeReconcile;
    // AGE-35: cross-checkout single-consumer ownership lease. A stray daemon from
    // another git checkout/worktree must not be able to poll the same Telegram bot
    // as the canonical daemon (two getUpdates consumers → 409 outage). Build ONE
    // arbiter with this daemon's self-identity; it gates every adapter that
    // declares an `exclusiveResource()`. The lease lives at a FIXED homedir path so
    // every daemon contends regardless of its state root.
    const daemonBin = env.AGENTS_COMM_BUS_BIN ?? process.argv[1] ?? null;
    const { authorityRank, checkoutRoot } = inferAuthorityRank({
        env,
        daemonBin,
        cwd: process.cwd(),
    });
    // The IPC server bumps this on each served request; the lease uses it as the
    // same-rank recency tiebreaker (a quieter same-rank holder can be superseded).
    const ipcActivity = { value: Date.now() };
    const leaseArbiter = new CommLeaseArbiter({
        self: {
            pid: process.pid,
            stateRoot: paths.root,
            checkoutRoot,
            daemonBin,
            daemonVersion: DAEMON_VERSION,
            authorityRank,
        },
        lastIpcServedAt: () => ipcActivity.value,
        onAudit: (event) => {
            void audit
                .append({
                timestamp: Date.now(),
                kind: event.kind,
                detail: { comm_id: event.comm_id, resource_id: event.resource_id, ...event.detail },
            })
                .catch(() => { });
        },
    });
    // Startup banner: make the contending daemon's identity unmistakable in logs.
    console.error(`agents-comm-bus ${DAEMON_VERSION} starting: ` +
        `stateRoot=${paths.root} discoveryRoot=${discoveryPaths.root} ` +
        `checkoutRoot=${checkoutRoot ?? "?"} ` +
        `daemonBin=${daemonBin ?? "?"} authorityRank=${authorityRank} pid=${process.pid} ` +
        `home=${os.homedir()}`);
    // AGE-38: lazy, session-triggered comm-adapter instantiation. The daemon no
    // longer eager-loads every registered bot at startup (which made any daemon
    // greedily reclaim every bot's lease across all projects — e.g. a main-dev
    // daemon stealing every prod bot). Instead it boots with ZERO adapters and
    // brings up only the bots a `(project, agent)` session needs, via
    // `ensureCommsForSession` on register (below). A zero-adapter daemon is a
    // valid steady state: the pid-watchdog keys on pid-file ownership, never
    // adapter count.
    const comms = [];
    const bus = new MessageBus({
        project: normalizeProjectPath(process.cwd()),
        storage,
        transcripts,
        audit,
        blobs,
        comms,
        sessionOwnerIsLive,
    });
    // AGE-38: `bridges` is filled AFTER `ensureCommsForSession` is built because
    // the closure captures the array by reference. This is safe — the only thing
    // that can invoke `ensureCommsForSession` is a register-session IPC call, and
    // the IPC server doesn't start until further below, by which point `bridges`
    // is fully populated.
    const daemonSelfIdentity = {
        discoveryRoot: discoveryPaths.root,
        checkoutRoot,
        stateRoot: paths.root,
        daemonBin,
        authorityRank,
    };
    const bridges = [];
    const inFlightAdapters = new Set();
    // AGE-38: `(agent, project)` scopes that have registered a session this
    // daemon-lifetime. Reload uses this to hot-add a bot account-add'd for a
    // project the daemon is actively serving, while keeping inactive projects
    // lazy. Not evicted yet — eviction rides with the deferred session-exit work;
    // until then a stale scope only causes a bounded re-add on `account-add` for a
    // project whose bots are usually already live anyway.
    const activeScopes = new Set();
    const ipcMethods = new Map();
    const ipcDeps = { bus, storage, pendingInbound };
    let commAdapterFactories;
    let rescanFactoriesForComm;
    if (options.loadCommAdapterFactories) {
        const registry = createCommFactoryRegistry({
            initial: options.commAdapterFactories,
            loadFactories: options.loadCommAdapterFactories,
            ipcMethods,
            ipcDeps,
        });
        commAdapterFactories = registry.factories;
        rescanFactoriesForComm = (comm) => registry.rescanFactoriesForComm(comm);
    }
    else {
        commAdapterFactories = [...options.commAdapterFactories];
        const commIdByMethod = new Map();
        for (const factory of commAdapterFactories) {
            registerCommIpcMethods(ipcMethods, factory, ipcDeps, { commIdByMethod });
        }
    }
    const buildEnsureRegistrationContext = (options) => ({
        factories: commAdapterFactories,
        rescanFactories: rescanFactoriesForComm,
        bus,
        bridges,
        storage,
        env,
        blobs,
        stateRoot: paths.root,
        leaseArbiter,
        inFlight: inFlightAdapters,
        audit,
        discoveryRoot: discoveryPaths.root,
        sessionOwnerIsLive,
        ...options,
    });
    let eagerRetry;
    const scheduleEagerRetry = (registration_id) => {
        eagerRetry?.schedule(registration_id);
    };
    eagerRetry = createEagerActivationRetryScheduler({
        storage,
        ensure: buildEnsureRegistrationContext({ scheduleEagerRetry }),
    });
    const ensureCommsForSessionWithOutcomes = async (project, agent, options) => {
        const canonicalProject = normalizeProjectPath(project);
        const accountLabelScope = options?.accountLabelScope ?? null;
        activeScopes.add(scopeKey(agent, canonicalProject, accountLabelScope));
        const { outcomes } = await ensureCommsForSession({
            project: canonicalProject,
            requestedProject: project,
            agent,
            accountLabelScope,
            agentLeaseProperties: options?.agentLeaseProperties,
            factories: commAdapterFactories,
            rescanFactories: rescanFactoriesForComm,
            bus,
            bridges,
            storage,
            env,
            blobs,
            stateRoot: paths.root,
            leaseArbiter,
            inFlight: inFlightAdapters,
            audit,
            discoveryRoot: discoveryPaths.root,
            sessionOwnerIsLive,
        });
        return outcomes;
    };
    const ensureCommsForSessionFn = async (project, agent, options) => {
        const canonicalProject = normalizeProjectPath(project);
        const outcomes = await ensureCommsForSessionWithOutcomes(project, agent, options);
        await rehydratePendingInboundForScope({
            storage,
            transcripts,
            audit,
            queue: pendingInbound,
            project: canonicalProject,
            agent,
        });
        return { rehydrated: true, outcomes };
    };
    bridges.push(...options.agentBridgeFactories.map((factory) => factory.create({
        storage,
        bus,
        audit,
        pendingInbound,
        ensureCommsForSession: ensureCommsForSessionFn,
        daemonOwner: daemonSelfIdentity,
        sessionOwnerIsLive,
        readHeldCommLease: (commId, resourceId) => leaseArbiter.readHeldCommLease(commId, resourceId),
        requestScopeReconcile: () => requestScopeReconcile?.(),
    })));
    const pendingInboundMax = 100;
    bus.setDispatchSink({
        enqueueInbound: async (message, conversation) => {
            const entry = { message, conversation };
            const enqueuedAt = Date.now();
            await storage.recordPendingInboundDelivery(deliveryRowFromEntry(entry, enqueuedAt));
            if (!queueHasDurableKey(pendingInbound, durableInboundKey(entry))) {
                pendingInbound.push(entry);
                if (pendingInbound.length > pendingInboundMax) {
                    const spillCount = pendingInbound.length - pendingInboundMax;
                    const spilled = pendingInbound.splice(0, spillCount);
                    await audit.append({
                        timestamp: Date.now(),
                        kind: "pending_inbound_overflow_spill",
                        agent: conversation.agent,
                        conversation_id: conversation.conversation_id,
                        detail: {
                            spilled_count: spillCount,
                            queue_length_before: pendingInbound.length + spillCount,
                            queue_length_after: pendingInbound.length,
                            spilled_keys: spilled.map((spilledEntry) => durableInboundKey(spilledEntry)),
                        },
                    });
                }
            }
            await audit.append({
                timestamp: Date.now(),
                kind: "inbound_dispatch_enqueued",
                agent: conversation.agent,
                conversation_id: conversation.conversation_id,
                detail: {
                    comm: message.chat.comm,
                    account: message.chat.account,
                    account_label: conversation.account_label,
                    platform_message_id: message.platform_message_id,
                    message_id: message.message_id,
                    queue_length: pendingInbound.length,
                },
            });
            // AGE-94: central ownership default-deny lives in dispatchInboundToBridges
            // (extracted so the invariant is unit-testable). Only the bridge whose
            // agentId matches conversation.agent is invoked or audited.
            await dispatchInboundToBridges(bridges, conversation, message, audit, pendingInbound);
        },
    });
    for (const bridge of bridges) {
        bridge.attach(comms);
    }
    // Generic drain of the shared pendingInbound queue. Used by the MCP shim's
    // `comm_check_messages` tool so the shim doesn't have to know any per-comm
    // IPC method names.
    ipcMethods.set("drain_pending_inbound", async (params) => {
        const base = params ?? {};
        // Scope the drain to the calling session's owned bot accounts so one
        // agent's `comm_check_messages` cannot cannibalize another agent's pending
        // inbound (Claude + Codex share comm="telegram" with different bots).
        const ownedAccountKeys = await resolveOwnedAccountKeys(storage, base.session);
        return drainAndAcknowledgePendingInbound(storage, pendingInbound, {
            ...base,
            ownedAccountKeys,
        });
    });
    const bridgesByMethod = new Map();
    for (const bridge of bridges) {
        for (const method of bridge.ipcMethods) {
            bridgesByMethod.set(method, bridge);
        }
    }
    const reloadRegistrations = (reloadOptions) => reloadAdapters({
        factories: commAdapterFactories,
        bridges,
        bus,
        storage,
        env,
        blobs,
        stateRoot: paths.root,
        leaseArbiter,
        activeScopes,
        discoveryRoot: discoveryPaths.root,
        sessionOwnerIsLive,
        audit,
        ensureRegistrationContext: buildEnsureRegistrationContext({ scheduleEagerRetry }),
        options: reloadOptions,
    });
    const server = await startIpcServer({
        metadata: { stateRoot: paths.root },
        onRequest: async (request, socket) => {
            // AGE-35: every served IPC request is a liveness signal for the lease's
            // same-rank recency tiebreaker.
            ipcActivity.value = Date.now();
            return dispatchIpc(request, {
                bus,
                ipcMethods,
                bridgesByMethod,
                commAdapterFactories,
                rescanFactories: rescanFactoriesForComm,
                env,
                socket,
                reloadRegistrations,
                ensureCommsForSession: ensureCommsForSessionFn,
                pendingInbound,
                activeScopes,
                storage,
                bridges,
                daemonOwner: daemonSelfIdentity,
                sessionOwnerIsLive,
            });
        },
    });
    try {
        await writeDaemonDiscoveryFiles({
            stateRoot: paths.root,
            discoveryRoot: discoveryPaths.root,
            port: server.port,
        });
    }
    catch (error) {
        await server.close();
        throw error;
    }
    await bus.start();
    const collectBridgeBlockers = () => {
        const blockers = {};
        for (const bridge of bridges) {
            blockers[bridge.agentId] = bridge.getRetirementBlockers?.() ?? null;
        }
        return blockers;
    };
    let pidWatchdogHandle = null;
    let idleReaperHandle = null;
    let sessionEndSweepHandle = null;
    let commLeaseSweepHandle = null;
    const runDaemonRetirement = async (reason, recordAudit) => {
        await retireDaemon({
            reason,
            port: server.port,
            stateRoot: paths.root,
            discoveryRoot: discoveryPaths.root,
            audit: recordAudit ? audit : undefined,
            stopTimers: () => {
                pidWatchdogHandle?.stop();
                idleReaperHandle?.stop();
                sessionEndSweepHandle?.stop();
                commLeaseSweepHandle?.stop();
                eagerRetry?.stopAll();
            },
            stopBus: () => bestEffortWithTimeout(() => bus.stop(), 5_000, "stop comm adapters during daemon retirement"),
            closeIpc: () => bestEffortWithTimeout(() => server.close(), 1_000, "close IPC server during daemon retirement"),
            closeStorage: () => storage.close(),
        });
    };
    pidWatchdogHandle = startDaemonPidWatchdog({
        stateRoot: paths.root,
        discoveryRoot: discoveryPaths.root,
        pidFile: discoveryPaths.pidFile,
        port: server.port,
        audit,
        stopDaemon: async () => {
            await runDaemonRetirement("daemon_superseded", false);
        },
    });
    idleReaperHandle = startIdleReaper({
        lastIpcServedAt: () => ipcActivity.value,
        heldLeaseCount: () => leaseArbiter.heldLeaseCount(),
        liveIpcConnectionCount: () => server.getLiveConnectionCount(),
        pendingInboundLength: () => pendingInbound.length,
        inFlightAdapterCount: () => inFlightAdapters.size,
        bridgeBlockers: collectBridgeBlockers,
        retire: async () => {
            await runDaemonRetirement(IDLE_NO_OWNED_RESOURCES_REASON, true);
        },
        log: (message) => console.error(message),
    });
    sessionEndSweepHandle = startSessionEndSweep({
        storage,
        log: (message) => console.error(message),
        reconcile: {
            storage,
            bus,
            bridges,
            factories: commAdapterFactories,
            activeScopes,
            leaseArbiter,
            sessionOwnerIsLive,
            removeAdapter: removeLiveAdapter,
            state: scopeReconcileState,
            discoveryRoot: discoveryPaths.root,
        },
        reconcileState: scopeReconcileState,
    });
    requestScopeReconcile = () => sessionEndSweepHandle?.requestEarlyReconcile();
    const commLeaseSweepRecovery = {
        storage,
        activeScopes,
        ensure: buildEnsureRegistrationContext({ scheduleEagerRetry }),
        audit,
    };
    // AGE-102: reclaim orphaned comm leases before boot restore / eager reconcile.
    void (async () => {
        try {
            await runCommLeaseSweep({
                log: (message) => console.error(message),
                audit,
                recovery: commLeaseSweepRecovery,
            });
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error(`agents-comm-bus: boot comm lease sweep failed: ${reason}`);
            await audit
                .append({
                timestamp: Date.now(),
                kind: "comm_lease_sweep_failed",
                detail: { phase: "boot", reason },
            })
                .catch(() => { });
        }
        commLeaseSweepHandle = startCommLeaseSweep({
            runOnStart: false,
            log: (message) => console.error(message),
            audit,
            recovery: commLeaseSweepRecovery,
        });
    })();
    // AGE-55: async boot restore — never block daemon readiness on comm bring-up.
    void runBootScopeRestore({
        stateRoot: paths.root,
        discoveryRoot: discoveryPaths.root,
        storage,
        ensureCommsForSession: ensureCommsForSessionFn,
        audit,
    });
    // AGE-97: eager registrations reconcile after identity + IPC + discovery are live.
    void reconcileEagerRegistrations({
        storage,
        ensure: buildEnsureRegistrationContext({ scheduleEagerRetry }),
    });
    console.error(`agents-comm-bus ${DAEMON_VERSION} listening on ${server.url}`);
}
async function bestEffortWithTimeout(action, timeoutMs, label) {
    let timeout;
    let timedOut = false;
    try {
        await Promise.race([
            action(),
            new Promise((resolve) => {
                timeout = setTimeout(() => {
                    timedOut = true;
                    resolve();
                }, timeoutMs);
            }),
        ]);
        if (timedOut) {
            console.error(`agents-comm-bus: timed out trying to ${label}`);
        }
    }
    catch (error) {
        console.error(`agents-comm-bus: failed to ${label}: ` +
            `${error instanceof Error ? error.message : String(error)}`);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
export { addAdapterForRegistration } from "./runtime/comm-adapter-lifecycle.js";
/**
 * AGE-38: instantiate (and lease) only the comm adapters a `(project, agent)`
 * session needs, lazily on session entry. Uses the per-registration primitive
 * (AGE-97) for each row in the session scope — never scope-wide over-activation.
 */
export async function ensureCommsForSession(input) {
    const project = normalizeProjectPath(input.project);
    const accountLabelScope = input.accountLabelScope ?? null;
    const allRegistrations = await input.storage.listAccountRegistrations({
        project,
        agent: input.agent,
    });
    const registrations = filterRegistrationsByScope(allRegistrations, accountLabelScope);
    if (accountLabelScope && registrations.length === 0) {
        const message = `agents-comm-bus: account_label_scope ${accountLabelScope} has no matching ` +
            `account registrations for project=${project} agent=${input.agent}`;
        console.error(message);
        await input.audit
            ?.append({
            timestamp: Date.now(),
            kind: "account_label_scope_miss",
            agent: input.agent,
            detail: {
                project,
                account_label_scope: accountLabelScope,
                registration_count: allRegistrations.length,
            },
        })
            .catch(() => { });
        throw new Error(message);
    }
    if (registrations.length === 0) {
        await reportRegistrationProjectNearMiss({
            agent: input.agent,
            requestedProject: input.requestedProject ?? input.project,
            canonicalProject: project,
            storage: input.storage,
            audit: input.audit,
        });
        return { outcomes: [] };
    }
    const outcomes = [];
    for (const registration of registrations) {
        outcomes.push(await ensureRegistrationForAccount(registration, {
            factories: input.factories,
            rescanFactories: input.rescanFactories,
            bus: input.bus,
            bridges: input.bridges,
            storage: input.storage,
            env: input.env,
            blobs: input.blobs,
            stateRoot: input.stateRoot,
            leaseArbiter: input.leaseArbiter,
            inFlight: input.inFlight,
            audit: input.audit,
            agent: input.agent,
            agentLeaseProperties: input.agentLeaseProperties,
            discoveryRoot: input.discoveryRoot,
            sessionOwnerIsLive: input.sessionOwnerIsLive,
        }));
    }
    return { outcomes };
}
/**
 * Reconcile the live comm-adapter set with `account_registrations`. Called
 * from the `reload_registrations` IPC method after the CLI writes (or
 * deletes) a row. Diff is by `(commId, bot_user_id)`: rows that exist in
 * storage but not in the bus are constructed + started + attached to
 * bridges; adapters that exist in the bus but not in storage are detached
 * + stopped. Bridge registration caches are wiped at the end so the next
 * inbound drain sees the new ownership set.
 *
 * The reload is best-effort: a credential resolution failure or adapter
 * start failure surfaces in the `skipped` list and does not abort the
 * other diffs. Adapter `stop()` failures on remove are logged but do not
 * leave the bus in an inconsistent state — the adapter has already been
 * detached from the map.
 */
export async function reloadAdapters(input) {
    const added = [];
    const removed = [];
    const updated = [];
    const skipped = [];
    if (input.options?.ensureRegistrationIds && input.ensureRegistrationContext) {
        for (const registration_id of input.options.ensureRegistrationIds) {
            await ensureRegistrationById(registration_id, input.ensureRegistrationContext);
        }
    }
    const current = new Map();
    for (const entry of input.bus.listComms()) {
        current.set(adapterMapKey(entry.commId, entry.accountId), entry);
    }
    // AGE-38: the daemon no longer eager-loads, so reload must NOT add adapters for
    // rows of projects the daemon isn't serving — otherwise any CLI write firing
    // reload_registrations would silently re-introduce eager global loading across
    // all projects. A row is `desired` only if it is ALREADY live, OR its
    // `(agent, project)` scope is active (a session for it registered this
    // daemon-lifetime). That preserves cross-daemon courtesy (a dev daemon never
    // registered other projects' scopes, so it still won't grab them) while
    // keeping hot-reload for `account-add`/allowlist on a project being served.
    const desired = new Map();
    for (const factory of input.factories) {
        const regs = await input.storage.listAccountRegistrations({ comm: factory.commId });
        for (const reg of regs) {
            const key = adapterMapKey(factory.commId, reg.bot_user_id);
            const scopeActive = input.activeScopes != null &&
                isRegistrationScopeActive(reg, input.activeScopes);
            const eagerStanding = reg.activation === "eager";
            if (!current.has(key) && !scopeActive && !eagerStanding)
                continue;
            if (!desired.has(key))
                desired.set(key, { factory, registration: reg });
        }
    }
    for (const [key, entry] of desired) {
        if (current.has(key))
            continue;
        // AGE-38: hot-add via the shared add-sequence so the reload path gets the
        // same attachComm wiring + stop()/detach rollback as `ensureCommsForSession`.
        const result = await addAdapterForRegistration({
            factory: entry.factory,
            registration: entry.registration,
            bus: input.bus,
            bridges: input.bridges,
            env: input.env,
            blobs: input.blobs,
            stateRoot: input.stateRoot,
            storage: input.storage,
            leaseArbiter: input.leaseArbiter,
            discoveryRoot: input.discoveryRoot,
            sessionOwnerIsLive: input.sessionOwnerIsLive,
        });
        if (result.ok) {
            added.push({
                comm: entry.registration.comm,
                account_id: entry.registration.bot_user_id,
            });
        }
        else {
            skipped.push({
                comm: entry.registration.comm,
                account_id: entry.registration.bot_user_id,
                reason: result.reason,
            });
            if (result.resolution?.status === "invalid") {
                await appendCredentialResolutionFailedAudit(input.audit, entry.registration, entry.registration.comm, result.resolution);
            }
            else {
                await input.audit
                    ?.append({
                    timestamp: Date.now(),
                    kind: "comm_adapter_skip",
                    agent: entry.registration.agent,
                    detail: {
                        comm: entry.registration.comm,
                        account_id: entry.registration.bot_user_id,
                        account_label: entry.registration.account_label,
                        project: entry.registration.project,
                        reason: result.reason,
                        via: "reload_registrations",
                    },
                })
                    .catch(() => { });
            }
        }
    }
    for (const [key, entry] of current) {
        if (desired.has(key))
            continue;
        await removeLiveAdapter({
            bus: input.bus,
            bridges: input.bridges,
            leaseArbiter: input.leaseArbiter,
            commId: entry.commId,
            accountId: entry.accountId,
        });
        removed.push({ comm: entry.commId, account_id: entry.accountId });
    }
    const forceCredentialRefresh = new Set(input.options?.forceCredentialRefresh?.map((target) => adapterMapKey(target.comm, target.accountId)) ?? []);
    // Third branch: registrations that exist in both `desired` and `current`.
    // The (commId, accountId) is unchanged, so no attach/detach needed — but
    // the source of the adapter's allowlist (env CSV ∪ .json file userId ∪ DB
    // allowlist_global/per_bot) may have shifted. Re-resolve credentials and,
    // if the resulting allowedUserIds differs from the live adapter's current
    // set, refresh it in place via `updateAllowedSenderIds`. This is the path
    // that lets `agents-comm allowlist add` take effect without restarting
    // the daemon or recreating the adapter (which would interrupt polling).
    for (const [key, entry] of desired) {
        if (!current.has(key))
            continue;
        if (forceCredentialRefresh.has(key)) {
            const { adapter, resolution } = await createAdapterFromRegistration({
                factory: entry.factory,
                registration: entry.registration,
                env: input.env,
                blobs: input.blobs,
                stateRoot: input.stateRoot,
                storage: input.storage,
                leaseArbiter: input.leaseArbiter,
                discoveryRoot: input.discoveryRoot,
                sessionOwnerIsLive: input.sessionOwnerIsLive,
            });
            if (!adapter) {
                if (resolution.status === "invalid") {
                    logInvalidCredentialResolution(entry.registration, entry.registration.comm, resolution);
                    await appendCredentialResolutionFailedAudit(input.audit, entry.registration, entry.registration.comm, resolution);
                }
                skipped.push({
                    comm: entry.registration.comm,
                    account_id: entry.registration.bot_user_id,
                    reason: resolution.status === "invalid"
                        ? resolution.reason
                        : unresolvedCredentialsReason(entry.registration.credentials_ref, "re-resolve"),
                });
                continue;
            }
            const oldAdapter = input.bus.unregisterComm(entry.registration.comm, entry.registration.bot_user_id);
            for (const bridge of input.bridges) {
                bridge.detachComm?.(entry.registration.comm, entry.registration.bot_user_id);
            }
            if (oldAdapter) {
                try {
                    await oldAdapter.stop();
                }
                catch (error) {
                    console.error(`agents-comm-bus: failed to stop ${entry.registration.comm}/${entry.registration.bot_user_id} ` +
                        `for credential refresh: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            try {
                input.bus.registerComm(adapter);
                for (const bridge of input.bridges) {
                    bridge.attachComm?.(adapter);
                }
                await adapter.start();
                updated.push({
                    comm: entry.registration.comm,
                    account_id: entry.registration.bot_user_id,
                    what: "credentials",
                });
            }
            catch (error) {
                input.bus.unregisterComm(entry.registration.comm, entry.registration.bot_user_id);
                for (const bridge of input.bridges) {
                    bridge.detachComm?.(entry.registration.comm, entry.registration.bot_user_id);
                }
                const reason = error instanceof Error ? error.message : String(error);
                console.error(`agents-comm-bus: failed to restart ${entry.registration.comm}/${entry.registration.bot_user_id} ` +
                    `on credential refresh: ${reason}`);
                if (oldAdapter) {
                    try {
                        input.bus.registerComm(oldAdapter);
                        for (const bridge of input.bridges) {
                            bridge.attachComm?.(oldAdapter);
                        }
                        await oldAdapter.start();
                    }
                    catch (restoreError) {
                        console.error(`agents-comm-bus: failed to restore previous ${entry.registration.comm}/` +
                            `${entry.registration.bot_user_id} adapter after credential refresh failure: ` +
                            `${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
                    }
                }
                skipped.push({
                    comm: entry.registration.comm,
                    account_id: entry.registration.bot_user_id,
                    reason: `failed to refresh credentials: ${reason}`,
                });
            }
            continue;
        }
        const liveAdapter = input.bus.getComm(entry.registration.comm, entry.registration.bot_user_id);
        if (!liveAdapter || !liveAdapter.updateAllowedSenderIds)
            continue;
        const resolved = await entry.factory.resolveCredentials(entry.registration, input.env, {
            storage: input.storage,
            stateRoot: input.stateRoot,
        });
        if (resolved.status !== "ok") {
            // Symmetric with the attach branch: surface credential resolution
            // failures so a credentials_ref that broke between attach time and
            // reload time doesn't disappear silently. The live adapter keeps
            // running on its prior allowlist (no destructive action), but the
            // reload IPC caller learns that this registration's runtime state
            // is now stale.
            if (resolved.status === "invalid") {
                logInvalidCredentialResolution(entry.registration, entry.registration.comm, resolved);
                await appendCredentialResolutionFailedAudit(input.audit, entry.registration, entry.registration.comm, resolved);
            }
            skipped.push({
                comm: entry.registration.comm,
                account_id: entry.registration.bot_user_id,
                reason: resolved.status === "invalid"
                    ? resolved.reason
                    : unresolvedCredentialsReason(entry.registration.credentials_ref, "re-resolve"),
            });
            continue;
        }
        const newIds = Array.isArray(resolved.credentials.allowedUserIds)
            ? resolved.credentials.allowedUserIds.map(String)
            : [];
        const oldIds = liveAdapter.allowedSenderIds ?? [];
        if (sameStringSet(oldIds, newIds))
            continue;
        liveAdapter.updateAllowedSenderIds(newIds);
        updated.push({
            comm: entry.registration.comm,
            account_id: entry.registration.bot_user_id,
            what: "allowlist",
        });
    }
    if (added.length > 0 || removed.length > 0 || updated.some((entry) => entry.what === "credentials")) {
        for (const bridge of input.bridges) {
            bridge.invalidateRegistrationCaches?.();
        }
    }
    return { ok: true, added, removed, updated, skipped };
}
/**
 * Drain the shared `pendingInbound` queue, optionally scoped to one comm.
 *
 * When `params.comm` is a non-empty string, only entries whose
 * `message.chat.comm` matches that filter are spliced out and returned;
 * entries for other comms stay in the queue. This is the correct shape for
 * multi-comm setups — without scoped removal, a `{ comm: "matrix" }` call
 * would destructively drain ALL comms and the caller would merely filter
 * client-side, losing the other comms' pending entries as collateral.
 *
 * When `ownedAccountKeys` is supplied (a Set of `${comm}:${account}` keys),
 * the drain is additionally scoped to those accounts â€” only entries the caller
 * actually owns are removed. This is essential in a multi-bot setup where two
 * agents share a comm (Claude + Codex both on telegram with different bot
 * accounts): without account scoping a `comm_check_messages` from one agent
 * destructively drains the OTHER agent's pending inbound as collateral, so the
 * other agent's wake-driven drain then finds an empty queue and never injects
 * the message. An empty Set drains nothing.
 *
 * When neither `comm` nor `ownedAccountKeys` is supplied, the behavior is the
 * historical global drain: the entire queue is spliced (internal/legacy callers
 * without a session).
 *
 * Returned entries preserve queue order (oldest first).
 */
export function drainPendingInbound(queue, params = {}) {
    const selected = selectPendingInboundForDrain(queue, params);
    if (selected.length === 0)
        return selected;
    const keys = new Set(selected.map((entry) => durableInboundKey(entry)));
    for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (keys.has(durableInboundKey(queue[i]))) {
            queue.splice(i, 1);
        }
    }
    return selected;
}
/**
 * Resolve the bot accounts a calling session owns, as `${comm}:${account}`
 * keys, for scoping a generic drain. AGE-38: scoped to the session's
 * `(project, agent)`, not agent-wide — under lazy per-`(project, agent)`
 * instantiation a daemon can serve live sessions for multiple projects of the
 * same agent, and an agent-wide scope would let one project's session drain
 * another project's pending inbound. Returns undefined when there is no session
 * (legacy caller → fall back to comm/global), and an empty Set when the session
 * is unknown (scope to nothing rather than global-wipe).
 */
async function resolveOwnedAccountKeys(storage, session) {
    if (typeof session !== "string" || session.length === 0)
        return undefined;
    const sess = await storage.getSession(session);
    if (!sess)
        return new Set();
    const regs = filterRegistrationsByScope(await storage.listAccountRegistrations({
        project: sess.project,
        agent: sess.agent,
    }), sess.account_label_scope);
    return new Set(regs.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
}
function sameStringSet(a, b) {
    if (a.length !== b.length)
        return false;
    const set = new Set(a);
    for (const x of b) {
        if (!set.has(x))
            return false;
    }
    return true;
}
// AGE-38/AGE-72: scopeKey imported from scope-release-reconcile for active-scope keys.
function isRegistrationScopeActive(registration, activeScopes) {
    const prefix = `${registration.agent}:${normalizeProjectPath(registration.project)}:`;
    const legacyKey = `${registration.agent}:${normalizeProjectPath(registration.project)}`;
    for (const key of activeScopes) {
        if (key === legacyKey)
            return true;
        if (!key.startsWith(prefix))
            continue;
        const scopeStored = key.slice(prefix.length);
        const scope = scopeStored.length > 0 ? scopeStored : null;
        if (filterRegistrationsByScope([registration], scope).length > 0)
            return true;
    }
    return false;
}
async function reportRegistrationProjectNearMiss(input) {
    const allForAgent = await input.storage.listAccountRegistrations({ agent: input.agent });
    const nearMatchProjects = [
        ...new Set(allForAgent
            .filter((reg) => normalizeProjectPath(reg.project) === input.canonicalProject)
            .map((reg) => reg.project)),
    ];
    if (nearMatchProjects.length === 0)
        return;
    const detail = {
        agent: input.agent,
        requested_project: input.requestedProject,
        canonical_project: input.canonicalProject,
        near_match_projects: nearMatchProjects,
    };
    console.error(`agents-comm-bus: registration_project_near_miss for agent=${input.agent}: ` +
        `requested=${JSON.stringify(input.requestedProject)} ` +
        `canonical=${JSON.stringify(input.canonicalProject)} ` +
        `near_matches=${JSON.stringify(nearMatchProjects)} ` +
        `(run scripts/repair-project-paths.mjs to canonicalize stored rows)`);
    if (input.audit) {
        await input.audit
            .append({
            timestamp: Date.now(),
            kind: "registration_project_near_miss",
            detail,
        })
            .catch(() => { });
    }
}
export function handleDaemonStatus(input) {
    return {
        daemon_version: DAEMON_VERSION,
        live_adapters: input.bus.listComms().map((entry) => `${entry.commId}:${entry.accountId}`),
        pending_inbound_depth: input.pendingInbound.length,
        active_scope_count: input.activeScopes.size,
    };
}
export async function handleEnsureCommsForScope(params, ensureCommsForSession) {
    const rawProject = params.project;
    if (typeof rawProject !== "string" || rawProject.trim() === "") {
        throw new Error("ensure_comms_for_scope requires params.project");
    }
    const agent = (typeof params.agent === "string" && params.agent.trim() !== ""
        ? params.agent
        : "claude");
    const canonicalProject = normalizeProjectPath(rawProject);
    const accountLabelScope = typeof params.account_label_scope === "string" || params.account_label_scope === null
        ? params.account_label_scope
        : null;
    await ensureCommsForSession(canonicalProject, agent, { accountLabelScope });
    return { ok: true, project: canonicalProject, agent };
}
async function dispatchIpc(request, context) {
    const params = (request.params ?? {});
    if (request.method === "daemon_status") {
        return handleDaemonStatus({
            bus: context.bus,
            pendingInbound: context.pendingInbound,
            activeScopes: context.activeScopes,
        });
    }
    if (request.method === "ensure_comms_for_scope") {
        return handleEnsureCommsForScope(params, context.ensureCommsForSession);
    }
    if (request.method === "inspect_inbound_target") {
        return handleInspectInboundTarget(params, {
            storage: context.storage,
            bridges: context.bridges,
            daemonOwner: context.daemonOwner,
            sessionOwnerIsLive: context.sessionOwnerIsLive,
        });
    }
    if (request.method === "list_conversations") {
        return context.bus.listConversations({
            comm: params.comm,
            limit: typeof params.limit === "number" ? params.limit : 25,
        });
    }
    if (request.method === "reload_registrations") {
        return context.reloadRegistrations(parseReloadOptions(params));
    }
    if (request.method === "probe_comm_identity") {
        return probeCommIdentity(params, context.commAdapterFactories, context.env, context.rescanFactories);
    }
    const bridge = context.bridgesByMethod.get(request.method);
    if (bridge) {
        return bridge.handleIpcMethod(request.method, params, { socket: context.socket });
    }
    const commHandler = context.ipcMethods.get(request.method);
    if (commHandler) {
        return commHandler(params, { socket: context.socket });
    }
    throw new Error(`unknown IPC method: ${request.method}`);
}
export async function probeCommIdentity(params, factories, env, rescanFactories) {
    const comm = typeof params.comm === "string" ? params.comm : null;
    if (!comm) {
        throw new Error("probe_comm_identity requires params.comm");
    }
    const credentials = params.credentials && typeof params.credentials === "object"
        ? params.credentials
        : null;
    if (!credentials) {
        throw new Error("probe_comm_identity requires params.credentials");
    }
    let factory = factories.find((candidate) => candidate.commId === comm);
    if (!factory && rescanFactories) {
        factory = await rescanFactories(comm);
    }
    if (!factory) {
        throw new Error(`no comm adapter factory is loaded for ${comm}`);
    }
    if (!factory.probeIdentity) {
        throw new Error(`comm adapter ${comm} does not support identity probing`);
    }
    const identity = await factory.probeIdentity(credentials, env);
    return {
        comm,
        account_id: String(identity.accountId),
        account_username: identity.accountUsername ?? null,
    };
}
function parseReloadOptions(params) {
    const forceRaw = params.forceCredentialRefresh;
    const ensureRaw = params.ensureRegistrationIds;
    const options = {};
    if (Array.isArray(forceRaw)) {
        options.forceCredentialRefresh = forceRaw.flatMap((item) => {
            if (!item || typeof item !== "object")
                return [];
            const record = item;
            if (record.comm == null || record.accountId == null)
                return [];
            return [{
                    comm: String(record.comm),
                    accountId: String(record.accountId),
                }];
        });
    }
    if (Array.isArray(ensureRaw)) {
        options.ensureRegistrationIds = ensureRaw
            .filter((id) => typeof id === "string" && id.length > 0);
    }
    return options;
}
//# sourceMappingURL=daemon.js.map