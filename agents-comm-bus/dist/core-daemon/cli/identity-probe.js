import { connectIpc } from "../ipc/client.js";
import { DAEMON_VERSION } from "../config.js";
// The CLI is shipped at the plugin root in production, and under
// core-daemon/cli in source/dev. entryEnsures handles both: production central
// install from install-stamp.json, or source mode from the dev marker/env.
// @ts-expect-error JS install wrapper has no TypeScript declarations.
import { entryEnsures } from "../../hosts/common/install/entry-ensures.js";
export async function probeIdentityViaDaemon(options) {
    const daemon = await entryEnsures({
        agent: options.agent,
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
    }
    finally {
        connection.close();
    }
}
function parseProbeResult(result) {
    if (!result || typeof result !== "object") {
        throw new Error("probe_comm_identity returned an invalid response");
    }
    const record = result;
    if (record.account_id == null) {
        throw new Error("probe_comm_identity response is missing account_id");
    }
    return {
        bot_user_id: String(record.account_id),
        bot_username: record.account_username == null ? null : String(record.account_username),
    };
}
//# sourceMappingURL=identity-probe.js.map