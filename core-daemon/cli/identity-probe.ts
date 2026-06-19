import { connectIpc } from "../ipc/client.js";
import { DAEMON_VERSION } from "../config.js";

// The CLI is shipped at the plugin root in production, and under
// core-daemon/cli in source/dev. entryEnsures handles both: production central
// install from install-stamp.json, or source mode from the dev marker/env.
import { entryEnsures } from "../host-runtime/entry-ensures.js";

export interface BotIdentity {
  bot_user_id: string;
  bot_username?: string | null;
}

export type ProbeIdentity = (botToken: string, accountId?: string) => Promise<BotIdentity>;

export async function probeIdentityViaDaemon(options: {
  comm: string;
  botToken: string;
  /**
   * Explicit synthetic account id for comms without a remote identity to
   * probe (e.g. curl, AGE-50). Comms that probe a real platform identity
   * ignore it.
   */
  accountId?: string;
  agent?: string;
  stateRoot?: string;
  timeoutMs?: number;
}): Promise<BotIdentity> {
  const daemon = await entryEnsures({
    // CLI identity probing is agent-agnostic; `agent` only scopes central-install
    // adapter selection. account-add always passes a concrete agent; the rare
    // caller that omits it (account-update-token by bot-id) falls back to the
    // primary agent. (Previously this passed `undefined` through an untyped JS
    // wrapper; the moved TS module makes the contract explicit.)
    agent: options.agent ?? "claude",
    comm: options.comm,
    stateRoot: options.stateRoot,
    fromDir: import.meta.dirname,
    env: process.env,
    ensureDaemonOptions: {
      timeoutMs: options.timeoutMs,
      metadata: { shimName: "agents-comm-bus/cli", operation: "probe_comm_identity" },
    },
  });
  const connection = await connectIpc({
    port: daemon.port,
    clientVersion: DAEMON_VERSION,
    timeoutMs: options.timeoutMs ?? 2_000,
    metadata: { shimName: "agents-comm-bus/cli", operation: "probe_comm_identity" },
  });
  try {
    const result = await connection.request("probe_comm_identity", {
      comm: options.comm,
      credentials: {
        botToken: options.botToken,
        ...(options.accountId ? { accountId: options.accountId } : {}),
      },
    });
    return parseProbeResult(result);
  } finally {
    connection.close();
  }
}

function parseProbeResult(result: unknown): BotIdentity {
  if (!result || typeof result !== "object") {
    throw new Error("probe_comm_identity returned an invalid response");
  }
  const record = result as Record<string, unknown>;
  if (record.account_id == null) {
    throw new Error("probe_comm_identity response is missing account_id");
  }
  return {
    bot_user_id: String(record.account_id),
    bot_username: record.account_username == null ? null : String(record.account_username),
  };
}
