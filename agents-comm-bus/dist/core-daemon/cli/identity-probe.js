import { connectIpc } from "../ipc/client.js";
import { DAEMON_VERSION } from "../config.js";
// The CLI is shipped at the plugin root in production, and under
// core-daemon/cli in source/dev. entryEnsures handles both: production central
// install from install-stamp.json, or source mode from the dev marker/env.
import { entryEnsures } from "../host-runtime/entry-ensures.js";
export async function probeIdentityViaDaemon(options) {
    const credentials = { ...options.credentials };
    if (options.accountId && credentials.accountId === undefined) {
        credentials.accountId = options.accountId;
    }
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
            credentials,
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