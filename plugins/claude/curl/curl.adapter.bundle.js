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
import crypto from "node:crypto";
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

// ../adapters/curl/adapter.ts
var CURL_LOOPBACK_HOST = "127.0.0.1";
var CURL_MESSAGES_PATH = "/messages";
var DEFAULT_MAX_BODY_BYTES = 256 * 1024;
function syntheticChatNativeId(senderId) {
  return `curl:${senderId}`;
}
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
  return {
    body: {
      project: record.project,
      agent: record.agent,
      sender_id: record.sender_id.trim(),
      text: record.text,
      chat_native_id: typeof record.chat_native_id === "string" && record.chat_native_id.length > 0 ? record.chat_native_id : void 0,
      metadata: record.metadata
    }
  };
}
function isAuthorizedCurlRequest(authorizationHeader, token) {
  const match = /^Bearer\s+(.+)$/.exec(authorizationHeader ?? "");
  if (!match) return false;
  const presented = crypto.createHash("sha256").update(match[1]).digest();
  const expected = crypto.createHash("sha256").update(token).digest();
  return crypto.timingSafeEqual(presented, expected);
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
    const uuid = crypto.randomUUID();
    const chatNativeId = body.chat_native_id ?? syntheticChatNativeId(body.sender_id);
    const message = {
      schema_version: 1,
      message_id: `curl:${uuid}`,
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
      platform_message_id: uuid,
      hop_count: 0,
      received_at: this.now()
    };
    if (body.metadata) {
      message.metadata = body.metadata;
    }
    const acceptance = await handler(message);
    this.respondJson(res, 202, {
      ok: true,
      message_id: message.message_id,
      conversation_id: acceptance && typeof acceptance === "object" ? acceptance.conversation_id : void 0,
      chat_native_id: chatNativeId
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
      stateRoot: context?.stateRoot
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
