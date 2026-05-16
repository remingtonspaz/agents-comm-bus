import { mkdir } from "node:fs/promises";

import {
  type CommAdapter,
  type CommId,
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

  const server = await startIpcServer({
    metadata: { stateRoot: paths.root },
    onRequest: async (request, socket) =>
      dispatchIpc(request, { bus, ipcMethods, bridgesByMethod, socket }),
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
}): Promise<CommAdapter[]> {
  const comms: CommAdapter[] = [];
  const attachedBotIds = new Set<string>();

  for (const factory of input.factories) {
    const registrations = await input.storage.listAccountRegistrations({
      comm: factory.commId,
    });
    for (const registration of registrations) {
      if (attachedBotIds.has(registration.bot_user_id)) continue;
      const resolved = await factory.resolveCredentials(registration, input.env);
      if (!resolved) {
        console.error(
          `agents-comm-bus: skipping ${factory.commId} account ${registration.account_label} ` +
            `for project ${registration.project} (could not resolve credentials_ref=${registration.credentials_ref})`,
        );
        continue;
      }
      comms.push(factory.create(resolved.credentials));
      attachedBotIds.add(registration.bot_user_id);
    }

    if (registrations.length === 0 && factory.fallbackFromEnv) {
      const fallback = factory.fallbackFromEnv(input.env);
      if (fallback) {
        comms.push(factory.create(fallback.credentials));
      }
    }
  }

  return comms;
}

async function dispatchIpc(
  request: IpcRequest,
  context: {
    bus: MessageBus;
    ipcMethods: Map<string, IpcMethodHandler>;
    bridgesByMethod: Map<string, AgentBridge>;
    socket?: { once(event: "close", handler: () => void): void };
  },
): Promise<unknown> {
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (request.method === "list_conversations") {
    return context.bus.listConversations({
      comm: params.comm as CommId | undefined,
      limit: typeof params.limit === "number" ? params.limit : 25,
    });
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
