import { REST, RateLimitError } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";

import type {
  AccountId,
  ChatRef,
  CommConnectionState,
  CommAdapter,
  FailureClassification,
  FilterDropEvent,
  Message,
  OutboundPayload,
  SendResult,
  CommId,
} from "agents-comm-bus-core";

/** Injectable REST surface for tests and production. */
export interface DiscordRestLike {
  post(route: `/${string}`, options: { body: Record<string, unknown> }): Promise<unknown>;
  get(route: `/${string}`): Promise<unknown>;
  setToken(token: string): this;
  destroy?(): void;
}

export interface DiscordCommAdapterOptions {
  botToken: string;
  applicationId?: string;
  accountId: AccountId;
  /** Resolved allowlist ids (wired on inbound in a later phase). */
  allowedUserIds?: readonly string[];
  rest?: DiscordRestLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const EMPTY_ALLOWED_MENTIONS = { parse: [] as string[] };

export class DiscordCommAdapter implements CommAdapter {
  readonly id = "discord" as CommId;
  readonly accountId: AccountId;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly sentByKey = new Map<string, SendResult>();
  private inboundHandler: ((msg: Message) => Promise<void>) | null = null;
  private filterDropHandler: ((event: FilterDropEvent) => void) | null = null;
  private stateHandler: ((state: CommConnectionState) => void) | null = null;
  private connectionState: CommConnectionState | null = null;
  private rest: DiscordRestLike | null = null;
  private rateLimited = false;

  constructor(private readonly options: DiscordCommAdapterOptions) {
    this.accountId = options.accountId;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  exclusiveResource(): { resourceId: string } | null {
    return { resourceId: String(this.accountId) };
  }

  async start(): Promise<void> {
    this.emitState("connecting");
    if (!this.rest) {
      this.rest = this.options.rest ?? (new REST({ version: "10" }).setToken(this.options.botToken) as unknown as DiscordRestLike);
    }
    await this.rest.get(Routes.user("@me"));
    this.emitState("connected");
  }

  async stop(): Promise<void> {
    this.rest?.destroy?.();
    this.rest = null;
    this.rateLimited = false;
    this.emitState("disconnected");
  }

  onInbound(handler: (msg: Message) => Promise<void>): void {
    this.inboundHandler = handler;
  }

  onFilterDrop(handler: (event: FilterDropEvent) => void): void {
    this.filterDropHandler = handler;
  }

  onConnectionState(handler: (state: CommConnectionState) => void): void {
    this.stateHandler = handler;
    if (this.connectionState) {
      handler(this.connectionState);
    }
  }

  async send(
    target: ChatRef,
    payload: OutboundPayload,
    idempotencyKey: string,
  ): Promise<SendResult> {
    const cached = this.sentByKey.get(idempotencyKey);
    if (cached) return cached;

    const rest = this.requireRest();
    const body = discordMessageBody(payload);
    let retried429 = false;

    while (true) {
      try {
        const response = await rest.post(Routes.channelMessages(target.chat_native_id), { body });
        const platformMessageId = String((response as { id: string }).id);
        const result = {
          platform_message_id: platformMessageId,
          sent_at: this.now(),
        };
        this.sentByKey.set(idempotencyKey, result);
        this.rateLimited = false;
        this.emitState("connected");
        return result;
      } catch (error) {
        if (!retried429 && error instanceof RateLimitError) {
          retried429 = true;
          this.rateLimited = true;
          await this.sleep(error.retryAfter * 1000);
          continue;
        }
        throw error;
      }
    }
  }

  reportPressure(): { backlog: number; rateLimited: boolean } {
    return { backlog: 0, rateLimited: this.rateLimited };
  }

  classifyFailure(error: unknown): FailureClassification {
    if (error instanceof RateLimitError) {
      return "rate_limited";
    }
    const anyError = error as {
      message?: string;
      status?: number;
      code?: string;
      rawError?: { code?: number; message?: string };
    };
    const message = anyError?.message ?? "";
    const status = anyError?.status ?? anyError?.rawError?.code;
    if (status === 401 || status === 403 || /\b401\b|\b403\b|unauthorized|forbidden/i.test(message)) {
      return "permanent";
    }
    if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
      return "rate_limited";
    }
    if (
      (typeof status === "number" && status >= 500) ||
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|network|5\d{2}/i.test(message)
    ) {
      return "transient";
    }
    return "transient";
  }

  private requireRest(): DiscordRestLike {
    if (!this.rest) throw new Error("Discord adapter is not started");
    return this.rest;
  }

  private emitState(state: CommConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.stateHandler?.(state);
  }
}

export function discordMessageBody(payload: OutboundPayload): Record<string, unknown> {
  const body: Record<string, unknown> = {
    content: payload.text ?? "",
    allowed_mentions: EMPTY_ALLOWED_MENTIONS,
  };
  if (payload.reply_to != null) {
    body.message_reference = {
      message_id: String(payload.reply_to).replace(/^discord:/, ""),
    };
  }
  return body;
}

export async function probeDiscordIdentity(
  botToken: string,
  rest?: DiscordRestLike,
): Promise<{ bot_user_id: string; bot_username?: string }> {
  const client = rest ?? (new REST({ version: "10" }).setToken(botToken) as unknown as DiscordRestLike);
  const me = (await client.get(Routes.user("@me"))) as { id: string; username?: string };
  return { bot_user_id: String(me.id), bot_username: me.username };
}
