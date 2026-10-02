import { parseHerdrIdentity } from "./herdr.js";
import { HerdrClient, validateHerdrIdentityAgent, } from "./herdr.js";
import { buildWakeSeed } from "./wake-seed.js";
import { supersedeStaleSessionsOnHerdrRegister, } from "./wake-target-selection.js";
import { createSessionOwnerLiveness, } from "./session-owner-liveness.js";
export async function resolveWakeMode(storage, project, agent) {
    return storage.getWakeMode(project, agent);
}
export function effectiveWakeStrategy(session, mode) {
    if (!session.wake_identity)
        return "native";
    if (session.wake_strict === "herdr")
        return "herdr";
    if (mode === "auto")
        return "herdr";
    return "native";
}
export async function herdrWake(session, seedText, deps) {
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
    await auditHerdrWakeSuccess(deps, session, {
        path: "inbound_wake",
        pane_id: identity.pane_id,
    });
    return { ok: true };
}
export async function herdrRespond(session, payload, deps) {
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
        await auditHerdrWakeSuccess(deps, session, {
            path: "resolve_sink",
            pane_id: identity.pane_id,
            prompt_type: payload.prompt_type,
        });
        return { ok: true };
    }
    let text = response;
    if (payload.prompt_type === "freetext") {
        text = response.replace(/[\r\n]+/g, " ").trim();
    }
    if (payload.prompt_type === "permission" &&
        (response === "y" || response === "n" || response === "a")) {
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
        await auditHerdrWakeSuccess(deps, session, {
            path: "resolve_sink",
            pane_id: identity.pane_id,
            prompt_type: payload.prompt_type,
        });
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
        await auditHerdrWakeSuccess(deps, session, {
            path: "resolve_sink",
            pane_id: identity.pane_id,
            prompt_type: payload.prompt_type,
        });
        return { ok: true };
    }
    return { ok: false, reason: "unsupported_herdr_response", strict: false };
}
export function wakeSeedFromMessage(input) {
    return buildWakeSeed(input);
}
export function parseWakeStrict(raw) {
    return raw === "herdr" ? "herdr" : null;
}
async function auditHerdrWakeSuccess(deps, session, detail) {
    try {
        await deps.audit?.append({
            timestamp: deps.now?.() ?? Date.now(),
            kind: "agent_wake_succeeded",
            agent: session.agent,
            session: session.session_id,
            conversation_id: deps.conversationId,
            detail: {
                strategy: "herdr",
                ...detail,
            },
        });
    }
    catch {
        /* best-effort */
    }
}
async function auditWakeDeliveryFailure(deps, input) {
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
    }
    catch {
        /* best-effort */
    }
}
export async function wakeStrategyForSession(storage, session) {
    const mode = await resolveWakeMode(storage, session.project, session.agent);
    return effectiveWakeStrategy(session, mode);
}
export function validateHerdrRegisterParams(params, expectedAgent) {
    if (params.herdr_identity === undefined) {
        return { ok: true };
    }
    const identity = parseHerdrIdentity(params.herdr_identity);
    if (!identity || identity.agent !== expectedAgent) {
        return { ok: false, reason: "invalid herdr_identity" };
    }
    return { ok: true };
}
export async function applyHerdrWakeTargetFromRegisterParams(storage, session, params, expectedAgent, sessionOwnerIsLive) {
    const validated = validateHerdrRegisterParams(params, expectedAgent);
    if (!validated.ok)
        return;
    const herdrIdentity = parseHerdrIdentity(params.herdr_identity);
    const wakeStrict = parseWakeStrict(params.wake_strict);
    const liveness = sessionOwnerIsLive ?? createSessionOwnerLiveness();
    if (params.herdr_identity !== undefined && herdrIdentity) {
        await storage.setSessionWakeTarget(session, herdrIdentity, params.wake_strict !== undefined ? wakeStrict : undefined);
        const row = await storage.getSession(session);
        if (row?.wake_identity) {
            await supersedeStaleSessionsOnHerdrRegister(storage, row, liveness);
        }
    }
    else if (params.wake_strict !== undefined) {
        await storage.setSessionWakeTarget(session, undefined, wakeStrict);
    }
}
//# sourceMappingURL=wake-strategy.js.map