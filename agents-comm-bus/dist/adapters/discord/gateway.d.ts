import { REST } from "@discordjs/rest";
import { WebSocketManager } from "@discordjs/ws";
import { type GatewayDispatchPayload } from "discord-api-types/v10";
import type { CommConnectionState } from "agents-comm-bus-core";
/** Gateway intents for guild + DM text inbound (single-shard bots). */
export declare const DISCORD_GATEWAY_INTENTS: number;
export interface DiscordGatewayLike {
    connect(): Promise<void>;
    destroy(): Promise<void>;
    onDispatch(handler: (payload: GatewayDispatchPayload) => void): void;
    onConnectionState(handler: (state: CommConnectionState) => void): void;
    /** Parent channel id when `channelId` is a known thread channel. */
    threadParentChannelId(channelId: string): string | undefined;
}
export interface DiscordGatewayOptions {
    token: string;
    rest: REST;
    manager?: WebSocketManager;
}
export declare class DiscordGateway implements DiscordGatewayLike {
    private readonly options;
    private manager;
    private dispatchHandler;
    private stateHandler;
    private readonly threadParents;
    private sawReady;
    constructor(options: DiscordGatewayOptions);
    onDispatch(handler: (payload: GatewayDispatchPayload) => void): void;
    onConnectionState(handler: (state: CommConnectionState) => void): void;
    threadParentChannelId(channelId: string): string | undefined;
    connect(): Promise<void>;
    destroy(): Promise<void>;
    private trackThreadParents;
    private emitState;
}
//# sourceMappingURL=gateway.d.ts.map