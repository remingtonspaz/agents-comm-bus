import { readFile } from "node:fs/promises";
import { DAEMON_VERSION } from "../config.js";
import { connectIpc } from "../ipc/client.js";
import { resolveDiscoveryPaths, resolveStatePaths } from "../paths.js";
/**
 * Best-effort hot-reload trigger for the CLI's account-add / account-remove
 * commands. Reads the daemon's discovery files and, if a daemon is alive,
 * fires `reload_registrations` over a one-shot WS connection. If no daemon
 * is running (or the port file is stale), returns `{ attempted: false }`
 * so the caller can print "the change takes effect on next daemon spawn"
 * instead of throwing.
 */
export async function reloadDaemonRegistrations(options = {}) {
    const statePaths = resolveStatePaths({
        stateRoot: process.env.AGENTS_COMM_BUS_ROOT ?? process.env.AGENTS_COMM_BUS_STATE_ROOT,
    });
    const paths = resolveDiscoveryPaths({
        stateRoot: statePaths.root,
        discoveryRoot: process.env.AGENTS_COMM_BUS_DISCOVERY_ROOT,
    });
    const port = await readPortFile(paths.portFile);
    if (port === undefined) {
        return { attempted: false, reason: "no daemon port file" };
    }
    const timeoutMs = options.timeoutMs ?? 2_000;
    let connection = null;
    try {
        connection = await connectIpc({
            port,
            clientVersion: DAEMON_VERSION,
            timeoutMs,
            metadata: { shimName: "agents-comm-bus/cli" },
        });
        const params = options.forceCredentialRefresh
            ? { forceCredentialRefresh: options.forceCredentialRefresh }
            : undefined;
        const summary = await connection.request("reload_registrations", params);
        return { attempted: true, ok: true, summary };
    }
    catch (error) {
        return {
            attempted: true,
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
        };
    }
    finally {
        connection?.close();
    }
}
async function readPortFile(portFile) {
    try {
        const raw = (await readFile(portFile, "utf8")).trim();
        const port = Number(raw);
        return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=reload-helper.js.map