/**
 * Daemon IPC client wrapper for the Pi extension lifetime.
 *
 * Phase 4 responsibilities:
 * - Own a `PersistentIpcClient` from `agents-comm-bus/ipc/persistent-client`
 *   (in-process WebSocket, not a sidecar).
 * - `start()` on `session_start`, `close()` on `session_shutdown`.
 * - `registerReplay("pi_register_session", ...)` for transparent re-registration
 *   after daemon restarts.
 * - Wrap `request(method, params)` for Pi IPC: `pi_register_session`,
 *   `pi_drain_inbound`, `pi_unregister_session`, `${comm}_send`,
 *   `${comm}_send_image`, `list_conversations`.
 * - Surface `DisconnectedError` concisely to tools/poller (auto-reconnect in background).
 *
 * Phase 4 prerequisite — `entryEnsures` seam:
 * `entryEnsures` + `applyDevConfig` live in `hosts/common/install/` (host glue,
 * not published from `agents-comm-bus`). Phase 4 must either:
 *   1. Vendor a thin copy calling `applyDevConfig` + `ensureDaemon` from
 *      `agents-comm-bus/bootstrap/ensure-daemon` with `fromDir: import.meta.dirname`, or
 *   2. Publish `entryEnsures` as a new `agents-comm-bus` export.
 * See package README § Dev mode.
 */

// Phase 4: import { PersistentIpcClient } from "agents-comm-bus/ipc/persistent-client";

export interface PiRegisterSessionParams {
  session: string;
  project: string;
  connection_id: string;
  replace_existing_lease?: boolean;
  owner_process_pid?: number;
  owner_process_label?: string;
}

export interface PiDrainInboundParams {
  session: string;
  project?: string;
  comm?: string;
  limit?: number;
}

export interface PiUnregisterSessionParams {
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

export class PiDaemonClient {
  // Phase 4: private client: PersistentIpcClient | null = null;

  async start(): Promise<void> {
    throw new Error("phase4: not implemented");
  }

  async close(): Promise<void> {
    throw new Error("phase4: not implemented");
  }

  async registerPiSession(_params: PiRegisterSessionParams): Promise<unknown> {
    throw new Error("phase4: not implemented");
  }

  async unregisterPiSession(_params: PiUnregisterSessionParams): Promise<unknown> {
    throw new Error("phase4: not implemented");
  }

  async drainPiInbound(_params: PiDrainInboundParams): Promise<unknown> {
    throw new Error("phase4: not implemented");
  }

  async sendCommMessage(_params: CommSendMessageParams): Promise<unknown> {
    throw new Error("phase4: not implemented");
  }

  async sendCommAttachment(_params: CommSendAttachmentParams): Promise<unknown> {
    throw new Error("phase4: not implemented");
  }

  async listConversations(_params?: ListConversationsParams): Promise<unknown> {
    throw new Error("phase4: not implemented");
  }
}
