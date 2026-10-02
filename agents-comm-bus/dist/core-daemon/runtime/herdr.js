import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const execFileAsync = promisify(execFile);
export function normalizeHerdrSocketPath(socketPath) {
    const resolved = path.resolve(socketPath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
export function herdrSessionId(identity) {
    const socket = normalizeHerdrSocketPath(identity.socket_path);
    const digest = crypto
        .createHash("sha256")
        .update(`${identity.agent}\n${socket}\n${identity.pane_id}`)
        .digest("hex")
        .slice(0, 24);
    return `herdr_${digest}`;
}
export function parseHerdrIdentity(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const record = raw;
    if (record.type !== "herdr")
        return null;
    const agent = record.agent;
    const pane_id = record.pane_id;
    const socket_path = record.socket_path;
    if (typeof agent !== "string" || agent.trim() === "")
        return null;
    if (typeof pane_id !== "string" || pane_id.trim() === "")
        return null;
    if (typeof socket_path !== "string" || socket_path.trim() === "")
        return null;
    const identity = {
        type: "herdr",
        agent: agent,
        pane_id,
        socket_path,
    };
    if (typeof record.workspace_id === "string" && record.workspace_id.length > 0) {
        identity.workspace_id = record.workspace_id;
    }
    if (typeof record.tab_id === "string" && record.tab_id.length > 0) {
        identity.tab_id = record.tab_id;
    }
    if (typeof record.bin_path === "string" && record.bin_path.length > 0) {
        identity.bin_path = record.bin_path;
    }
    return identity;
}
export function parseHerdrIdentityJson(json) {
    if (!json)
        return null;
    try {
        return parseHerdrIdentity(JSON.parse(json));
    }
    catch {
        return null;
    }
}
const DEFAULT_TIMEOUT_MS = 5000;
export class HerdrClient {
    identity;
    options;
    constructor(identity, options = {}) {
        this.identity = identity;
        this.options = options;
    }
    async agentGet() {
        const parsed = await this.runJson(["agent", "get", this.identity.pane_id]);
        if (!parsed.ok)
            return parsed;
        const result = parsed.data;
        const agent = result?.result?.agent;
        if (!agent || typeof agent !== "object") {
            return { ok: true, data: null };
        }
        const pane_id = typeof agent.pane_id === "string" ? agent.pane_id : this.identity.pane_id;
        const kind = typeof agent.agent === "string" ? agent.agent : "";
        return {
            ok: true,
            data: {
                pane_id,
                agent: kind,
                agent_status: typeof agent.agent_status === "string" ? agent.agent_status : undefined,
                cwd: typeof agent.cwd === "string" ? agent.cwd : undefined,
                name: typeof agent.name === "string" ? agent.name : undefined,
            },
        };
    }
    async agentPrompt(text) {
        return this.runJson(["agent", "prompt", this.identity.pane_id, text]);
    }
    async agentSendKeys(...keys) {
        return this.runJson(["agent", "send-keys", this.identity.pane_id, ...keys]);
    }
    async paneSendText(text) {
        return this.runJson(["pane", "send-text", this.identity.pane_id, text]);
    }
    async runJson(args) {
        const env = {
            ...(this.options.env ?? process.env),
            HERDR_SOCKET_PATH: this.identity.socket_path,
        };
        const bin = this.options.resolveBin?.(this.identity, env) ??
            resolveHerdrBin(this.identity, env);
        const execFn = this.options.execFile ?? defaultExecFile;
        try {
            const { stdout } = await execFn(bin, args, {
                env,
                timeout: DEFAULT_TIMEOUT_MS,
                windowsHide: true,
            });
            const trimmed = stdout.trim();
            if (!trimmed)
                return { ok: true, data: {} };
            return { ok: true, data: JSON.parse(trimmed) };
        }
        catch (error) {
            return parseHerdrExecFailure(error);
        }
    }
}
function defaultExecFile(file, args, options) {
    return execFileAsync(file, args, {
        env: options.env,
        timeout: options.timeout,
        windowsHide: options.windowsHide,
    });
}
export function resolveHerdrBin(identity, env = process.env) {
    if (identity.bin_path)
        return identity.bin_path;
    const fromEnv = env.AGENTS_COMM_BUS_HERDR_BIN;
    if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
        return fromEnv.trim();
    }
    return process.platform === "win32" ? "herdr.exe" : "herdr";
}
function parseHerdrExecFailure(error) {
    const err = error;
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    if (stderr) {
        try {
            const parsed = JSON.parse(stderr);
            if (parsed.error?.code) {
                return {
                    ok: false,
                    code: parsed.error.code,
                    message: parsed.error.message ?? parsed.error.code,
                };
            }
        }
        catch {
            /* fall through */
        }
    }
    return {
        ok: false,
        code: err.code ?? "herdr_cli_failed",
        message: err.message ?? String(error),
    };
}
export async function validateHerdrIdentityAgent(client, identity) {
    const got = await client.agentGet();
    if (!got.ok) {
        return { ok: false, reason: `herdr_agent_get_failed:${got.code}` };
    }
    if (!got.data) {
        return { ok: false, reason: "herdr_pane_missing" };
    }
    if (got.data.agent !== identity.agent) {
        return {
            ok: false,
            reason: `herdr_agent_mismatch:${got.data.agent}`,
        };
    }
    return { ok: true };
}
//# sourceMappingURL=herdr.js.map