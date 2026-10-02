import type { AuditStore, Session, Storage } from "agents-comm-bus-core";

import type { ClaudeWakeResponsePayload } from "../bridges/claude/wake.js";
import {
  HerdrClient,
  type HerdrIdentity,
  type HerdrWakeStrict,
  validateHerdrIdentityAgent,
} from "./herdr.js";
import { buildWakeSeed } from "./wake-seed.js";

export type WakeMode = "auto" | "native";
export type EffectiveWakeStrategy = "herdr" | "native";

export async function resolveWakeMode(
  storage: Storage,
  project: string,
  agent: Session["agent"],
): Promise<WakeMode> {
  return storage.getWakeMode(project, agent);
}

export function effectiveWakeStrategy(
  session: Session,
  mode: WakeMode,
): EffectiveWakeStrategy {
  if (!session.wake_identity) return "native";
  if (session.wake_strict === "herdr") return "herdr";
  if (mode === "auto") return "herdr";
  return "native";
}

export interface HerdrWakeDeps {
  storage: Storage;
  audit?: AuditStore;
  clientFactory?: (identity: HerdrIdentity) => HerdrClient;
  now?: () => number;
}

export async function herdrWake(
  session: Session,
  seedText: string,
  deps: HerdrWakeDeps,
): Promise<{ ok: true } | { ok: false; reason: string; strict: boolean }> {
  const identity = session.wake_identity;
  if (!identity) {
    return { ok: false, reason: "no_herdr_identity", strict: false };
  }
  const mode = await resolveWakeMode(deps.storage, session.project, session.agent);
  if (effectiveWakeStrategy(session, mode) !== "herdr") {
    return { ok: false, reason: "strategy_native", strict: false };
  }
  const client = deps.clientFactory?.(identity) ?? new HerdrClient(identity);
  const validated = await validateHerdrIdentityAgent(client, identity);
  if (!validated.ok) {
    const strict = session.wake_strict === "herdr";
    await auditWakeDeliveryFailure(deps, {
      session,
      strategy: "herdr",
      reason: validated.reason,
      path: "inbound_wake",
    });
    return { ok: false, reason: validated.reason, strict };
  }
  const prompt = seedText.trim().length > 0 ? seedText : ".";
  const prompted = await client.agentPrompt(prompt);
  if (!prompted.ok) {
    const strict = session.wake_strict === "herdr";
    await auditWakeDeliveryFailure(deps, {
      session,
      strategy: "herdr",
      reason: `herdr_prompt_failed:${prompted.code}`,
      path: "inbound_wake",
      detail: { message: prompted.message },
    });
    return { ok: false, reason: prompted.message, strict };
  }
  return { ok: true };
}

export async function herdrRespond(
  session: Session,
  payload: ClaudeWakeResponsePayload,
  deps: HerdrWakeDeps,
): Promise<{ ok: true } | { ok: false; reason: string; strict: boolean }> {
  const identity = session.wake_identity;
  if (!identity) {
    return { ok: false, reason: "no_herdr_identity", strict: false };
  }
  const mode = await resolveWakeMode(deps.storage, session.project, session.agent);
  if (effectiveWakeStrategy(session, mode) !== "herdr") {
    return { ok: false, reason: "strategy_native", strict: false };
  }
  const client = deps.clientFactory?.(identity) ?? new HerdrClient(identity);
  const validated = await validateHerdrIdentityAgent(client, identity);
  if (!validated.ok) {
    const strict = session.wake_strict === "herdr";
    await auditWakeDeliveryFailure(deps, {
      session,
      strategy: "herdr",
      reason: validated.reason,
      path: "resolve_sink",
      detail: { prompt_type: payload.prompt_type },
    });
    return { ok: false, reason: validated.reason, strict };
  }

  const response = payload.response;
  if (payload.prompt_type === "question" && /^\d+$/.test(response)) {
    const sent = await client.agentSendKeys(response);
    if (!sent.ok) {
      const strict = session.wake_strict === "herdr";
      await auditWakeDeliveryFailure(deps, {
        session,
        strategy: "herdr",
        reason: `herdr_send_keys_failed:${sent.code}`,
        path: "resolve_sink",
        detail: { prompt_type: payload.prompt_type },
      });
      return { ok: false, reason: sent.message, strict };
    }
    return { ok: true };
  }

  let text = response;
  if (payload.prompt_type === "freetext") {
    text = response.replace(/[\r\n]+/g, " ").trim();
  }

  if (
    payload.prompt_type === "permission" &&
    (response === "y" || response === "n" || response === "a")
  ) {
    const typed = await client.paneSendText(response);
    if (!typed.ok) {
      const strict = session.wake_strict === "herdr";
      await auditWakeDeliveryFailure(deps, {
        session,
        strategy: "herdr",
        reason: `herdr_send_text_failed:${typed.code}`,
        path: "resolve_sink",
      });
      return { ok: false, reason: typed.message, strict };
    }
    const enter = await client.agentSendKeys("enter");
    if (!enter.ok) {
      const strict = session.wake_strict === "herdr";
      await auditWakeDeliveryFailure(deps, {
        session,
        strategy: "herdr",
        reason: `herdr_send_keys_failed:${enter.code}`,
        path: "resolve_sink",
      });
      return { ok: false, reason: enter.message, strict };
    }
    return { ok: true };
  }

  if (payload.prompt_type === "freetext" && text) {
    const typed = await client.paneSendText(text);
    if (!typed.ok) {
      const strict = session.wake_strict === "herdr";
      await auditWakeDeliveryFailure(deps, {
        session,
        strategy: "herdr",
        reason: `herdr_send_text_failed:${typed.code}`,
        path: "resolve_sink",
      });
      return { ok: false, reason: typed.message, strict };
    }
    const enter = await client.agentSendKeys("enter");
    if (!enter.ok) {
      const strict = session.wake_strict === "herdr";
      await auditWakeDeliveryFailure(deps, {
        session,
        strategy: "herdr",
        reason: `herdr_send_keys_failed:${enter.code}`,
        path: "resolve_sink",
      });
      return { ok: false, reason: enter.message, strict };
    }
    return { ok: true };
  }

  return { ok: false, reason: "unsupported_herdr_response", strict: false };
}

export function wakeSeedFromMessage(input: {
  comm?: string;
  sender?: string;
  body?: string;
}): string {
  return buildWakeSeed(input);
}

export function parseWakeStrict(raw: unknown): HerdrWakeStrict | null {
  return raw === "herdr" ? "herdr" : null;
}

async function auditWakeDeliveryFailure(
  deps: HerdrWakeDeps,
  input: {
    session: Session;
    strategy: "herdr";
    reason: string;
    path: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await deps.audit?.append({
      timestamp: deps.now?.() ?? Date.now(),
      kind: "wake_delivery_failure",
      agent: input.session.agent,
      session: input.session.session_id,
      detail: {
        reason: input.reason,
        strategy: input.strategy,
        path: input.path,
        ...input.detail,
      },
    });
  } catch {
    /* best-effort */
  }
}

export async function wakeStrategyForSession(
  storage: Storage,
  session: Session,
): Promise<EffectiveWakeStrategy> {
  const mode = await resolveWakeMode(storage, session.project, session.agent);
  return effectiveWakeStrategy(session, mode);
}
