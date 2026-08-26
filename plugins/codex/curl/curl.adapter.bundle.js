import { createRequire as __acbCreateRequire } from 'module'; const require = __acbCreateRequire(import.meta.url);

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

// ../adapters/curl/adapter.ts
import crypto2 from "node:crypto";
import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path2 from "node:path";

// ../core-daemon/project-path.ts
import path from "node:path";
function normalizeProjectPath(project) {
  let resolved = path.resolve(project);
  if (path.sep === "\\") {
    resolved = resolved.replace(/\//g, "\\");
  } else {
    resolved = resolved.replace(/\\/g, "/");
  }
  if (/^[A-Za-z]:/.test(resolved)) {
    resolved = resolved[0].toUpperCase() + resolved.slice(1);
  }
  const isBareRoot = resolved === path.sep || path.sep === "\\" && /^[A-Za-z]:\\$/.test(resolved);
  if (resolved.length > 1 && resolved.endsWith(path.sep) && !isBareRoot) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

// ../core-daemon/runtime/inbound-message-context.ts
var INBOUND_MESSAGE_CONTEXT_KEY = "__agents_comm_bus_inbound_context";
function attachInboundMessageContext(message, context) {
  Object.defineProperty(message, INBOUND_MESSAGE_CONTEXT_KEY, {
    value: context,
    enumerable: false,
    configurable: true,
    writable: true
  });
  return message;
}

// ../adapters/curl/idempotency.ts
import crypto from "node:crypto";
function syntheticChatNativeId(senderId) {
  return `curl:${senderId}`;
}
var CURL_IDEMPOTENCY_KEY_MAX_LENGTH = 128;
var DEFAULT_CURL_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
function curlReceiptTtlMs(env = process.env) {
  const raw = env.CURL_IDEMPOTENCY_RECEIPT_TTL_MS;
  if (raw == null || raw.trim() === "") return DEFAULT_CURL_RECEIPT_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CURL_RECEIPT_TTL_MS;
  }
  return Math.floor(parsed);
}
function validateCurlIdempotencyKey(raw) {
  if (typeof raw !== "string") {
    return { error: "body.idempotency_key must be a string when present" };
  }
  const key = raw.trim();
  if (key.length === 0) {
    return { error: "body.idempotency_key must be a non-empty string" };
  }
  if (key.length > CURL_IDEMPOTENCY_KEY_MAX_LENGTH) {
    return {
      error: `body.idempotency_key must be at most ${CURL_IDEMPOTENCY_KEY_MAX_LENGTH} characters`
    };
  }
  if (!/^[\x20-\x7E]+$/.test(key)) {
    return { error: "body.idempotency_key must contain only printable ASCII characters" };
  }
  return { key };
}
var METADATA_UNSUPPORTED = "body.metadata must contain only JSON values (null, boolean, number, string, object, array)";
function validateCurlMetadata(raw) {
  if (raw == null) return { metadata: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body.metadata must be a JSON object when present" };
  }
  try {
    return { metadata: canonicalizeJsonValue(raw) };
  } catch {
    return { error: METADATA_UNSUPPORTED };
  }
}
function canonicalizeJsonValue(value) {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(METADATA_UNSUPPORTED);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (kind === "object") {
    const record = value;
    const keys = Object.keys(record).sort();
    const out = {};
    for (const key of keys) {
      const nested = record[key];
      if (nested === void 0) {
        throw new Error(METADATA_UNSUPPORTED);
      }
      out[key] = canonicalizeJsonValue(nested);
    }
    return out;
  }
  throw new Error(METADATA_UNSUPPORTED);
}
function curlIdempotencyScopeKey(scope) {
  return JSON.stringify([scope.registration_id, scope.sender_id, scope.client_key]);
}
function curlRequestHash(input) {
  const effectiveChat = input.chat_native_id ?? syntheticChatNativeId(input.sender_id);
  const canonical = {
    project: normalizeProjectPath(input.project),
    agent: input.agent,
    sender_id: input.sender_id,
    text: input.text,
    chat_native_id: effectiveChat,
    metadata: input.metadata ? canonicalizeJsonValue(input.metadata) : null
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ../adapters/curl/adapter.ts
var CURL_LOOPBACK_HOST = "127.0.0.1";
var CURL_MESSAGES_PATH = "/messages";
var DEFAULT_MAX_BODY_BYTES = 256 * 1024;
function sanitizeAccountIdForPath(accountId) {
  return accountId.replace(/[^A-Za-z0-9._-]+/g, "-");
}
function curlEndpointFilePath(stateRoot, accountId) {
  return path2.join(stateRoot, "curl", sanitizeAccountIdForPath(accountId), "endpoint.json");
}
function parseCurlPostBody(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "body must be a JSON object" };
  }
  const record = raw;
  for (const field of ["project", "agent", "sender_id", "text"]) {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      return { error: `body.${field} is required and must be a non-empty string` };
    }
  }
  if (record.chat_native_id != null && typeof record.chat_native_id !== "string") {
    return { error: "body.chat_native_id must be a string when present" };
  }
  if (record.metadata != null && (typeof record.metadata !== "object" || Array.isArray(record.metadata))) {
    return { error: "body.metadata must be a JSON object when present" };
  }
  let metadata;
  if (record.metadata != null) {
    const validatedMetadata = validateCurlMetadata(record.metadata);
    if ("error" in validatedMetadata) return validatedMetadata;
    metadata = Object.keys(validatedMetadata.metadata).length > 0 ? validatedMetadata.metadata : void 0;
  }
  let idempotency_key;
  if (record.idempotency_key != null) {
    const validated = validateCurlIdempotencyKey(record.idempotency_key);
    if ("error" in validated) return validated;
    idempotency_key = validated.key;
  }
  return {
    body: {
      project: record.project,
      agent: record.agent,
      sender_id: record.sender_id.trim(),
      text: record.text,
      chat_native_id: typeof record.chat_native_id === "string" && record.chat_native_id.length > 0 ? record.chat_native_id : void 0,
      metadata,
      idempotency_key
    }
  };
}
function isAuthorizedCurlRequest(authorizationHeader, token) {
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader ?? "");
  if (!match) return false;
  const presented = crypto2.createHash("sha256").update(match[1]).digest();
  const expected = crypto2.createHash("sha256").update(token).digest();
  return crypto2.timingSafeEqual(presented, expected);
}
var CurlCommAdapter = class {
  constructor(options) {
    this.options = options;
    if (!options.token) {
      throw new Error("CurlCommAdapter: a non-empty token is required");
    }
    this.accountId = options.accountId;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.error(message));
    this.filterTrace = options.filterTrace ?? process.env.AGENTS_COMM_BUS_FILTER_TRACE === "1";
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.normalizedProject = normalizeProjectPath(options.project);
    this.allowedSenders = new Set(options.allowedSenderIds ?? []);
  }
  options;
  id = "curl";
  accountId;
  now;
  log;
  filterTrace;
  maxBodyBytes;
  normalizedProject;
  allowedSenders;
  inboundHandler = null;
  filterDropHandler = null;
  stateHandler = null;
  connectionState = null;
  server = null;
  boundPort = null;
  inflightByScope = /* @__PURE__ */ new Map();
  get allowedSenderIds() {
    return Array.from(this.allowedSenders);
  }
  updateAllowedSenderIds(ids) {
    this.allowedSenders = new Set(ids);
  }
  /** Bound loopback port once started (ephemeral binds resolve here). */
  get port() {
    return this.boundPort;
  }
  /**
   * One live HTTP listener per registration: a second daemon serving the same
   * curl account would race for the port (or silently split discovery files),
   * so the account id is the exclusive single-consumer resource.
   */
  exclusiveResource() {
    return { resourceId: String(this.accountId) };
  }
  async start() {
    this.emitState("connecting");
    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        this.respondJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    });
    await new Promise((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(this.options.port ?? 0, CURL_LOOPBACK_HOST, () => {
        server.removeListener("error", rejectPromise);
        resolvePromise();
      });
    });
    this.server = server;
    this.boundPort = server.address().port;
    await this.writeEndpointFile();
    this.emitState("connected");
  }
  async stop() {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    }
    await this.removeEndpointFile();
    this.boundPort = null;
    this.emitState("disconnected");
  }
  onInbound(handler) {
    this.inboundHandler = handler;
  }
  onFilterDrop(handler) {
    this.filterDropHandler = handler;
  }
  onConnectionState(handler) {
    this.stateHandler = handler;
    if (this.connectionState) {
      handler(this.connectionState);
    }
  }
  /**
   * V1 is inbound-only by spec: there is no caller to deliver outbound to —
   * the HTTP exchange is over by the time an agent replies. Loud diagnostic
   * instead of a silent no-op so a misrouted `bus.send` is debuggable.
   */
  async send(target, _payload, _idempotencyKey) {
    throw new Error(
      `agents-comm-bus curl[${this.accountId}]: outbound send to chat=${target.chat_native_id} is not supported \u2014 the curl adapter is local inbound-only (AGE-50 V1). Reply over a bidirectional comm (e.g. telegram/discord/matrix) instead.`
    );
  }
  reportPressure() {
    return { backlog: 0, rateLimited: false };
  }
  classifyFailure() {
    return "permanent";
  }
  async handleRequest(req, res) {
    const pathname = new URL(req.url ?? "/", `http://${CURL_LOOPBACK_HOST}`).pathname;
    if (pathname !== CURL_MESSAGES_PATH) {
      this.respondJson(res, 404, { ok: false, error: `unknown path ${pathname}; POST ${CURL_MESSAGES_PATH}` });
      return;
    }
    if (req.method !== "POST") {
      this.respondJson(res, 405, { ok: false, error: `method ${req.method} not allowed; use POST` });
      return;
    }
    if (!isAuthorizedCurlRequest(req.headers.authorization, this.options.token)) {
      this.emitFilterDrop({
        reason: "unauthorized",
        update_kind: "http_post",
        chat_native_id: void 0
      });
      this.respondJson(res, 401, {
        ok: false,
        error: "unauthorized: present the registration token as 'Authorization: Bearer <token>'"
      });
      return;
    }
    const rawBody = await this.readBody(req);
    if (rawBody === null) {
      this.respondJson(res, 413, { ok: false, error: `body exceeds ${this.maxBodyBytes} bytes` });
      return;
    }
    let decoded;
    try {
      decoded = JSON.parse(rawBody.toString("utf8"));
    } catch {
      this.respondJson(res, 400, { ok: false, error: "body is not valid JSON" });
      return;
    }
    const parsed = parseCurlPostBody(decoded);
    if ("error" in parsed) {
      this.respondJson(res, 400, { ok: false, error: parsed.error });
      return;
    }
    const body = parsed.body;
    if (normalizeProjectPath(body.project) !== this.normalizedProject || body.agent !== this.options.agent) {
      this.respondJson(res, 404, {
        ok: false,
        error: `this curl endpoint serves project=${this.normalizedProject}, agent=${this.options.agent} (got project=${body.project}, agent=${body.agent}); register a curl account for that scope and POST to its endpoint`
      });
      return;
    }
    if (this.allowedSenders.size > 0 && !this.allowedSenders.has(body.sender_id)) {
      this.emitFilterDrop({
        reason: "sender_not_allowed",
        update_kind: "http_post",
        sender_id: body.sender_id,
        chat_native_id: body.chat_native_id ?? syntheticChatNativeId(body.sender_id)
      });
      this.respondJson(res, 403, {
        ok: false,
        error: `sender_id ${body.sender_id} is not in this account's allowlist; fix with 'agents-comm allowlist add'`
      });
      return;
    }
    this.traceFilterPass(body.sender_id);
    const handler = this.inboundHandler;
    if (!handler) {
      this.respondJson(res, 503, { ok: false, error: "adapter not attached to the bus yet; retry" });
      return;
    }
    if (body.idempotency_key) {
      await this.handleIdempotentPost(res, body, handler);
      return;
    }
    const acceptance = await this.dispatchInbound(body, handler, crypto2.randomUUID());
    this.respondAccepted(res, acceptance, body);
  }
  async handleIdempotentPost(res, body, handler) {
    const storage = this.options.storage;
    const registrationId = this.options.registrationId;
    if (!storage || !registrationId) {
      this.respondJson(res, 503, {
        ok: false,
        error: "idempotency_key requires daemon storage wiring; retry after adapter reload"
      });
      return;
    }
    const scopeKey = curlIdempotencyScopeKey({
      registration_id: registrationId,
      sender_id: body.sender_id,
      client_key: body.idempotency_key
    });
    const requestHash = curlRequestHash({
      project: body.project,
      agent: body.agent,
      sender_id: body.sender_id,
      text: body.text,
      chat_native_id: body.chat_native_id,
      metadata: body.metadata
    });
    const existing = this.inflightByScope.get(scopeKey);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        this.respondJson(res, 409, {
          ok: false,
          error: "idempotency_key was already used with a different request body"
        });
        return;
      }
      const result = await existing.work;
      this.respondJson(res, result.status, result.payload);
      return;
    }
    const work = this.processIdempotentPost(body, handler, storage, registrationId, requestHash);
    this.inflightByScope.set(scopeKey, { requestHash, work });
    try {
      const result = await work;
      this.respondJson(res, result.status, result.payload);
    } finally {
      this.inflightByScope.delete(scopeKey);
    }
  }
  async processIdempotentPost(body, handler, storage, registrationId, requestHash) {
    const now = this.now();
    await storage.deleteExpiredCurlInboundReceipts(now);
    const scope = {
      registration_id: registrationId,
      sender_id: body.sender_id,
      client_key: body.idempotency_key
    };
    const ttlMs = this.options.receiptTtlMs ?? curlReceiptTtlMs();
    const reserve = await storage.reserveCurlInboundReceipt({
      ...scope,
      request_hash: requestHash,
      message_id: `curl:${crypto2.randomUUID()}`,
      reserved_at: now,
      expires_at: now + ttlMs
    });
    if (reserve.kind === "conflict") {
      return {
        status: 409,
        payload: {
          ok: false,
          error: "idempotency_key was already used with a different request body"
        }
      };
    }
    if (reserve.kind === "replay") {
      return {
        status: 202,
        payload: {
          ok: true,
          message_id: reserve.message_id,
          conversation_id: reserve.conversation_id ?? void 0,
          chat_native_id: body.chat_native_id ?? syntheticChatNativeId(body.sender_id)
        }
      };
    }
    const platformUuid = reserve.message_id.slice("curl:".length);
    const acceptance = await this.dispatchInbound(
      body,
      handler,
      platformUuid,
      reserve.message_id,
      scope
    );
    const accepted = await storage.acceptCurlInboundReceipt({
      ...scope,
      conversation_id: acceptance.conversation_id,
      accepted_at: this.now()
    });
    if (!accepted) {
      throw new Error(
        `curl idempotency accept failed: pending receipt missing for ${scope.registration_id}/${scope.sender_id}/${scope.client_key}`
      );
    }
    return {
      status: 202,
      payload: {
        ok: true,
        message_id: reserve.message_id,
        conversation_id: acceptance.conversation_id,
        chat_native_id: acceptance.chat_native_id
      }
    };
  }
  async dispatchInbound(body, handler, platformUuid, messageId, idempotencyScope) {
    const chatNativeId = body.chat_native_id ?? syntheticChatNativeId(body.sender_id);
    let message = {
      schema_version: 1,
      message_id: messageId ?? `curl:${platformUuid}`,
      chat: {
        comm: this.id,
        account: this.accountId,
        chat_native_id: chatNativeId
      },
      sender: {
        id: body.sender_id,
        isBot: false,
        isForeignBot: false
      },
      origin: { comm: this.id },
      text: body.text,
      platform_message_id: platformUuid,
      hop_count: 0,
      received_at: this.now()
    };
    if (body.metadata) {
      message.metadata = body.metadata;
    }
    if (idempotencyScope) {
      message = attachInboundMessageContext(message, {
        kind: "curl_idempotency",
        scope: idempotencyScope
      });
    }
    const acceptance = await handler(message);
    return {
      message_id: message.message_id,
      conversation_id: acceptance && typeof acceptance === "object" ? acceptance.conversation_id : void 0,
      chat_native_id: chatNativeId
    };
  }
  respondAccepted(res, acceptance, body) {
    this.respondJson(res, 202, {
      ok: true,
      message_id: acceptance.message_id,
      conversation_id: acceptance.conversation_id,
      chat_native_id: body.chat_native_id ?? syntheticChatNativeId(body.sender_id)
    });
  }
  readBody(req) {
    return new Promise((resolvePromise, rejectPromise) => {
      const chunks = [];
      let total = 0;
      req.on("data", (chunk) => {
        total += chunk.length;
        if (total > this.maxBodyBytes) {
          req.removeAllListeners("data");
          req.removeAllListeners("end");
          resolvePromise(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolvePromise(Buffer.concat(chunks)));
      req.on("error", rejectPromise);
    });
  }
  respondJson(res, status, payload) {
    if (res.headersSent) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(`${body}
`);
  }
  async writeEndpointFile() {
    if (!this.options.stateRoot || this.boundPort === null) return;
    const filePath = curlEndpointFilePath(this.options.stateRoot, String(this.accountId));
    try {
      await mkdir(path2.dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        `${JSON.stringify(
          {
            schema_version: 1,
            comm: this.id,
            account_id: this.accountId,
            project: this.normalizedProject,
            agent: this.options.agent,
            host: CURL_LOOPBACK_HOST,
            port: this.boundPort,
            url: `http://${CURL_LOOPBACK_HOST}:${this.boundPort}${CURL_MESSAGES_PATH}`,
            pid: process.pid,
            started_at: this.now()
          },
          null,
          2
        )}
`,
        "utf8"
      );
    } catch (error) {
      this.log(
        `agents-comm-bus curl[${this.accountId}]: failed to write endpoint file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async removeEndpointFile() {
    if (!this.options.stateRoot) return;
    const filePath = curlEndpointFilePath(this.options.stateRoot, String(this.accountId));
    try {
      await rm(filePath, { force: true });
    } catch {
    }
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
    if (this.filterTrace) {
      this.log(
        `agents-comm-bus curl[${this.accountId}] FILTER DROP: ${event.update_kind} sender=${event.sender_id ?? "<none>"} reason=${event.reason} (allowlist size=${this.allowedSenders.size})`
      );
    }
  }
  traceFilterPass(senderId) {
    if (!this.filterTrace) return;
    this.log(
      `agents-comm-bus curl[${this.accountId}] filter pass: http_post sender=${senderId} (allowlist size=${this.allowedSenders.size})`
    );
  }
};

// ../adapters/curl/factory.ts
var CURL_COMM_ID = "curl";
var DEFAULT_CURL_ACCOUNT_ID = "curl:local";
var CurlCommAdapterFactory = class {
  commId = CURL_COMM_ID;
  async resolveCredentials(registration, env, context) {
    const ref = registration.credentials_ref ?? "";
    if (!ref.startsWith("file:")) return { status: "absent" };
    const fileResult = await readCredentialFile(ref);
    if (fileResult.status !== "ok") {
      return fileResult;
    }
    const parsed = fileResult.json;
    const token = typeof parsed.botToken === "string" && parsed.botToken.trim().length > 0 ? parsed.botToken : typeof parsed.token === "string" && parsed.token.trim().length > 0 ? parsed.token : void 0;
    if (!token) {
      return {
        status: "invalid",
        failureKind: "missing_field",
        reason: "missing required field: token",
        path: fileResult.path
      };
    }
    const port = typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0 ? parsed.port : void 0;
    const envAllowed = normalizeCsv(env.CURL_SENDER_ID);
    const dbAllowed = await readAllowlistFromDb(context, registration.bot_user_id);
    const userId = normalizeUserIdField(parsed.userId);
    return {
      status: "ok",
      credentials: {
        token,
        port,
        project: registration.project,
        agent: registration.agent,
        allowedSenderIds: mergeAllowed(envAllowed, userId.length > 0 ? userId : void 0, dbAllowed)
      }
    };
  }
  async probeIdentity(credentials) {
    const token = typeof credentials.botToken === "string" ? credentials.botToken : null;
    if (!token || token.trim().length === 0) {
      throw new Error("CurlCommAdapterFactory.probeIdentity: credentials.botToken is required");
    }
    const explicit = typeof credentials.accountId === "string" ? credentials.accountId.trim() : "";
    if (explicit && /\s/.test(explicit)) {
      throw new Error(
        `CurlCommAdapterFactory.probeIdentity: explicit account id "${explicit}" must not contain whitespace`
      );
    }
    return {
      accountId: explicit || DEFAULT_CURL_ACCOUNT_ID,
      accountUsername: null
    };
  }
  create(credentials, accountId, context) {
    const token = typeof credentials.token === "string" ? credentials.token : null;
    const project = typeof credentials.project === "string" ? credentials.project : null;
    const agent = typeof credentials.agent === "string" ? credentials.agent : null;
    if (!token || !project || !agent) {
      throw new Error(
        "CurlCommAdapterFactory.create: credentials.token, project, and agent are required"
      );
    }
    const allowed = Array.isArray(credentials.allowedSenderIds) ? credentials.allowedSenderIds.map(String) : [];
    return new CurlCommAdapter({
      token,
      accountId,
      project,
      agent,
      port: typeof credentials.port === "number" && Number.isInteger(credentials.port) ? credentials.port : void 0,
      allowedSenderIds: allowed,
      stateRoot: context?.stateRoot,
      registrationId: context?.registrationId,
      storage: context?.storage
    });
  }
  /**
   * Outbound IPC surface exists only to fail loudly: the generic MCP shim
   * maps `comm_send_message` → `curl_send`, and without these handlers a
   * misrouted send dies with a cryptic "unknown method" instead of the
   * inbound-only diagnostic the spec calls for.
   */
  ipcMethods(_deps) {
    const rejectOutbound = (operation) => async () => {
      throw new Error(
        `curl comm is local inbound-only (AGE-50 V1): ${operation} is not supported. Inject context by POSTing to the local /messages endpoint; reply over a bidirectional comm (telegram/discord/matrix) instead.`
      );
    };
    return /* @__PURE__ */ new Map([
      ["curl_send", rejectOutbound("outbound send")],
      ["curl_send_image", rejectOutbound("outbound attachments")]
    ]);
  }
};
function createCommAdapterFactory() {
  return new CurlCommAdapterFactory();
}
function normalizeUserIdField(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((value) => typeof value === "string" || typeof value === "number" ? String(value) : "").map((value) => value.trim()).filter(Boolean);
  }
  if (typeof raw === "string") return [raw.trim()].filter(Boolean);
  if (typeof raw === "number") return [String(raw)];
  return [];
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
    context.storage.listAllowlistGlobal({ comm: CURL_COMM_ID }),
    context.storage.listAllowlistPerBot({ comm: CURL_COMM_ID, bot_user_id })
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
export {
  CurlCommAdapterFactory,
  DEFAULT_CURL_ACCOUNT_ID,
  createCommAdapterFactory
};
