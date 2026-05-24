/**
 * Generic IPC method handler signature. Comm adapter factories and agent
 * bridges both contribute method handlers to the daemon's IPC dispatcher.
 */
export type IpcMethodHandler = (params: Record<string, unknown>, ctx: {
    socket?: {
        once(event: "close", handler: () => void): void;
    };
}) => Promise<unknown>;
//# sourceMappingURL=ipc-method.d.ts.map