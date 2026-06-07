import { REST } from "@discordjs/rest";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import {
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
  type APIMessage,
  type APIThreadChannel,
  type GatewayDispatchPayload,
} from "discord-api-types/v10";

import type { CommConnectionState } from "agents-comm-bus-core";

/** Gateway intents for guild + DM text inbound (single-shard bots). */
export const DISCORD_GATEWAY_INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.DirectMessages |
  GatewayIntentBits.MessageContent;

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

export class DiscordGateway implements DiscordGatewayLike {
  private manager: WebSocketManager | null = null;
  private dispatchHandler: ((payload: GatewayDispatchPayload) => void) | null = null;
  private stateHandler: ((state: CommConnectionState) => void) | null = null;
  private readonly threadParents = new Map<string, string>();
  private sawReady = false;

  constructor(private readonly options: DiscordGatewayOptions) {}

  onDispatch(handler: (payload: GatewayDispatchPayload) => void): void {
    this.dispatchHandler = handler;
  }

  onConnectionState(handler: (state: CommConnectionState) => void): void {
    this.stateHandler = handler;
  }

  threadParentChannelId(channelId: string): string | undefined {
    return this.threadParents.get(channelId);
  }

  async connect(): Promise<void> {
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

  async destroy(): Promise<void> {
    if (this.manager) {
      await this.manager.destroy();
      this.manager = null;
    }
    this.threadParents.clear();
    this.sawReady = false;
    this.dispatchHandler = null;
    this.stateHandler = null;
  }

  private trackThreadParents(payload: GatewayDispatchPayload): void {
    if (payload.t === GatewayDispatchEvents.ThreadCreate) {
      const thread = payload.d as APIThreadChannel;
      if (thread.parent_id) {
        this.threadParents.set(thread.id, thread.parent_id);
      }
      return;
    }
    if (payload.t === GatewayDispatchEvents.ThreadDelete) {
      const thread = payload.d as { id: string };
      this.threadParents.delete(thread.id);
      return;
    }
    if (payload.t === GatewayDispatchEvents.ChannelCreate) {
      const channel = payload.d as { id: string; type: ChannelType; parent_id?: string };
      if (isThreadChannelType(channel.type) && channel.parent_id) {
        this.threadParents.set(channel.id, channel.parent_id);
      }
      return;
    }
    if (payload.t === GatewayDispatchEvents.ChannelDelete) {
      const channel = payload.d as { id: string };
      this.threadParents.delete(channel.id);
    }
  }

  private emitState(state: CommConnectionState): void {
    this.stateHandler?.(state);
  }
}

function isThreadChannelType(type: ChannelType): boolean {
  return type === ChannelType.PublicThread
    || type === ChannelType.PrivateThread
    || type === ChannelType.AnnouncementThread;
}
