import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { ChannelType, GatewayDispatchEvents, GatewayIntentBits, } from "discord-api-types/v10";
/** Gateway intents for guild + DM text inbound (single-shard bots). */
export const DISCORD_GATEWAY_INTENTS = GatewayIntentBits.Guilds |
    GatewayIntentBits.GuildMessages |
    GatewayIntentBits.DirectMessages |
    GatewayIntentBits.MessageContent;
export class DiscordGateway {
    options;
    manager = null;
    dispatchHandler = null;
    stateHandler = null;
    threadParents = new Map();
    sawReady = false;
    constructor(options) {
        this.options = options;
    }
    onDispatch(handler) {
        this.dispatchHandler = handler;
    }
    onConnectionState(handler) {
        this.stateHandler = handler;
    }
    threadParentChannelId(channelId) {
        return this.threadParents.get(channelId);
    }
    async connect() {
        const manager = this.options.manager ?? new WebSocketManager({
            token: this.options.token,
            intents: DISCORD_GATEWAY_INTENTS,
            rest: this.options.rest,
            shardIds: [0],
            shardCount: 1,
        });
        this.manager = manager;
        manager.on(WebSocketShardEvents.Ready, () => {
            this.sawReady = true;
            this.emitState("connected");
        });
        manager.on(WebSocketShardEvents.Resumed, () => {
            this.emitState("connected");
        });
        manager.on(WebSocketShardEvents.Closed, () => {
            this.emitState("disconnected");
        });
        manager.on(WebSocketShardEvents.Error, () => {
            this.emitState("degraded");
        });
        manager.on(WebSocketShardEvents.SocketError, () => {
            this.emitState("degraded");
        });
        manager.on(WebSocketShardEvents.Hello, () => {
            if (this.sawReady) {
                this.emitState("degraded");
            }
        });
        manager.on(WebSocketShardEvents.Dispatch, (payload) => {
            this.trackThreadParents(payload);
            this.dispatchHandler?.(payload);
        });
        await manager.connect();
    }
    async destroy() {
        if (this.manager) {
            await this.manager.destroy();
            this.manager = null;
        }
        this.threadParents.clear();
        this.sawReady = false;
        this.dispatchHandler = null;
        this.stateHandler = null;
    }
    trackThreadParents(payload) {
        if (payload.t === GatewayDispatchEvents.ThreadCreate) {
            const thread = payload.d;
            if (thread.parent_id) {
                this.threadParents.set(thread.id, thread.parent_id);
            }
            return;
        }
        if (payload.t === GatewayDispatchEvents.ThreadDelete) {
            const thread = payload.d;
            this.threadParents.delete(thread.id);
            return;
        }
        if (payload.t === GatewayDispatchEvents.ChannelCreate) {
            const channel = payload.d;
            if (isThreadChannelType(channel.type) && channel.parent_id) {
                this.threadParents.set(channel.id, channel.parent_id);
            }
            return;
        }
        if (payload.t === GatewayDispatchEvents.ChannelDelete) {
            const channel = payload.d;
            this.threadParents.delete(channel.id);
        }
    }
    emitState(state) {
        this.stateHandler?.(state);
    }
}
function isThreadChannelType(type) {
    return type === ChannelType.PublicThread
        || type === ChannelType.PrivateThread
        || type === ChannelType.AnnouncementThread;
}
//# sourceMappingURL=gateway.js.map