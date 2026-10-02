import { connectIpc } from "../ipc/client.js";
import { DAEMON_VERSION } from "../config.js";
import { entryEnsures } from "../host-runtime/entry-ensures.js";
import { parseHerdrIdentity } from "../runtime/herdr.js";
export async function herdrPaneSync(options) {
    const identity = parseHerdrIdentity(JSON.parse(options.identityJson));
    if (!identity) {
        throw new Error("invalid --identity-json");
    }
    const daemon = await entryEnsures({
        agent: options.agent,
        fromDir: import.meta.dirname,
        env: process.env,
        ensureDaemonOptions: {
            metadata: { shimName: "agents-comm-bus/cli", operation: "herdr-pane-sync" },
        },
    });
    const connection = await connectIpc({
        port: daemon.port,
        clientVersion: DAEMON_VERSION,
        timeoutMs: 5_000,
        metadata: { shimName: "agents-comm-bus/cli", operation: "herdr-pane-sync" },
    });
    try {
        return await connection.request("herdr_register_pane", {
            project: options.project,
            agent: options.agent,
            identity,
            wake_strict: options.wakeStrict,
        });
    }
    finally {
        connection.close();
    }
}
export async function herdrPaneRelease(options) {
    const identity = parseHerdrIdentity(JSON.parse(options.identityJson));
    if (!identity) {
        throw new Error("invalid --identity-json");
    }
    const daemon = await entryEnsures({
        agent: identity.agent,
        fromDir: import.meta.dirname,
        env: process.env,
        ensureDaemonOptions: {
            metadata: { shimName: "agents-comm-bus/cli", operation: "herdr-pane-release" },
        },
    });
    const connection = await connectIpc({
        port: daemon.port,
        clientVersion: DAEMON_VERSION,
        timeoutMs: 5_000,
        metadata: { shimName: "agents-comm-bus/cli", operation: "herdr-pane-release" },
    });
    try {
        return await connection.request("herdr_release_pane", { identity });
    }
    finally {
        connection.close();
    }
}
//# sourceMappingURL=herdr-pane.js.map