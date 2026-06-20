/**
 * Daemon IPC client wrapper for the Pi extension lifetime.
 *
 * Owns a `PersistentIpcClient` from `agents-comm-bus/ipc/persistent-client`
 * (in-process WebSocket, not a sidecar). Bootstrap uses `entryEnsures` from
 * `agents-comm-bus/host-entry` (AGE-61 public export) with `fromDir` so dev
 * vs prod discovery resolves via `.agents-comm-bus-dev.json`.
 */

import { entryEnsures } from "agents-comm-bus/host-entry";
import {
  DisconnectedError,
  PersistentIpcClient,
} from "agents-comm-bus/ipc/persistent-client";
import type { EnsureDaemonOptions } from "agents-comm-bus/bootstrap/ensure-daemon";

import type { PendingInboundEntry } from "./inbound-format.js";

const CLIENT_VERSION = "pi-extension-1";

/** MVP comm set — extend here when adding Discord/Matrix/curl support. */
export const SUPPORTED_COMMS = ["telegram"] as const;

export interface PiRegisterSessionParams {
  agent: "pi";
  session: string;
  project: string;
  cwd: string;
  connection_id: string;
  host: {
    pid: number;
    label: string;
    mode: string;
    session_file: string | null;
  };
}

export interface PiDrainInboundParams {
  agent: "pi";
  session: string;
  project?: string;
  comm?: string;
  limit?: number;
}

export interface PiUnregisterSessionParams {
  agent: "pi";
  session: string;
  connection_id: string;
}

export interface CommSendMessageParams {
  comm: string;
  text: string;
  format?: "plain" | "html" | "markdown";
  target?: {
    chat_native_id: string | number;
    thread_native_id?: string | number;
    /** Concrete bot_user_id — not an account label (AGE-15). */
    account?: string | number;
  };
}

export interface CommSendAttachmentParams {
  comm: string;
  path: string;
  caption?: string;
  target?: CommSendMessageParams["target"];
}

export interface ListConversationsParams {
  comm?: string;
  limit?: number;
}

export interface PiDrainInboundResult {
  messages: PendingInboundEntry[];
}

function disconnectedMessage(): string {
  return "agents-comm-bus disconnected (reconnecting in background)";
}

function rethrowUnlessDisconnected(error: unknown): never {
  if (error instanceof DisconnectedError) {
    throw new Error(disconnectedMessage());
  }
  throw error;
}

export class PiDaemonClient {
  private client: PersistentIpcClient | null = null;
  private ensureDaemonOptions: EnsureDaemonOptions = {};
  /**
   * The Pi session id (`pi_<uuid>`), captured at `registerPiSession` and
   * injected into every subsequent request so the daemon can resolve
   * no-target sends via `bus.targetFromSession(session)` (mirrors the MCP
   * shim's `createDaemonRequester` injecting `session: sessionInUse()`).
   */
  private session: string | null = null;

  constructor(
    private readonly project: string,
    private readonly log: (message: string) => void = defaultLog,
  ) {}

  async start(): Promise<void> {
    let lastEnsured: Awaited<ReturnType<typeof entryEnsures>> | null = null;

    // TODO(age-XX): Follow-up — core should stop calling entryEnsures; per-comm
    // extensions own it. Requires comm-less entryEnsures mode (core daemon-resolution
    // only) OR core-side comm discovery. Multi-comm prod correctness depends on this.
    // See docs/research/pi/README.md § Distribution.
    for (const comm of SUPPORTED_COMMS) {
      try {
        lastEnsured = await entryEnsures({
          agent: "pi",
          comm,
          fromDir: import.meta.dirname,
          // readOnlyCentralInstall defaults to false — let the supersede fire
          // when the stamp's daemon_bundle_version > installed version.
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`entryEnsures failed for comm=${comm}: ${message}`);
      }
    }

    if (!lastEnsured) {
      throw new Error("agents-comm-bus bootstrap failed for all supported comms");
    }

    this.ensureDaemonOptions = {
      stateRoot: lastEnsured.stateRoot,
      discoveryRoot: lastEnsured.discoveryRoot,
      env: lastEnsured.env,
    };

    this.client = new PersistentIpcClient({
      clientVersion: CLIENT_VERSION,
      metadata: {
        agent: "pi",
        project: this.project,
        shimName: "pi-agents-comm",
      },
      ensureDaemonOptions: this.ensureDaemonOptions,
      onError: (error) => this.log(`ipc error: ${error.message}`),
      onDisconnected: (reason) => this.log(`ipc disconnected: ${reason}`),
      onReconnected: () => this.log("ipc reconnected"),
      log: (message) => this.log(message),
    });

    await this.client.start();
  }

  async close(): Promise<void> {
    this.client?.close();
    this.client = null;
  }

  async registerPiSession(params: PiRegisterSessionParams): Promise<unknown> {
    if (!this.client) throw new Error("PiDaemonClient not started");
    this.session = params.session;
    try {
      return await this.client.registerReplay("pi_register_session", params);
    } catch (error) {
      rethrowUnlessDisconnected(error);
    }
  }

  async unregisterPiSession(params: PiUnregisterSessionParams): Promise<unknown> {
    return this.request("pi_unregister_session", params);
  }

  async drainPiInbound(params: PiDrainInboundParams): Promise<PiDrainInboundResult> {
    if (!this.client) throw new Error("PiDaemonClient not started");
    try {
      const result = await this.client.request("pi_drain_inbound", params);
      if (result && typeof result === "object" && Array.isArray((result as PiDrainInboundResult).messages)) {
        return result as PiDrainInboundResult;
      }
      return { messages: [] };
    } catch (error) {
      if (error instanceof DisconnectedError) throw error;
      throw error;
    }
  }

  async sendCommMessage(params: CommSendMessageParams): Promise<unknown> {
    const { comm, text, target } = params;
    return this.request(`${comm}_send`, { message: text, target });
  }

  async sendCommAttachment(params: CommSendAttachmentParams): Promise<unknown> {
    const { comm, path, caption, target } = params;
    return this.request(`${comm}_send_image`, { path, caption, target });
  }

  async listConversations(params: ListConversationsParams = {}): Promise<unknown> {
    return this.request("list_conversations", params);
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    if (!this.client) throw new Error("PiDaemonClient not started");
    // Inject the session id into every request (mirrors the MCP shim's
    // createDaemonRequester) so the daemon can resolve no-target sends via
    // bus.targetFromSession(session). Methods that already carry `session`
    // in their params (pi_register_session etc.) are unaffected because the
    // explicit field wins; the send/list methods rely on this injection.
    const paramsWithSession =
      this.session && typeof params === "object" && params !== null
        ? { session: this.session, ...(params as Record<string, unknown>) }
        : params;
    try {
      return await this.client.request(method, paramsWithSession);
    } catch (error) {
      rethrowUnlessDisconnected(error);
    }
  }
}

function defaultLog(message: string): void {
  console.error(`[pi-agents-comm] ${message}`);
}

export { DisconnectedError };
