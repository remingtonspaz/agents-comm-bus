import { createRequire as __acbCreateRequire } from 'module'; const require = __acbCreateRequire(import.meta.url);

// ../adapters/matrix/factory.ts
import path2 from "node:path";

// ../core-daemon/runtime/credential-resolution.ts
import { readFile } from "node:fs/promises";
async function readCredentialFile(ref) {
  if (!ref.startsWith("file:")) {
    return { status: "absent" };
  }
  const path3 = ref.slice("file:".length);
  let raw;
  try {
    raw = await readFile(path3, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
    if (code === "ENOENT") {
      return { status: "absent" };
    }
    return {
      status: "invalid",
      failureKind: "unreadable",
      reason: `credential file unreadable: ${code}`,
      path: path3
    };
  }
  try {
    return { status: "ok", path: path3, json: JSON.parse(raw) };
  } catch {
    return {
      status: "invalid",
      failureKind: "malformed_json",
      reason: "credential file is not valid JSON",
      path: path3
    };
  }
}

// ../adapters/matrix/adapter.ts
import { createHash } from "node:crypto";
import { readFile as readFile2 } from "node:fs/promises";
import path from "node:path";

// ../adapters/matrix/html.ts
function stripTags(text) {
  return text.replace(/<[^>]+>/g, "");
}
function decodeCommonEntities(text) {
  return text.replace(/<br\s*\/?>/gi, "\n").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function newlinesToBr(html) {
  return html.replace(/\r?\n/g, "<br/>");
}
function htmlToMatrixFormatted(html) {
  const formatted_body = newlinesToBr(html.trim());
  let body = html;
  body = body.replace(/<br\s*\/?>/gi, "\n");
  body = stripTags(body);
  body = decodeCommonEntities(body);
  return { formatted_body, body };
}

// ../adapters/matrix/media.ts
function parseMxcUri(mxcUri) {
  const match = /^mxc:\/\/([^/]+)\/(.+)$/.exec(mxcUri.trim());
  if (!match) return null;
  const serverName = match[1];
  const mediaId = match[2];
  if (!serverName || !mediaId) return null;
  return { serverName, mediaId };
}
function createFetchMatrixMediaClient(homeserverUrl, accessToken, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = homeserverUrl.replace(/\/+$/, "");
  return {
    async download(mxcUri) {
      const location = parseMxcUri(mxcUri);
      if (!location) {
        throw new Error(`Invalid Matrix MXC URI: ${mxcUri}`);
      }
      const url = `${baseUrl}/_matrix/client/v1/media/download/${encodeURIComponent(location.serverName)}/${encodeURIComponent(location.mediaId)}`;
      const response = await fetchFn(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!response.ok) {
        throw new Error(`Matrix media download failed: HTTP ${response.status}`);
      }
      const mime = response.headers.get("content-type") ?? void 0;
      return {
        content: new Uint8Array(await response.arrayBuffer()),
        mime: mime && mime.length > 0 ? mime : void 0
      };
    },
    async upload(request) {
      const url = new URL(`${baseUrl}/_matrix/media/v3/upload`);
      if (request.filename) {
        url.searchParams.set("filename", request.filename);
      }
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": request.mime || "application/octet-stream"
        },
        body: Buffer.from(request.content)
      });
      const bodyText = await response.text().catch(() => "");
      if (!response.ok) {
        throw new Error(
          `Matrix media upload failed: HTTP ${response.status}${bodyText ? ` ${bodyText}` : ""}`
        );
      }
      const body = bodyText ? JSON.parse(bodyText) : {};
      if (!body.content_uri) {
        throw new Error("Matrix media upload succeeded but response omitted content_uri");
      }
      return body.content_uri;
    }
  };
}
function matrixOutboundMsgtypeForMime(mime) {
  if (mime.toLowerCase().startsWith("image/")) return "m.image";
  return "m.file";
}
var MATRIX_MEDIA_MSGTYPES = /* @__PURE__ */ new Set([
  "m.image",
  "m.file",
  "m.audio",
  "m.video"
]);

// ../adapters/matrix/adapter.ts
var DEFAULT_SYNC_TIMEOUT_MS = 3e4;
var DEFAULT_SYNC_RETRY_DELAY_MS = 1e3;
var IDEMPOTENCY_CACHE_MAX = 256;
function createFetchMatrixSyncClient(homeserverUrl, accessToken, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_SYNC_RETRY_DELAY_MS;
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = homeserverUrl.replace(/\/+$/, "");
  let stopped = false;
  let loopPromise = null;
  let abortController = null;
  let retryTimer = null;
  let retryResolve = null;
  let nextBatch;
  const sleep = (ms) => new Promise((resolve) => {
    retryResolve = resolve;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryResolve = null;
      resolve();
    }, ms);
  });
  const cancelRetrySleep = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const resolve = retryResolve;
    retryResolve = null;
    resolve?.();
  };
  const fetchSync = async () => {
    abortController?.abort();
    abortController = new AbortController();
    const signal = abortController.signal;
    const timeout = setTimeout(() => abortController?.abort(), timeoutMs + 5e3);
    const isInitialSync = nextBatch == null;
    try {
      const url = new URL(`${baseUrl}/_matrix/client/v3/sync`);
      url.searchParams.set("timeout", String(timeoutMs));
      if (nextBatch) {
        url.searchParams.set("since", nextBatch);
      }
      const response = await fetchFn(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(
          `Matrix sync failed: HTTP ${response.status}${body ? ` ${body}` : ""}`
        );
        Object.assign(error, { status: response.status });
        throw error;
      }
      return {
        response: await response.json(),
        isInitialSync
      };
    } finally {
      clearTimeout(timeout);
    }
  };
  const runLoop = async (handlers) => {
    while (!stopped) {
      try {
        const { response, isInitialSync } = await fetchSync();
        if (stopped) break;
        if (response.next_batch) {
          nextBatch = response.next_batch;
        }
        await handlers.onSyncResponse(response, { isInitialSync });
      } catch (error) {
        if (stopped) break;
        handlers.onError(error);
        await sleep(retryDelayMs);
      }
    }
  };
  return {
    async start(handlers) {
      if (loopPromise) return;
      stopped = false;
      loopPromise = runLoop(handlers);
    },
    async stop() {
      stopped = true;
      abortController?.abort();
      cancelRetrySleep();
      if (loopPromise) {
        await loopPromise.catch(() => {
        });
        loopPromise = null;
      }
      abortController = null;
    }
  };
}
function matrixTxnIdFromIdempotencyKey(idempotencyKey) {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}
function matrixReplyEventId(replyTo) {
  if (!replyTo) return void 0;
  return replyTo.startsWith("matrix:") ? replyTo.slice("matrix:".length) : replyTo;
}
function matrixOutboundMessageContent(payload) {
  const content = payload.format === "html" ? (() => {
    const formatted = htmlToMatrixFormatted(payload.text ?? "");
    return {
      msgtype: "m.text",
      format: "org.matrix.custom.html",
      formatted_body: formatted.formatted_body,
      body: formatted.body
    };
  })() : {
    msgtype: "m.text",
    body: payload.text ?? ""
  };
  const replyEventId = matrixReplyEventId(payload.reply_to);
  if (replyEventId) {
    content["m.relates_to"] = {
      "m.in_reply_to": { event_id: replyEventId }
    };
  }
  return content;
}
function uploadFilenameFromLocalPath(localPath) {
  const name = path.win32.basename(localPath);
  if (name && name !== "." && name !== "..") return name;
  const posixName = path.posix.basename(localPath);
  return posixName && posixName !== "." && posixName !== ".." ? posixName : "attachment";
}
function matrixAttachmentTxnSuffix(idempotencyKey, index) {
  return `${matrixTxnIdFromIdempotencyKey(idempotencyKey)}-att-${index}`;
}
function createFetchMatrixSendClient(homeserverUrl, accessToken, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = homeserverUrl.replace(/\/+$/, "");
  return {
    async sendMessage(request) {
      const roomId = encodeURIComponent(request.roomId);
      const txnId = encodeURIComponent(request.txnId);
      const url = `${baseUrl}/_matrix/client/v3/rooms/${roomId}/send/m.room.message/${txnId}`;
      const response = await fetchFn(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(request.content)
      });
      const bodyText = await response.text().catch(() => "");
      if (!response.ok) {
        throw matrixSendHttpError(response.status, bodyText);
      }
      const body = bodyText ? JSON.parse(bodyText) : {};
      if (!body.event_id) {
        throw new Error("Matrix send succeeded but response omitted event_id");
      }
      return { event_id: body.event_id };
    }
  };
}
function matrixSendHttpError(status, bodyText) {
  let body = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
    }
  }
  const error = new Error(
    `Matrix send failed: HTTP ${status}${bodyText ? ` ${bodyText}` : ""}`
  );
  Object.assign(error, {
    status,
    errcode: body.errcode,
    retry_after_ms: body.retry_after_ms
  });
  return error;
}
var defaultSleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
var MatrixCommAdapter = class {
  constructor(options) {
    this.options = options;
    this.accountId = options.accountId;
    this.homeserverUrl = options.homeserverUrl;
    this.accessToken = options.accessToken;
    this.userId = options.userId;
    this.syncClient = options.syncClient ?? createFetchMatrixSyncClient(
      options.homeserverUrl,
      options.accessToken
    );
    this.sendClient = options.sendClient ?? createFetchMatrixSendClient(
      options.homeserverUrl,
      options.accessToken
    );
    this.mediaClient = options.mediaClient ?? createFetchMatrixMediaClient(
      options.homeserverUrl,
      options.accessToken
    );
    this.attachmentBlobStore = options.attachmentBlobStore;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.allowedUserIds = new Set(options.allowedUserIds ?? []);
    this.allowedRoomIds = new Set(options.allowedRoomIds ?? []);
  }
  options;
  id = "matrix";
  accountId;
  homeserverUrl;
  accessToken;
  userId;
  syncClient;
  sendClient;
  mediaClient;
  attachmentBlobStore;
  sleep;
  now;
  sentByKey = /* @__PURE__ */ new Map();
  allowedUserIds;
  allowedRoomIds;
  inboundHandler = null;
  stateHandler = null;
  filterDropHandler = null;
  connectionState = null;
  started = false;
  rateLimited = false;
  get allowedSenderIds() {
    return Array.from(this.allowedUserIds);
  }
  updateAllowedSenderIds(ids) {
    this.allowedUserIds = new Set(ids);
  }
  exclusiveResource() {
    return { resourceId: String(this.accountId) };
  }
  async start() {
    if (this.started) return;
    this.emitState("connecting");
    try {
      await this.syncClient.start({
        onSyncResponse: async (response, context) => {
          try {
            await this.processSyncResponse(response, context?.isInitialSync ?? false);
            this.emitState("connected");
          } catch {
            this.emitState("degraded");
          }
        },
        onError: () => {
          this.emitState("degraded");
        }
      });
      this.started = true;
      this.emitState("connected");
    } catch {
      await this.syncClient.stop().catch(() => {
      });
      this.emitState("disconnected");
      throw new Error("Matrix sync client failed to start");
    }
  }
  async stop() {
    if (!this.started && this.connectionState === "disconnected") return;
    if (this.started) {
      await this.syncClient.stop().catch(() => {
      });
    }
    this.started = false;
    this.rateLimited = false;
    this.emitState("disconnected");
  }
  onInbound(handler) {
    this.inboundHandler = handler;
  }
  onConnectionState(handler) {
    this.stateHandler = handler;
    if (this.connectionState) {
      handler(this.connectionState);
    }
  }
  onFilterDrop(handler) {
    this.filterDropHandler = handler;
  }
  async send(target, payload, idempotencyKey) {
    const cached = this.sentByKey.get(idempotencyKey);
    if (cached) return cached;
    const uploadable = (payload.attachments ?? []).filter((attachment) => attachment.local_path);
    let lastResult = null;
    if (payload.text) {
      lastResult = await this.sendMessageWithRetry(
        target,
        matrixOutboundMessageContent(payload),
        matrixTxnIdFromIdempotencyKey(idempotencyKey)
      );
    }
    for (let index = 0; index < uploadable.length; index++) {
      const attachment = uploadable[index];
      const mediaContent = await this.buildOutboundMediaContent(attachment, payload.reply_to);
      const txnId = uploadable.length > 1 || payload.text ? matrixAttachmentTxnSuffix(idempotencyKey, index) : matrixTxnIdFromIdempotencyKey(idempotencyKey);
      lastResult = await this.sendMessageWithRetry(target, mediaContent, txnId);
    }
    if (!lastResult) {
      lastResult = await this.sendMessageWithRetry(
        target,
        matrixOutboundMessageContent(payload),
        matrixTxnIdFromIdempotencyKey(idempotencyKey)
      );
    }
    this.rememberSent(idempotencyKey, lastResult);
    return lastResult;
  }
  reportPressure() {
    return { backlog: 0, rateLimited: this.rateLimited };
  }
  classifyFailure(error) {
    const anyError = error;
    const message = anyError?.message ?? String(error);
    const status = anyError?.status ?? anyError?.statusCode ?? anyError?.response?.status ?? anyError?.response?.statusCode;
    const errcode = anyError?.errcode ?? anyError?.response?.body?.errcode;
    if (status === 401 || status === 403 || /\b401\b|\b403\b|unauthorized|forbidden/i.test(message)) {
      return "permanent";
    }
    if (status === 429 || errcode === "M_LIMIT_EXCEEDED" || errcode === "M_USER_LIMIT_EXCEEDED" || /rate.?limit|too many requests|M_LIMIT_EXCEEDED|M_USER_LIMIT_EXCEEDED/i.test(message)) {
      return "rate_limited";
    }
    if (status != null && status >= 500 || /ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(message)) {
      return "transient";
    }
    return "transient";
  }
  async processSyncResponse(response, isInitialSync) {
    if (isInitialSync) return;
    const joined = response.rooms?.join;
    if (!joined) return;
    for (const [roomId, roomData] of Object.entries(joined)) {
      const events = roomData.timeline?.events ?? [];
      for (const event of events) {
        await this.handleTimelineEvent(roomId, event);
      }
    }
  }
  async handleTimelineEvent(roomId, event) {
    if (!this.inboundHandler) return;
    if (event.type === "m.room.encrypted") return;
    if (event.type !== "m.room.message") return;
    const content = event.content;
    if (!content || typeof content !== "object") return;
    const msgtype = content.msgtype;
    const isText = msgtype === "m.text" || msgtype === "m.notice";
    const isMedia = typeof msgtype === "string" && MATRIX_MEDIA_MSGTYPES.has(msgtype);
    if (!isText && !isMedia) return;
    const eventId = event.event_id;
    const sender = event.sender;
    if (!eventId) return;
    if (!sender) {
      this.emitFilterDrop({
        reason: "missing_sender_id",
        update_kind: "message",
        chat_native_id: roomId,
        platform_message_id: eventId
      });
      return;
    }
    if (sender === this.accountId) return;
    if (this.allowedRoomIds.size > 0 && !this.allowedRoomIds.has(roomId)) {
      this.emitFilterDrop({
        reason: "sender_not_allowed",
        update_kind: "message",
        sender_id: sender,
        chat_native_id: roomId,
        platform_message_id: eventId
      });
      return;
    }
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(sender)) {
      this.emitFilterDrop({
        reason: "sender_not_allowed",
        update_kind: "message",
        sender_id: sender,
        chat_native_id: roomId,
        platform_message_id: eventId
      });
      return;
    }
    const body = typeof content.body === "string" ? content.body : "";
    if (isText && !body) return;
    const replyTo = matrixReplyToMessageId(content);
    const attachments = isMedia ? [await this.buildInboundMediaAttachment(content, msgtype)] : [];
    await this.inboundHandler({
      schema_version: 1,
      message_id: `matrix:${eventId}`,
      chat: {
        comm: this.id,
        account: this.accountId,
        chat_native_id: roomId
      },
      sender: {
        id: sender,
        display_name: sender,
        isBot: false,
        isForeignBot: false
      },
      origin: { comm: this.id },
      text: body,
      attachments,
      platform_message_id: eventId,
      reply_to: replyTo,
      hop_count: 0,
      received_at: typeof event.origin_server_ts === "number" ? event.origin_server_ts : this.now()
    });
  }
  async buildInboundMediaAttachment(content, msgtype) {
    const info = content.info && typeof content.info === "object" ? content.info : {};
    const mxcUri = typeof content.url === "string" ? content.url : "";
    const body = typeof content.body === "string" ? content.body : "";
    const infoName = typeof info.name === "string" ? info.name : void 0;
    const filename = body || infoName || "attachment";
    const mime = typeof info.mimetype === "string" ? info.mimetype : "application/octet-stream";
    const size = typeof info.size === "number" ? info.size : 0;
    const base = {
      mime,
      filename,
      size,
      platform_metadata: {
        mxc_uri: mxcUri || void 0,
        msgtype,
        info
      }
    };
    const mxcLocation = mxcUri ? parseMxcUri(mxcUri) : null;
    if (!mxcUri || !mxcLocation || !this.attachmentBlobStore) {
      const retrievalError = !mxcUri ? "missing MXC URI" : !mxcLocation ? `Invalid Matrix MXC URI: ${mxcUri}` : "blob store unavailable";
      return {
        ...base,
        platform_metadata: {
          ...base.platform_metadata,
          retrieval_error: retrievalError
        }
      };
    }
    try {
      const downloaded = await this.mediaClient.download(mxcUri);
      const ref = await this.attachmentBlobStore.put(
        downloaded.content,
        downloaded.mime ?? mime
      );
      return {
        ...base,
        mime: downloaded.mime ?? mime,
        size: size > 0 ? size : ref.size,
        blob_hash: ref.hash,
        local_path: this.attachmentBlobStore.pathFor(ref),
        platform_metadata: {
          ...base.platform_metadata,
          retrieved_at: this.now()
        }
      };
    } catch (error) {
      return {
        ...base,
        platform_metadata: {
          ...base.platform_metadata,
          retrieval_error: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }
  async buildOutboundMediaContent(attachment, replyTo) {
    const localPath = attachment.local_path;
    const bytes = await readFile2(localPath);
    const mime = attachment.mime || "application/octet-stream";
    const filename = attachment.filename || uploadFilenameFromLocalPath(localPath);
    const mxcUri = await this.mediaClient.upload({
      content: bytes,
      mime,
      filename
    });
    const content = {
      msgtype: matrixOutboundMsgtypeForMime(mime),
      body: filename,
      url: mxcUri,
      info: {
        mimetype: mime,
        size: attachment.size > 0 ? attachment.size : bytes.byteLength
      }
    };
    const replyEventId = matrixReplyEventId(replyTo);
    if (replyEventId) {
      content["m.relates_to"] = {
        "m.in_reply_to": { event_id: replyEventId }
      };
    }
    return content;
  }
  async sendMessageWithRetry(target, content, txnId) {
    let retried429 = false;
    while (true) {
      try {
        const response = await this.sendClient.sendMessage({
          roomId: target.chat_native_id,
          txnId,
          content
        });
        const result = {
          platform_message_id: response.event_id,
          sent_at: this.now()
        };
        this.rateLimited = false;
        this.emitState("connected");
        return result;
      } catch (error) {
        if (!retried429 && this.classifyFailure(error) === "rate_limited") {
          const retryAfterMs = error.retry_after_ms;
          if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
            retried429 = true;
            this.rateLimited = true;
            if (retryAfterMs > 0) {
              await this.sleep(retryAfterMs);
            }
            continue;
          }
          this.rateLimited = true;
          throw error;
        }
        throw error;
      }
    }
  }
  rememberSent(idempotencyKey, result) {
    if (this.sentByKey.size >= IDEMPOTENCY_CACHE_MAX) {
      const oldest = this.sentByKey.keys().next().value;
      if (oldest !== void 0) {
        this.sentByKey.delete(oldest);
      }
    }
    this.sentByKey.set(idempotencyKey, result);
  }
  emitState(state) {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.stateHandler?.(state);
  }
  emitFilterDrop(event) {
    try {
      this.filterDropHandler?.(event);
    } catch {
    }
  }
};
function matrixReplyToMessageId(content) {
  const relatesTo = content["m.relates_to"];
  if (!relatesTo || typeof relatesTo !== "object") return void 0;
  const inReplyTo = relatesTo["m.in_reply_to"];
  if (!inReplyTo || typeof inReplyTo !== "object") return void 0;
  const eventId = inReplyTo.event_id;
  if (typeof eventId !== "string" || !eventId) return void 0;
  return `matrix:${eventId}`;
}
function mxidLocalpart(userId) {
  const match = /^@([^:]+):/.exec(userId);
  return match ? match[1] : null;
}
function isMatrixMxid(value) {
  return /^@[^:]+:[^:]+$/.test(value);
}
var defaultIdentityClient = {
  async whoami(homeserverUrl, accessToken) {
    const response = await fetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(
        `Matrix whoami failed: HTTP ${response.status}${body ? ` ${body}` : ""}`
      );
      Object.assign(error, { status: response.status });
      throw error;
    }
    return await response.json();
  }
};
async function probeMatrixIdentity(homeserverUrl, accessToken, expectedUserId, client = defaultIdentityClient) {
  const whoami = await client.whoami(homeserverUrl, accessToken);
  if (whoami.is_guest) {
    throw new Error("Matrix guest accounts are not supported");
  }
  if (whoami.user_id !== expectedUserId) {
    throw new Error(
      `Matrix whoami user_id mismatch: expected ${expectedUserId}, got ${whoami.user_id}`
    );
  }
  return { user_id: whoami.user_id, localpart: mxidLocalpart(whoami.user_id) };
}

// ../adapters/matrix/factory.ts
var MATRIX_COMM_ID = "matrix";
var MatrixCommAdapterFactory = class {
  constructor(options = {}) {
    this.options = options;
  }
  options;
  commId = MATRIX_COMM_ID;
  async resolveCredentials(registration, env, context) {
    const ref = registration.credentials_ref ?? "";
    if (!ref.startsWith("file:")) return { status: "absent" };
    const fileResult = await readCredentialFile(ref);
    if (fileResult.status !== "ok") {
      return fileResult;
    }
    const validated = validateMatrixCredentialJson(fileResult.json, fileResult.path);
    if (validated.status !== "ok") {
      return validated;
    }
    const envAllowed = normalizeCsv(env.MATRIX_USER_ID);
    const dbAllowed = await readAllowlistFromDb(context, registration.bot_user_id);
    return {
      status: "ok",
      credentials: {
        homeserverUrl: validated.credentials.homeserverUrl,
        accessToken: validated.credentials.accessToken,
        userId: validated.credentials.userId,
        deviceId: validated.credentials.deviceId,
        allowedUserIds: mergeAllowed(
          envAllowed,
          validated.credentials.allowedUserIds,
          dbAllowed
        ),
        allowedRoomIds: validated.credentials.allowedRoomIds ?? [],
        autoJoinInvites: validated.credentials.autoJoinInvites ?? false,
        encryptedRoomPolicy: validated.credentials.encryptedRoomPolicy ?? "decline"
      }
    };
  }
  async probeIdentity(credentials) {
    const parsed = parseResolvedCredentials(credentials);
    const identity = await probeMatrixIdentity(
      parsed.homeserverUrl,
      parsed.accessToken,
      parsed.userId,
      this.options.identityClient
    );
    return {
      accountId: identity.user_id,
      accountUsername: identity.localpart
    };
  }
  create(credentials, accountId, context) {
    const parsed = parseResolvedCredentials(credentials);
    return new MatrixCommAdapter({
      homeserverUrl: parsed.homeserverUrl,
      accessToken: parsed.accessToken,
      userId: parsed.userId,
      accountId,
      deviceId: parsed.deviceId,
      allowedUserIds: parsed.allowedUserIds,
      allowedRoomIds: parsed.allowedRoomIds,
      autoJoinInvites: parsed.autoJoinInvites,
      encryptedRoomPolicy: parsed.encryptedRoomPolicy,
      attachmentBlobStore: context?.blobs
    });
  }
  ipcMethods(deps) {
    return /* @__PURE__ */ new Map([
      [
        "matrix_send",
        async (params) => sendMatrix(deps, params, false)
      ],
      [
        "matrix_send_image",
        async (params) => sendMatrix(deps, params, true)
      ]
    ]);
  }
};
function createCommAdapterFactory(options) {
  return new MatrixCommAdapterFactory(options);
}
var IMAGE_EXTENSION_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp"
};
function inferImageMimeFromPath(localPath) {
  const ext = path2.extname(localPath).slice(1).toLowerCase();
  return IMAGE_EXTENSION_MIME[ext] ?? "application/octet-stream";
}
async function sendMatrix(deps, params, image) {
  const chatNativeId = extractChatNativeId(params);
  const target = chatNativeId === null ? void 0 : await targetFromParams(deps.storage, params, chatNativeId);
  const localPath = image ? String(params.path) : null;
  const sent = await deps.bus.send({
    session: String(params.session ?? "mcp"),
    comm: MATRIX_COMM_ID,
    target,
    payload: image ? {
      text: typeof params.caption === "string" ? params.caption : void 0,
      attachments: [
        {
          filename: uploadFilenameFromLocalPath(localPath),
          local_path: localPath,
          mime: inferImageMimeFromPath(localPath),
          size: 0
        }
      ]
    } : { text: String(params.message ?? "") },
    idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey : void 0
  });
  return { message_id: sent };
}
function extractChatNativeId(params) {
  if (params.room_id != null) return String(params.room_id);
  const target = params.target;
  if (target && typeof target === "object" && "chat_native_id" in target) {
    const value = target.chat_native_id;
    if (value != null) return String(value);
  }
  if (target && typeof target === "object" && "room_id" in target) {
    const value = target.room_id;
    if (value != null) return String(value);
  }
  return null;
}
async function targetFromParams(storage, params, chatNativeId) {
  const explicitAccount = extractTargetAccount(params);
  if (explicitAccount != null) {
    rejectAccountLabel(explicitAccount);
    return {
      comm: MATRIX_COMM_ID,
      account: explicitAccount,
      chat_native_id: chatNativeId
    };
  }
  const session = typeof params.session === "string" ? await storage.getSession(params.session) : null;
  const scoped = session ? await storage.listAccountRegistrations({
    project: session.project,
    comm: MATRIX_COMM_ID,
    agent: session.agent
  }) : [];
  const registration = scoped[0] ?? (await storage.listAccountRegistrations({ comm: MATRIX_COMM_ID }))[0];
  if (!registration) {
    throw new Error("no Matrix account registration exists; run agents-comm account-add first");
  }
  return {
    comm: MATRIX_COMM_ID,
    account: registration.bot_user_id,
    chat_native_id: chatNativeId
  };
}
function extractTargetAccount(params) {
  const target = params.target;
  if (target && typeof target === "object" && "account" in target) {
    const value = target.account;
    if (value != null) return String(value);
  }
  return void 0;
}
function rejectAccountLabel(account) {
  if (!isMatrixMxid(account)) {
    throw new Error(
      `target.account "${account}" is not a Matrix MXID \u2014 labels like "main" are not accepted; use the concrete bot_user_id (MXID) from account-add or list_conversations`
    );
  }
}
function parseResolvedCredentials(credentials) {
  const homeserverUrl = typeof credentials.homeserverUrl === "string" ? credentials.homeserverUrl : null;
  const accessToken = typeof credentials.accessToken === "string" ? credentials.accessToken : null;
  const userId = typeof credentials.userId === "string" ? credentials.userId : null;
  if (!homeserverUrl || !accessToken || !userId) {
    throw new Error(
      "MatrixCommAdapterFactory: credentials.homeserverUrl, accessToken, and userId are required"
    );
  }
  return {
    homeserverUrl,
    accessToken,
    userId,
    deviceId: typeof credentials.deviceId === "string" ? credentials.deviceId : void 0,
    allowedUserIds: normalizeStringArray(credentials.allowedUserIds),
    allowedRoomIds: normalizeStringArray(credentials.allowedRoomIds),
    autoJoinInvites: credentials.autoJoinInvites === true,
    encryptedRoomPolicy: credentials.encryptedRoomPolicy === "decline" ? "decline" : "decline"
  };
}
function normalizeHomeserverUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return void 0;
  return trimmed.replace(/\/+$/, "");
}
function normalizeStringArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}
function normalizeCsv(value) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
function mergeAllowed(fromEnv, fromFile, fromDb = void 0) {
  const out = [...fromEnv];
  const sources = [fromFile, fromDb];
  for (const source of sources) {
    if (!source) continue;
    for (const id of source) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}
async function readAllowlistFromDb(context, bot_user_id) {
  if (!context?.storage) return [];
  const [globals, perBot] = await Promise.all([
    context.storage.listAllowlistGlobal({ comm: MATRIX_COMM_ID }),
    context.storage.listAllowlistPerBot({ comm: MATRIX_COMM_ID, bot_user_id })
  ]);
  const out = [];
  for (const row of globals) {
    if (!out.includes(row.sender_id)) out.push(row.sender_id);
  }
  for (const row of perBot) {
    if (!out.includes(row.sender_id)) out.push(row.sender_id);
  }
  return out;
}
function validateMatrixCredentialJson(json, path3) {
  const parsed = json;
  const homeserverUrl = typeof parsed.homeserverUrl === "string" ? normalizeHomeserverUrl(parsed.homeserverUrl) : void 0;
  if (!homeserverUrl) {
    return {
      status: "invalid",
      failureKind: "missing_field",
      reason: "missing required field: homeserverUrl",
      path: path3
    };
  }
  const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : void 0;
  if (!accessToken) {
    return {
      status: "invalid",
      failureKind: "missing_field",
      reason: "missing required field: accessToken",
      path: path3
    };
  }
  const userId = typeof parsed.userId === "string" ? parsed.userId.trim() : void 0;
  if (!userId) {
    return {
      status: "invalid",
      failureKind: "missing_field",
      reason: "missing required field: userId",
      path: path3
    };
  }
  if (!isMatrixMxid(userId)) {
    return {
      status: "invalid",
      failureKind: "validation",
      reason: "userId is not a valid Matrix MXID",
      path: path3
    };
  }
  const encryptedRoomPolicy = parsed.encryptedRoomPolicy === "decline" ? "decline" : parsed.encryptedRoomPolicy == null ? "decline" : void 0;
  if (encryptedRoomPolicy == null) {
    return {
      status: "invalid",
      failureKind: "validation",
      reason: 'encryptedRoomPolicy must be "decline" when set',
      path: path3
    };
  }
  return {
    status: "ok",
    credentials: {
      homeserverUrl,
      accessToken,
      userId,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : void 0,
      allowedUserIds: normalizeStringArray(parsed.allowedUserIds),
      allowedRoomIds: normalizeStringArray(parsed.allowedRoomIds),
      autoJoinInvites: parsed.autoJoinInvites === true,
      encryptedRoomPolicy
    }
  };
}
export {
  MatrixCommAdapterFactory,
  createCommAdapterFactory,
  inferImageMimeFromPath
};
