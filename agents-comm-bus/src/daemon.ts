import { mkdir } from "node:fs/promises";

import {
  type AccountId,
  type AccountRegistration,
  type CommAdapter,
  type CommId,
  type Storage,
} from "../../agents-comm-bus-core/dist/index.js";
import { DAEMON_VERSION } from "./config.js";
import { resolveStatePaths } from "./paths.js";
import { startIpcServer } from "./ipc/server.js";
import type { IpcRequest } from "./ipc/protocol.js";
import { writeDaemonDiscoveryFiles } from "./bootstrap/ensure-daemon.js";
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
    factory.create({ storage, bus, pendingInbound }),
  );

  bus.setDispatchSink({
    enqueueInbound: async (message, conversation) => {
      pendingInbound.push({ message, conversation });
      if (pendingInbound.length > 100) {
        pendingInbound.splice(0, pendingInbound.length - 100);
      }
      for (const bridge of bridges) {
        if (bridge.onInboundConversation) {
          try {
            await bridge.onInboundConversation(conversation);
          } catch (error) {
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
  const bridgesByMethod = new Map<string, AgentBridge>();
  for (const bridge of bridges) {
    for (const method of bridge.ipcMethods) {
      bridgesByMethod.set(method, bridge);
    }
  }

  const reloadRegistrations = (): Promise<ReloadSummary> =>
    reloadAdapters({
      factories: options.commAdapterFactories,
      bridges,
      bus,
      storage,
      env,
      blobs,
      stateRoot: paths.root,
    });

  const server = await startIpcServer({
    metadata: { stateRoot: paths.root },
    onRequest: async (request, socket) =>
      dispatchIpc(request, {
        bus,
        ipcMethods,
        bridgesByMethod,
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

  console.error(`agents-comm-bus ${DAEMON_VERSION} listening on ${server.url}`);
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
  skipped: Array<{ comm: CommId; account_id?: string; reason: string }>;
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
async function reloadAdapters(input: {
  factories: CommAdapterFactory[];
  bridges: AgentBridge[];
  bus: MessageBus;
  storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  env: NodeJS.ProcessEnv;
  blobs: ContentAddressedBlobStore;
  stateRoot: string;
}): Promise<ReloadSummary> {
  const added: ReloadSummary["added"] = [];
  const removed: ReloadSummary["removed"] = [];
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

  if (added.length > 0 || removed.length > 0) {
    for (const bridge of input.bridges) {
      bridge.invalidateRegistrationCaches?.();
    }
  }

  return { ok: true, added, removed, skipped };
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
    socket?: { once(event: "close", handler: () => void): void };
    reloadRegistrations: () => Promise<ReloadSummary>;
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
    return context.reloadRegistrations();
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
