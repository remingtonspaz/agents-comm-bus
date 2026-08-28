import WebSocket, { type RawData } from "ws";

import { normalizeProjectPath } from "../../project-path.js";

export const DEFAULT_CODEX_APP_SERVER_URL = "ws://127.0.0.1:4500";

const CLIENT_INFO = {
  name: "agents-comm-bus-codex-bridge",
  version: "0.1.0",
};

export interface CodexRecordedTarget {
  threadId: string;
  expectedProject: string;
}

export type CodexTargetValidationResult =
  | { ok: true; threadId: string; cwd: string }
  | {
      ok: false;
      reason:
        | "missing-recorded-target"
        | "listThreads-failed"
        | "recorded-thread-absent"
        | "recorded-thread-not-live"
        | "recorded-thread-wrong-project"
        | "recorded-thread-missing-cwd";
      error?: string;
      threadId?: string;
      raw?: string;
      url?: string;
    };

export interface CodexAppServerClient {
  call(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  listThreads(): Promise<unknown>;
  listThreadTurns(threadId: string): Promise<unknown>;
  startTurn(threadId: string, text: string): Promise<unknown>;
  steerTurn(threadId: string, text: string, expectedTurnId: string): Promise<unknown>;
  validateRecordedTarget(target: CodexRecordedTarget): Promise<CodexTargetValidationResult>;
  wakeRecordedTarget(target: CodexRecordedTarget, text?: string): Promise<CodexTurnResult>;
  steerRecordedTarget(target: CodexRecordedTarget, text: string): Promise<CodexTurnResult>;
}

export type CodexTurnResult =
  | {
      ok: true;
      threadId: string;
      method: "turn/start" | "turn/steer";
      fallbackFrom?: { ok: false; reason: string; error?: string; threadId?: string; raw?: string; url?: string };
    }
  | { ok: false; reason: string; error?: string; threadId?: string; raw?: string; url?: string };

export class WebSocketCodexAppServerClient implements CodexAppServerClient {
  constructor(private readonly url = DEFAULT_CODEX_APP_SERVER_URL) {}

  call(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<unknown> {
    return callOnce(this.url, method, params, options);
  }

  listThreads(): Promise<unknown> {
    return this.call("thread/list", {});
  }

  listThreadTurns(threadId: string): Promise<unknown> {
    return this.call("thread/turns/list", { threadId });
  }

  startTurn(threadId: string, text: string): Promise<unknown> {
    return this.call("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
  }

  steerTurn(threadId: string, text: string, expectedTurnId: string): Promise<unknown> {
    return this.call("turn/steer", {
      threadId,
      expectedTurnId,
      input: [{ type: "text", text }],
    });
  }

  async validateRecordedTarget(target: CodexRecordedTarget): Promise<CodexTargetValidationResult> {
    if (!target.threadId || !target.expectedProject) {
      return { ok: false, reason: "missing-recorded-target", threadId: target.threadId };
    }

    let result: unknown;
    try {
      result = await this.listThreads();
    } catch (error) {
      return {
        ok: false,
        reason: "listThreads-failed",
        error: error instanceof Error ? error.message : String(error),
        threadId: target.threadId,
        url: this.url,
      };
    }

    const threads = listedThreads(result);
    const match = threads.find((entry) => threadIdFrom(entry) === target.threadId);
    if (!match) {
      return {
        ok: false,
        reason: "recorded-thread-absent",
        threadId: target.threadId,
        raw: stringifyShort(result),
      };
    }

    const statusType = threadStatusType(match);
    if (!isLiveThreadStatus(statusType)) {
      return {
        ok: false,
        reason: "recorded-thread-not-live",
        threadId: target.threadId,
        raw: stringifyShort(match),
      };
    }

    const cwd = threadCwd(match);
    if (!cwd) {
      return {
        ok: false,
        reason: "recorded-thread-missing-cwd",
        threadId: target.threadId,
        raw: stringifyShort(match),
      };
    }

    if (normalizeProjectPath(cwd) !== normalizeProjectPath(target.expectedProject)) {
      return {
        ok: false,
        reason: "recorded-thread-wrong-project",
        threadId: target.threadId,
        raw: stringifyShort(match),
      };
    }

    return { ok: true, threadId: target.threadId, cwd };
  }

  async wakeRecordedTarget(
    target: CodexRecordedTarget,
    text = ".",
  ): Promise<CodexTurnResult> {
    const validated = await this.validateRecordedTarget(target);
    if (!validated.ok) return validated;
    try {
      await this.startTurn(validated.threadId, text);
      return { ok: true, threadId: validated.threadId, method: "turn/start" };
    } catch (error) {
      return {
        ok: false,
        reason: "startTurn-failed",
        error: error instanceof Error ? error.message : String(error),
        threadId: validated.threadId,
      };
    }
  }

  async steerRecordedTarget(target: CodexRecordedTarget, text: string): Promise<CodexTurnResult> {
    const validated = await this.validateRecordedTarget(target);
    if (!validated.ok) return validated;
    const turn = await this.activeTurn(validated.threadId);
    if (!turn.ok) return turn;
    try {
      await this.steerTurn(validated.threadId, text, turn.turnId);
      return { ok: true, threadId: validated.threadId, method: "turn/steer" };
    } catch (error) {
      return {
        ok: false,
        reason: "steerTurn-failed",
        error: error instanceof Error ? error.message : String(error),
        threadId: validated.threadId,
      };
    }
  }

  private async activeTurn(threadId: string): Promise<
    | { ok: true; turnId: string }
    | { ok: false; reason: string; error?: string; threadId?: string; raw?: string; url?: string }
  > {
    let result: unknown;
    try {
      result = await this.listThreadTurns(threadId);
    } catch (error) {
      return {
        ok: false,
        reason: "listThreadTurns-failed",
        error: error instanceof Error ? error.message : String(error),
        threadId,
        url: this.url,
      };
    }

    const turns = listedTurns(result);
    if (turns.length === 0) {
      return {
        ok: false,
        reason: "no-turns-loaded",
        raw: stringifyShort(result),
        threadId,
      };
    }

    const active = turns.find((turn) => turnStatus(turn) === "inProgress") ?? turns[0];
    const turnId = turnIdFrom(active);
    if (!turnId) {
      return {
        ok: false,
        reason: "no-turn-id-in-response",
        raw: stringifyShort(active),
        threadId,
      };
    }
    return { ok: true, turnId };
  }
}

function callOnce(
  url: string,
  method: string,
  params: unknown,
  { timeoutMs = 5_000 }: { timeoutMs?: number } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      reject(error);
      return;
    }

    const initId = 1;
    const callId = 2;
    let settled = false;
    let initialized = false;

    const timer = setTimeout(() => {
      finish(new Error(`app-server JSON-RPC timeout after ${timeoutMs}ms (method=${method}, url=${url})`));
    }, timeoutMs);

    function finish(error: Error | null, value?: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Ignore close failures on a failing one-shot call.
      }
      if (error) reject(error);
      else resolve(value);
    }

    ws.on("open", () => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } },
      }));
    });

    ws.on("message", (data: RawData) => {
      const message = parseJsonMessage(data);
      if (!message) return;
      if (message.id === initId) {
        if (message.error) {
          finish(new Error(`app-server initialize failed: ${message.error.code} ${message.error.message ?? ""}`));
          return;
        }
        initialized = true;
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: callId, method, params }));
        return;
      }
      if (message.id === callId) {
        if (message.error) {
          finish(new Error(`app-server JSON-RPC error ${message.error.code}: ${message.error.message ?? ""}`));
        } else {
          finish(null, message.result);
        }
      }
    });

    ws.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    ws.on("close", () => {
      if (!settled) {
        finish(new Error(initialized
          ? "app-server connection closed after initialize but before reply"
          : "app-server connection closed before initialize completed"));
      }
    });
  });
}

function listedThreads(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const candidate = record.data ?? record.threads ?? record.items ?? record.loaded;
  return Array.isArray(candidate) ? candidate : [];
}

function listedTurns(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;
  const candidate = record.data ?? record.turns ?? record.items;
  return Array.isArray(candidate) ? candidate : [];
}

function threadIdFrom(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = record.threadId ?? record.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function threadCwd(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const cwd = (value as Record<string, unknown>).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

function threadStatusType(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const status = (value as Record<string, unknown>).status;
  if (!status || typeof status !== "object") return null;
  const type = (status as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

export function isLiveThreadStatus(statusType: string | null): boolean {
  return statusType === "active" || statusType === "idle";
}

function turnIdFrom(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = record.turnId ?? record.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function turnStatus(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}

function parseJsonMessage(data: RawData): Record<string, any> | null {
  try {
    const value = JSON.parse(data.toString());
    return value && typeof value === "object" ? value as Record<string, any> : null;
  } catch {
    return null;
  }
}

function stringifyShort(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}
