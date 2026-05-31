import { mkdir } from "node:fs/promises";

import {
  type AccountId,
  type AccountRegistration,
  type CommAdapter,
  type CommId,
  type SessionId,
  type Storage,
} from "agents-comm-bus-core";
import { DAEMON_VERSION } from "./config.js";
import { resolveStatePaths } from "./paths.js";
import { startIpcServer } from "./ipc/server.js";
import type { IpcRequest } from "./ipc/protocol.js";
import { writeDaemonDiscoveryFiles } from "./bootstrap/ensure-daemon.js";
import { startDaemonPidWatchdog } from "./bootstrap/pid-watchdog.js";
import { MessageBus } from "./bus.js";
import { openSqliteStorage } from "./storage/sqlite.js";
import { JsonlTranscriptStore } from "./storage/transcripts.js";
import { JsonlAuditStore } from "./storage/audit.js";
import { ContentAddressedBlobStore } from "./storage/blobs.js";
import type { AgentBridge, AgentBridgeFactory } from "./runtime/agent-bridge.js";
import type { CommAdapterFactory } from "./runtime/comm-factory.js";
import type { IpcMethodHandler } from "./runtime/ipc-method.js";
import type { PendingInboundEntry } from "./runtime/pending-inbound.js";

export type {
  AgentBridge,
  AgentBridgeFactory,
  AgentBridgeContext,
} from "./runtime/agent-bridge.js";
export type {
  CommAdapterFactory,
  CommAdapterFactoryEnv,
  CommIpcDeps,
} from "./runtime/comm-factory.js";
export type { IpcMethodHandler } from "./runtime/ipc-method.js";
export type { PendingInboundEntry } from "./runtime/pending-inbound.js";

export interface RunDaemonOptions {
  /**
   * Comm-side factories to load adapters from. Each factory is consulted
   * against any matching `account_registrations` rows; missing creds skip
   * the row with a warning.
   */
  commAdapterFactories: CommAdapterFactory[];
  /**
   * Agent-side bridge factories. Each bridge is constructed with shared
   * runtime deps (storage, bus, pendingInbound) and asked to `attach` to
   * the live comm adapters before the bus starts.
   */
  agentBridgeFactories: AgentBridgeFactory[];
  /** Override `process.argv.slice(2)`. */
  argv?: string[];
  /** Override `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override the path resolver's state-root selection. */
  stateRoot?: string;
}

/**
 * Generic daemon entry point. Knows nothing about specific agents or
 * comms — adapter wiring is supplied by the composition root.
 *
 * Layout:
 *   1. Resolve filesystem paths, open storage / transcript / audit / blob stores.
 *   2. For each comm factory, load matching `account_registrations`, resolve
 *      credentials, instantiate one adapter per registration, dedup by bot id,
 *      fall back to `factory.fallbackFromEnv` when no rows are registered.
 *   3. Construct the bus.
 *   4. For each agent bridge factory, construct the bridge with shared deps
 *      and ask it to attach to the live comms.
 *   5. Index IPC methods (bridges contribute `claude_*`-style methods;
 *      comm factories contribute their MCP-tool surface) into a single
 *      dispatcher map.
 *   6. Start the IPC server, write the discovery files, start the bus
 *      (which starts the comm pollers).
 */
export async function runDaemon(options: RunDaemonOptions): Promise<void> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;

  const paths = resolveStatePaths({ stateRoot: options.stateRoot ?? env.AGENTS_COMM_BUS_STATE_ROOT });
  if (argv.includes("--print-paths")) {
    console.log(JSON.stringify(paths, null, 2));
    return;
  }

  await mkdir(paths.root, { recursive: true });
  const storage = await openSqliteStorage(paths.database);
  const transcripts = new JsonlTranscriptStore(paths.root);
  const audit = new JsonlAuditStore(paths.root);
  const blobs = new ContentAddressedBlobStore(paths.root);
  const pendingInbound: PendingInboundEntry[] = [];

  const comms = await loadCommAdapters({
    factories: options.commAdapterFactories,
    storage,
    env,
    blobs,
    stateRoot: paths.root,
  });

  const bus = new MessageBus({
    project: process.cwd(),
    storage,
    transcripts,
    audit,
    blobs,
    comms,
  });

  const bridges: AgentBridge[] = options.agentBridgeFactories.map((factory) =>
    factory.create({ storage, bus, audit, pendingInbound }),
  );

  bus.setDispatchSink({
    enqueueInbound: async (message, conversation) => {
      pendingInbound.push({ message, conversation });
      if (pendingInbound.length > 100) {
        pendingInbound.splice(0, pendingInbound.length - 100);
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
      for (const bridge of bridges) {
        if (bridge.onInboundConversation) {
          try {
            await audit.append({
              timestamp: Date.now(),
              kind: "inbound_dispatch_bridge_invoked",
              agent: bridge.agentId,
              conversation_id: conversation.conversation_id,
              detail: {
                conversation_agent: conversation.agent,
                platform_message_id: message.platform_message_id,
                message_id: message.message_id,
                queue_length: pendingInbound.length,
              },
            });
            await bridge.onInboundConversation(conversation);
            await audit.append({
              timestamp: Date.now(),
              kind: "inbound_dispatch_bridge_completed",
              agent: bridge.agentId,
              conversation_id: conversation.conversation_id,
              detail: {
                conversation_agent: conversation.agent,
                platform_message_id: message.platform_message_id,
                message_id: message.message_id,
                queue_length: pendingInbound.length,
              },
            });
          } catch (error) {
            await audit.append({
              timestamp: Date.now(),
              kind: "inbound_dispatch_bridge_failed",
              agent: bridge.agentId,
              conversation_id: conversation.conversation_id,
              detail: {
                conversation_agent: conversation.agent,
                platform_message_id: message.platform_message_id,
                message_id: message.message_id,
                error: error instanceof Error ? error.message : String(error),
              },
            });
            console.error(
              `agents-comm-bus: bridge ${bridge.agentId} onInboundConversation failed: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    },
  });

  for (const bridge of bridges) {
    bridge.attach(comms);
  }

  const ipcMethods = new Map<string, IpcMethodHandler>();
  for (const factory of options.commAdapterFactories) {
    if (factory.ipcMethods) {
      for (const [method, handler] of factory.ipcMethods({ bus, storage, pendingInbound })) {
        ipcMethods.set(method, handler);
      }
    }
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
    return drainPendingInbound(pendingInbound, { ...base, ownedAccountKeys });
  });
  const bridgesByMethod = new Map<string, AgentBridge>();
  for (const bridge of bridges) {
    for (const method of bridge.ipcMethods) {
      bridgesByMethod.set(method, bridge);
    }
  }

  const reloadRegistrations = (reloadOptions?: ReloadOptions): Promise<ReloadSummary> =>
    reloadAdapters({
      factories: options.commAdapterFactories,
      bridges,
      bus,
      storage,
      env,
      blobs,
      stateRoot: paths.root,
      options: reloadOptions,
    });

  const server = await startIpcServer({
    metadata: { stateRoot: paths.root },
    onRequest: async (request, socket) =>
      dispatchIpc(request, {
        bus,
        ipcMethods,
        bridgesByMethod,
        commAdapterFactories: options.commAdapterFactories,
        env,
        socket,
        reloadRegistrations,
      }),
  });
  try {
    await writeDaemonDiscoveryFiles({ stateRoot: paths.root, port: server.port });
  } catch (error) {
    await server.close();
    throw error;
  }
  await bus.start();
  startDaemonPidWatchdog({
    stateRoot: paths.root,
    pidFile: paths.pidFile,
    port: server.port,
    audit,
    stopDaemon: async () => {
      await bestEffortWithTimeout(
        () => bus.stop(),
        5_000,
        "stop comm adapters during daemon retirement",
      );
      await bestEffortWithTimeout(
        () => server.close(),
        1_000,
        "close IPC server during daemon retirement",
      );
    },
  });

  console.error(`agents-comm-bus ${DAEMON_VERSION} listening on ${server.url}`);
}

async function bestEffortWithTimeout(
  action: () => Promise<void>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      action(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
    if (timedOut) {
      console.error(`agents-comm-bus: timed out trying to ${label}`);
    }
  } catch (error) {
    console.error(
      `agents-comm-bus: failed to ${label}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function loadCommAdapters(input: {
  factories: CommAdapterFactory[];
  storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  env: NodeJS.ProcessEnv;
  blobs: ContentAddressedBlobStore;
  stateRoot: string;
}): Promise<CommAdapter[]> {
  const comms: CommAdapter[] = [];
  const attachedBotIds = new Set<string>();

  for (const factory of input.factories) {
    const registrations = await input.storage.listAccountRegistrations({
      comm: factory.commId,
    });
    for (const registration of registrations) {
      if (attachedBotIds.has(registration.bot_user_id)) continue;
      const adapter = await createAdapterFromRegistration({
        factory,
        registration,
        env: input.env,
        blobs: input.blobs,
        stateRoot: input.stateRoot,
        storage: input.storage,
      });
      if (!adapter) continue;
      comms.push(adapter);
      attachedBotIds.add(registration.bot_user_id);
    }

    if (registrations.length === 0 && factory.fallbackFromEnv) {
      const fallback = await factory.fallbackFromEnv(input.env);
      if (fallback) {
        comms.push(factory.create(fallback.credentials, fallback.accountId, {
          blobs: input.blobs,
          stateRoot: input.stateRoot,
        }));
      }
    }
  }

  return comms;
}

async function createAdapterFromRegistration(input: {
  factory: CommAdapterFactory;
  registration: AccountRegistration;
  env: NodeJS.ProcessEnv;
  blobs: ContentAddressedBlobStore;
  stateRoot: string;
  storage?: Storage;
}): Promise<CommAdapter | null> {
  const resolved = await input.factory.resolveCredentials(input.registration, input.env, {
    storage: input.storage,
  });
  if (!resolved) {
    console.error(
      `agents-comm-bus: skipping ${input.factory.commId} account ${input.registration.account_label} ` +
        `for project ${input.registration.project} (could not resolve credentials_ref=${input.registration.credentials_ref})`,
    );
    return null;
  }
  return input.factory.create(resolved.credentials, input.registration.bot_user_id as AccountId, {
    blobs: input.blobs,
    stateRoot: input.stateRoot,
  });
}

export interface ReloadSummary {
  ok: true;
  added: Array<{ comm: CommId; account_id: AccountId }>;
  removed: Array<{ comm: CommId; account_id: AccountId }>;
  /**
   * Adapters whose registration key is unchanged but whose runtime state was
   * refreshed. Allowlist diffs update in place; credential refreshes recreate
   * the adapter so same-bot token rotation takes effect without daemon restart.
   */
  updated: Array<{ comm: CommId; account_id: AccountId; what: "allowlist" | "credentials" }>;
  skipped: Array<{ comm: CommId; account_id?: string; reason: string }>;
}

export interface ReloadOptions {
  forceCredentialRefresh?: Array<{ comm: CommId | string; accountId: AccountId | string }>;
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
export async function reloadAdapters(input: {
  factories: CommAdapterFactory[];
  bridges: AgentBridge[];
  bus: MessageBus;
  storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  env: NodeJS.ProcessEnv;
  blobs: ContentAddressedBlobStore;
  stateRoot: string;
  options?: ReloadOptions;
}): Promise<ReloadSummary> {
  const added: ReloadSummary["added"] = [];
  const removed: ReloadSummary["removed"] = [];
  const updated: ReloadSummary["updated"] = [];
  const skipped: ReloadSummary["skipped"] = [];

  type DesiredEntry = { factory: CommAdapterFactory; registration: AccountRegistration };
  const desired = new Map<string, DesiredEntry>();
  for (const factory of input.factories) {
    const regs = await input.storage.listAccountRegistrations({ comm: factory.commId });
    for (const reg of regs) {
      const key = adapterMapKey(factory.commId, reg.bot_user_id as AccountId);
      if (!desired.has(key)) desired.set(key, { factory, registration: reg });
    }
  }

  const current = new Map<string, { commId: CommId; accountId: AccountId }>();
  for (const entry of input.bus.listComms()) {
    current.set(adapterMapKey(entry.commId, entry.accountId), entry);
  }

  for (const [key, entry] of desired) {
    if (current.has(key)) continue;
    const adapter = await createAdapterFromRegistration({
      factory: entry.factory,
      registration: entry.registration,
      env: input.env,
      blobs: input.blobs,
      stateRoot: input.stateRoot,
      storage: input.storage,
    });
    if (!adapter) {
      skipped.push({
        comm: entry.registration.comm,
        account_id: entry.registration.bot_user_id,
        reason: `could not resolve credentials_ref=${entry.registration.credentials_ref}`,
      });
      continue;
    }
    try {
      input.bus.registerComm(adapter);
      for (const bridge of input.bridges) {
        bridge.attachComm?.(adapter);
      }
      await adapter.start();
      added.push({
        comm: entry.registration.comm,
        account_id: entry.registration.bot_user_id as AccountId,
      });
    } catch (error) {
      input.bus.unregisterComm(
        entry.registration.comm,
        entry.registration.bot_user_id as AccountId,
      );
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `agents-comm-bus: failed to start ${entry.registration.comm}/${entry.registration.bot_user_id} ` +
          `on reload: ${reason}`,
      );
      skipped.push({
        comm: entry.registration.comm,
        account_id: entry.registration.bot_user_id,
        reason: `failed to start adapter: ${reason}`,
      });
    }
  }

  for (const [key, entry] of current) {
    if (desired.has(key)) continue;
    const adapter = input.bus.unregisterComm(entry.commId, entry.accountId);
    for (const bridge of input.bridges) {
      bridge.detachComm?.(entry.commId, entry.accountId);
    }
    if (adapter) {
      try {
        await adapter.stop();
      } catch (error) {
        console.error(
          `agents-comm-bus: failed to stop ${entry.commId}/${entry.accountId} on reload: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    removed.push({ comm: entry.commId, account_id: entry.accountId });
  }

  const forceCredentialRefresh = new Set(
    input.options?.forceCredentialRefresh?.map((target) =>
      adapterMapKey(target.comm as CommId, target.accountId as AccountId),
    ) ?? [],
  );

  // Third branch: registrations that exist in both `desired` and `current`.
  // The (commId, accountId) is unchanged, so no attach/detach needed — but
  // the source of the adapter's allowlist (env CSV ∪ .json file userId ∪ DB
  // allowlist_global/per_bot) may have shifted. Re-resolve credentials and,
  // if the resulting allowedUserIds differs from the live adapter's current
  // set, refresh it in place via `updateAllowedSenderIds`. This is the path
  // that lets `agents-comm allowlist add` take effect without restarting
  // the daemon or recreating the adapter (which would interrupt polling).
  for (const [key, entry] of desired) {
    if (!current.has(key)) continue;
    if (forceCredentialRefresh.has(key)) {
      const adapter = await createAdapterFromRegistration({
        factory: entry.factory,
        registration: entry.registration,
        env: input.env,
        blobs: input.blobs,
        stateRoot: input.stateRoot,
        storage: input.storage,
      });
      if (!adapter) {
        skipped.push({
          comm: entry.registration.comm,
          account_id: entry.registration.bot_user_id,
          reason: `could not re-resolve credentials_ref=${entry.registration.credentials_ref}`,
        });
        continue;
      }

      const oldAdapter = input.bus.unregisterComm(
        entry.registration.comm,
        entry.registration.bot_user_id as AccountId,
      );
      for (const bridge of input.bridges) {
        bridge.detachComm?.(
          entry.registration.comm,
          entry.registration.bot_user_id as AccountId,
        );
      }
      if (oldAdapter) {
        try {
          await oldAdapter.stop();
        } catch (error) {
          console.error(
            `agents-comm-bus: failed to stop ${entry.registration.comm}/${entry.registration.bot_user_id} ` +
              `for credential refresh: ${error instanceof Error ? error.message : String(error)}`,
          );
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
          account_id: entry.registration.bot_user_id as AccountId,
          what: "credentials",
        });
      } catch (error) {
        input.bus.unregisterComm(
          entry.registration.comm,
          entry.registration.bot_user_id as AccountId,
        );
        for (const bridge of input.bridges) {
          bridge.detachComm?.(
            entry.registration.comm,
            entry.registration.bot_user_id as AccountId,
          );
        }
        const reason = error instanceof Error ? error.message : String(error);
        console.error(
          `agents-comm-bus: failed to restart ${entry.registration.comm}/${entry.registration.bot_user_id} ` +
            `on credential refresh: ${reason}`,
        );
        if (oldAdapter) {
          try {
            input.bus.registerComm(oldAdapter);
            for (const bridge of input.bridges) {
              bridge.attachComm?.(oldAdapter);
            }
            await oldAdapter.start();
          } catch (restoreError) {
            console.error(
              `agents-comm-bus: failed to restore previous ${entry.registration.comm}/` +
                `${entry.registration.bot_user_id} adapter after credential refresh failure: ` +
                `${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
            );
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

    const liveAdapter = input.bus.getComm(
      entry.registration.comm,
      entry.registration.bot_user_id as AccountId,
    );
    if (!liveAdapter || !liveAdapter.updateAllowedSenderIds) continue;
    const resolved = await entry.factory.resolveCredentials(entry.registration, input.env, {
      storage: input.storage,
    });
    if (!resolved) {
      // Symmetric with the attach branch: surface credential resolution
      // failures so a credentials_ref that broke between attach time and
      // reload time doesn't disappear silently. The live adapter keeps
      // running on its prior allowlist (no destructive action), but the
      // reload IPC caller learns that this registration's runtime state
      // is now stale.
      skipped.push({
        comm: entry.registration.comm,
        account_id: entry.registration.bot_user_id,
        reason: `could not re-resolve credentials_ref=${entry.registration.credentials_ref}`,
      });
      continue;
    }
    const newIds = Array.isArray(resolved.credentials.allowedUserIds)
      ? (resolved.credentials.allowedUserIds as string[]).map(String)
      : [];
    const oldIds = liveAdapter.allowedSenderIds ?? [];
    if (sameStringSet(oldIds, newIds)) continue;
    liveAdapter.updateAllowedSenderIds(newIds);
    updated.push({
      comm: entry.registration.comm,
      account_id: entry.registration.bot_user_id as AccountId,
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
export function drainPendingInbound(
  queue: PendingInboundEntry[],
  params: Record<string, unknown> | undefined = {},
): PendingInboundEntry[] {
  const raw = params?.comm;
  const commFilter = typeof raw === "string" && raw.length > 0 ? raw : null;
  const owned = params?.ownedAccountKeys instanceof Set
    ? (params.ownedAccountKeys as Set<string>)
    : null;
  if (!commFilter && owned === null) {
    return queue.splice(0);
  }
  const drained: PendingInboundEntry[] = [];
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const entry = queue[i];
    if (commFilter && entry.message.chat.comm !== commFilter) continue;
    if (owned !== null && !owned.has(pendingAccountKey(entry))) continue;
    drained.unshift(entry);
    queue.splice(i, 1);
  }
  return drained;
}

function pendingAccountKey(entry: PendingInboundEntry): string {
  return `${entry.message.chat.comm}:${entry.message.chat.account}`;
}

/**
 * Resolve the bot accounts a calling session owns, as `${comm}:${account}`
 * keys, for scoping a generic drain. Mirrors the per-agent ownership the
 * bridges use. Returns undefined when there is no session (legacy caller â†’
 * fall back to comm/global), and an empty Set when the session is unknown
 * (scope to nothing rather than global-wipe).
 */
async function resolveOwnedAccountKeys(
  storage: Storage,
  session: unknown,
): Promise<Set<string> | undefined> {
  if (typeof session !== "string" || session.length === 0) return undefined;
  const sess = await storage.getSession(session as SessionId);
  if (!sess) return new Set<string>();
  const regs = await storage.listAccountRegistrations({ agent: sess.agent });
  return new Set(regs.map((reg) => `${reg.comm}:${reg.bot_user_id}`));
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const x of b) {
    if (!set.has(x)) return false;
  }
  return true;
}

function adapterMapKey(commId: CommId, accountId: AccountId | string): string {
  return `${commId}:${accountId}`;
}

async function dispatchIpc(
  request: IpcRequest,
  context: {
    bus: MessageBus;
    ipcMethods: Map<string, IpcMethodHandler>;
    bridgesByMethod: Map<string, AgentBridge>;
    commAdapterFactories: CommAdapterFactory[];
    env: NodeJS.ProcessEnv;
    socket?: { once(event: "close", handler: () => void): void };
    reloadRegistrations: (options?: ReloadOptions) => Promise<ReloadSummary>;
  },
): Promise<unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (request.method === "list_conversations") {
    return context.bus.listConversations({
      comm: params.comm as CommId | undefined,
      limit: typeof params.limit === "number" ? params.limit : 25,
    });
  }

  if (request.method === "reload_registrations") {
    return context.reloadRegistrations(parseReloadOptions(params));
  }

  if (request.method === "probe_comm_identity") {
    return probeCommIdentity(params, context.commAdapterFactories, context.env);
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

async function probeCommIdentity(
  params: Record<string, unknown>,
  factories: CommAdapterFactory[],
  env: NodeJS.ProcessEnv,
): Promise<{ comm: CommId; account_id: string; account_username?: string | null }> {
  const comm = typeof params.comm === "string" ? params.comm as CommId : null;
  if (!comm) {
    throw new Error("probe_comm_identity requires params.comm");
  }
  const credentials =
    params.credentials && typeof params.credentials === "object"
      ? params.credentials as Record<string, unknown>
      : null;
  if (!credentials) {
    throw new Error("probe_comm_identity requires params.credentials");
  }
  const factory = factories.find((candidate) => candidate.commId === comm);
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

function parseReloadOptions(params: Record<string, unknown>): ReloadOptions {
  const raw = params.forceCredentialRefresh;
  if (!Array.isArray(raw)) return {};
  const forceCredentialRefresh = raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (record.comm == null || record.accountId == null) return [];
    return [{
      comm: String(record.comm),
      accountId: String(record.accountId),
    }];
  });
  return { forceCredentialRefresh };
}
