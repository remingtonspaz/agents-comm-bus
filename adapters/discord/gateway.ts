import { REST } from "@discordjs/rest";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import {
  ChannelType,
  GatewayDispatchEvents,
  GatewayIntentBits,
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
    trackThreadParentDispatch(this.threadParents, payload);
  }

  private emitState(state: CommConnectionState): void {
    this.stateHandler?.(state);
  }
}

/**
 * Update the thread-id → parent-channel-id cache from gateway dispatches.
 * Exported for harness tests that replay GUILD_CREATE / THREAD_LIST_SYNC payloads.
 */
export function trackThreadParentDispatch(
  threadParents: Map<string, string>,
  payload: GatewayDispatchPayload,
): void {
  if (payload.t === GatewayDispatchEvents.GuildCreate) {
    const guild = payload.d as { threads?: ReadonlyArray<{ id: string; parent_id?: string }> };
    rememberThreadParents(threadParents, guild.threads ?? []);
    return;
  }
  if (payload.t === GatewayDispatchEvents.ThreadListSync) {
    const sync = payload.d as { threads?: ReadonlyArray<{ id: string; parent_id?: string }> };
    rememberThreadParents(threadParents, sync.threads ?? []);
    return;
  }
  if (payload.t === GatewayDispatchEvents.ThreadCreate || payload.t === GatewayDispatchEvents.ThreadUpdate) {
    rememberThreadParent(threadParents, payload.d as APIThreadChannel);
    return;
  }
  if (payload.t === GatewayDispatchEvents.ThreadDelete) {
    const thread = payload.d as { id: string };
    threadParents.delete(thread.id);
    return;
  }
  if (payload.t === GatewayDispatchEvents.ChannelCreate) {
    const channel = payload.d as { id: string; type: ChannelType; parent_id?: string };
    if (isThreadChannelType(channel.type)) {
      rememberThreadParent(threadParents, channel);
    }
    return;
  }
  if (payload.t === GatewayDispatchEvents.ChannelDelete) {
    const channel = payload.d as { id: string };
    threadParents.delete(channel.id);
  }
}

function rememberThreadParents(
  threadParents: Map<string, string>,
  threads: ReadonlyArray<{ id: string; parent_id?: string }>,
): void {
  for (const thread of threads) {
    rememberThreadParent(threadParents, thread);
  }
}

function rememberThreadParent(
  threadParents: Map<string, string>,
  thread: { id: string; parent_id?: string },
): void {
  if (thread.parent_id) {
    threadParents.set(thread.id, thread.parent_id);
  }
}

function isThreadChannelType(type: ChannelType): boolean {
  return type === ChannelType.PublicThread
    || type === ChannelType.PrivateThread
    || type === ChannelType.AnnouncementThread;
}
