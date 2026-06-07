import { readFile } from "node:fs/promises";
import path from "node:path";

import { REST, RateLimitError, type RawFile } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { GatewayDispatchEvents, type APIMessage } from "discord-api-types/v10";

import type {
  AccountId,
  Attachment,
  BlobStore,
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

import { DiscordGateway, type DiscordGatewayLike } from "./gateway.js";
import { htmlToDiscordMarkdown } from "./html.js";
import { discordNonceFromIdempotencyKey } from "./nonce.js";
import { buildMessageFromDiscordCreate, normalizeDiscordAttachments } from "./normalize.js";

/** Injectable REST surface for tests and production. */
export interface DiscordRestLike {
  post(
    route: `/${string}`,
    options: { body: Record<string, unknown>; files?: RawFile[] },
  ): Promise<unknown>;
  get(route: `/${string}`): Promise<unknown>;
  setToken(token: string): this;
  destroy?(): void;
}

export interface DiscordCommAdapterOptions {
  botToken: string;
  applicationId?: string;
  accountId: AccountId;
  allowedUserIds?: readonly string[];
  rest?: DiscordRestLike;
  gateway?: DiscordGatewayLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * AGE-10: verbose allowlist-filter tracing. When true, every inbound
   * allowlist evaluation (pass AND drop) logs one line via `log`.
   */
  filterTrace?: boolean;
  log?: (message: string) => void;
  attachmentBlobStore?: BlobStore;
  fetch?: typeof fetch;
}

const EMPTY_ALLOWED_MENTIONS = { parse: [] as string[] };
const IDEMPOTENCY_CACHE_MAX = 256;

export class DiscordCommAdapter implements CommAdapter {
  readonly id = "discord" as CommId;
  readonly accountId: AccountId;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly filterTrace: boolean;
  private readonly log: (message: string) => void;
  private allowedUserIds: Set<string>;
  private readonly sentByKey = new Map<string, SendResult>();
  private inboundHandler: ((msg: Message) => Promise<void>) | null = null;
  private filterDropHandler: ((event: FilterDropEvent) => void) | null = null;
  private stateHandler: ((state: CommConnectionState) => void) | null = null;
  private connectionState: CommConnectionState | null = null;
  private rest: DiscordRestLike | null = null;
  private restForGateway: REST | null = null;
  private gateway: DiscordGatewayLike | null = null;
  private botUserId: string | null = null;
  private rateLimited = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DiscordCommAdapterOptions) {
    this.accountId = options.accountId;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.allowedUserIds = new Set(options.allowedUserIds ?? []);
    this.filterTrace = options.filterTrace ?? process.env.AGENTS_COMM_BUS_FILTER_TRACE === "1";
    this.log = options.log ?? ((message) => console.error(message));
    this.fetchImpl = options.fetch ?? fetch;
  }

  get allowedSenderIds(): readonly string[] {
    return Array.from(this.allowedUserIds);
  }

  updateAllowedSenderIds(ids: readonly string[]): void {
    this.allowedUserIds = new Set(ids);
  }

  exclusiveResource(): { resourceId: string } | null {
    return { resourceId: String(this.accountId) };
  }

  async start(): Promise<void> {
    this.emitState("connecting");
    if (!this.rest) {
      if (this.options.rest) {
        this.rest = this.options.rest;
      } else {
        this.restForGateway = new REST({ version: "10" }).setToken(this.options.botToken);
        this.rest = this.restForGateway as unknown as DiscordRestLike;
      }
    }
    if (!this.restForGateway) {
      this.restForGateway = new REST({ version: "10" }).setToken(this.options.botToken);
    }

    const me = (await this.rest.get(Routes.user("@me"))) as { id: string };
    this.botUserId = String(me.id);

    if (!this.gateway) {
      this.gateway = this.options.gateway ?? new DiscordGateway({
        token: this.options.botToken,
        rest: this.restForGateway,
      });
    }

    this.gateway.onConnectionState((state) => this.emitState(state));
    this.gateway.onDispatch((payload) => {
      if (payload.t !== GatewayDispatchEvents.MessageCreate) return;
      void this.handleDiscordMessageCreate(payload.d as APIMessage)
        .then(() => this.emitState("connected"))
        .catch(() => this.emitState("degraded"));
    });

    await this.gateway.connect();
  }

  async stop(): Promise<void> {
    if (this.gateway) {
      await this.gateway.destroy();
      this.gateway = null;
    }
    this.rest?.destroy?.();
    this.rest = null;
    this.restForGateway = null;
    this.botUserId = null;
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
    const body = discordMessageBody(payload, idempotencyKey);
    const files = await discordOutboundFiles(payload);
    let retried429 = false;

    while (true) {
      try {
        const response = await rest.post(Routes.channelMessages(target.chat_native_id), {
          body,
          ...(files.length > 0 ? { files } : {}),
        });
        const platformMessageId = String((response as { id: string }).id);
        const result = {
          platform_message_id: platformMessageId,
          sent_at: this.now(),
        };
        this.rememberSent(idempotencyKey, result);
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

  private async handleDiscordMessageCreate(raw: APIMessage): Promise<void> {
    if (!this.inboundHandler) return;
    const fromId = raw.author?.id == null ? null : String(raw.author.id);
    if (this.allowedUserIds.size > 0 && (!fromId || !this.allowedUserIds.has(fromId))) {
      this.emitFilterDrop({
        reason: fromId ? "sender_not_allowed" : "missing_sender_id",
        update_kind: "message",
        sender_id: fromId ?? undefined,
        chat_native_id: String(raw.channel_id),
        platform_message_id: String(raw.id),
      });
      return;
    }
    this.traceFilterPass("message", fromId);
    const botUserId = this.botUserId;
    if (!botUserId) throw new Error("Discord adapter has no bot identity");

    const threadParent = this.gateway?.threadParentChannelId(String(raw.channel_id));
    const baseAttachments = normalizeDiscordAttachments(raw);
    const attachments = await this.enrichAttachments(baseAttachments);
    const message = buildMessageFromDiscordCreate(raw, {
      commId: this.id,
      botUserId,
      accountId: this.accountId,
      threadParentChannelId: threadParent,
      now: this.now,
    }, attachments);
    if (!message) return;

    await this.inboundHandler(message);
  }

  private async enrichAttachments(attachments: Attachment[]): Promise<Attachment[]> {
    if (attachments.length === 0 || !this.options.attachmentBlobStore) {
      return attachments;
    }
    return Promise.all(attachments.map((attachment) => this.retrieveAttachment(attachment)));
  }

  private async retrieveAttachment(attachment: Attachment): Promise<Attachment> {
    const url = attachment.platform_metadata?.url;
    if (typeof url !== "string" || url.length === 0) return attachment;
    try {
      const response = await this.fetchImpl(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const content = new Uint8Array(await response.arrayBuffer());
      const ref = await this.options.attachmentBlobStore!.put(content, attachment.mime);
      return {
        ...attachment,
        size: attachment.size > 0 ? attachment.size : ref.size,
        blob_hash: ref.hash,
        local_path: this.options.attachmentBlobStore!.pathFor(ref),
        platform_metadata: {
          ...attachment.platform_metadata,
          retrieved_at: this.now(),
        },
      };
    } catch (error) {
      return {
        ...attachment,
        platform_metadata: {
          ...attachment.platform_metadata,
          retrieval_error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private rememberSent(idempotencyKey: string, result: SendResult): void {
    if (this.sentByKey.size >= IDEMPOTENCY_CACHE_MAX) {
      const oldest = this.sentByKey.keys().next().value;
      if (oldest !== undefined) {
        this.sentByKey.delete(oldest);
      }
    }
    this.sentByKey.set(idempotencyKey, result);
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

  private emitFilterDrop(event: FilterDropEvent): void {
    try {
      this.filterDropHandler?.(event);
    } catch {
      // Observability must never break inbound handling.
    }
    if (this.filterTrace) {
      this.log(
        `agents-comm-bus discord[${this.accountId}] FILTER DROP: ${event.update_kind} ` +
          `sender=${event.sender_id ?? "<none>"} chat=${event.chat_native_id ?? "?"} ` +
          `msg=${event.platform_message_id ?? "?"} reason=${event.reason} ` +
          `(allowlist size=${this.allowedUserIds.size})`,
      );
    }
  }

  private traceFilterPass(updateKind: string, senderId: string | null): void {
    if (!this.filterTrace) return;
    this.log(
      `agents-comm-bus discord[${this.accountId}] filter pass: ${updateKind} ` +
        `sender=${senderId ?? "<none>"} (allowlist size=${this.allowedUserIds.size})`,
    );
  }
}

export function discordMessageBody(
  payload: OutboundPayload,
  idempotencyKey?: string,
): Record<string, unknown> {
  let content = payload.text ?? "";
  if (payload.format === "html") {
    content = htmlToDiscordMarkdown(content);
  }
  const body: Record<string, unknown> = {
    content,
    allowed_mentions: EMPTY_ALLOWED_MENTIONS,
  };
  if (payload.reply_to != null) {
    body.message_reference = {
      message_id: String(payload.reply_to).replace(/^discord:/, ""),
    };
  }
  if (idempotencyKey) {
    body.nonce = discordNonceFromIdempotencyKey(idempotencyKey);
    body.enforce_nonce = true;
  }
  return body;
}

/**
 * Discord upload names must not leak caller local paths to chat recipients.
 * win32.basename treats both \\ and / as separators, so IPC paths from either
 * platform basename correctly on any host.
 */
export function uploadFilenameFromLocalPath(localPath: string): string {
  const name = path.win32.basename(localPath);
  if (name && name !== "." && name !== "..") return name;
  const posixName = path.posix.basename(localPath);
  return posixName && posixName !== "." && posixName !== ".." ? posixName : "attachment";
}

async function discordOutboundFiles(payload: OutboundPayload): Promise<RawFile[]> {
  const files: RawFile[] = [];
  for (const attachment of payload.attachments ?? []) {
    if (!attachment.local_path) continue;
    const data = await readFile(attachment.local_path);
    files.push({
      name: attachment.filename ?? uploadFilenameFromLocalPath(attachment.local_path),
      data,
      contentType: attachment.mime || undefined,
    });
  }
  return files;
}

export async function probeDiscordIdentity(
  botToken: string,
  rest?: DiscordRestLike,
): Promise<{ bot_user_id: string; bot_username?: string }> {
  const client = rest ?? (new REST({ version: "10" }).setToken(botToken) as unknown as DiscordRestLike);
  const me = (await client.get(Routes.user("@me"))) as { id: string; username?: string };
  return { bot_user_id: String(me.id), bot_username: me.username };
}
