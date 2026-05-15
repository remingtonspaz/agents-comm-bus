import { DAEMON_VERSION, IPC_PROTOCOL_VERSION } from "../config.js";
import { connectIpc } from "../ipc/client.js";
export async function probeDaemon(options) {
    const connection = await connectIpc({
        port: options.port,
        clientVersion: options.clientVersion ?? DAEMON_VERSION,
        protocolVersion: options.protocolVersion ?? IPC_PROTOCOL_VERSION,
        metadata: options.metadata,
        timeoutMs: options.timeoutMs,
    });
    connection.close();
    return connection.hello;
}
//# sourceMappingURL=handshake.js.map