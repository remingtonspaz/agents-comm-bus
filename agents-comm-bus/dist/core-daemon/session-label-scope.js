/**
 * Parse `AGENTS_COMM_LABELS=discord:subagent,telegram:main`.
 * Returns null when unset/empty (today's unscoped behavior).
 */
export function parseAgentsCommLabels(raw) {
    if (raw === undefined || raw === null)
        return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0)
        return null;
    const map = {};
    for (const entry of trimmed.split(",")) {
        const piece = entry.trim();
        if (piece.length === 0) {
            throw new Error(`AGENTS_COMM_LABELS contains an empty entry in "${raw}"`);
        }
        const colon = piece.indexOf(":");
        if (colon <= 0 || colon === piece.length - 1) {
            throw new Error(`AGENTS_COMM_LABELS entry "${piece}" is malformed; expected comm:label`);
        }
        const comm = piece.slice(0, colon).trim();
        const label = piece.slice(colon + 1).trim();
        if (comm.length === 0 || label.length === 0) {
            throw new Error(`AGENTS_COMM_LABELS entry "${piece}" is malformed; expected comm:label`);
        }
        if (map[comm] !== undefined) {
            throw new Error(`AGENTS_COMM_LABELS lists comm "${comm}" more than once`);
        }
        map[comm] = label;
    }
    return map;
}
/** Canonical persisted form (sorted comm keys) or null when unscoped. */
export function serializeAccountLabelScope(scope) {
    if (!scope || Object.keys(scope).length === 0)
        return null;
    const sorted = Object.keys(scope).sort();
    const canonical = {};
    for (const comm of sorted) {
        canonical[comm] = scope[comm];
    }
    return JSON.stringify(canonical);
}
export function parseAccountLabelScope(stored) {
    if (stored === undefined || stored === null)
        return null;
    const trimmed = stored.trim();
    if (trimmed.length === 0)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        throw new Error(`account_label_scope is not valid JSON: ${stored}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`account_label_scope must be a JSON object: ${stored}`);
    }
    const map = {};
    for (const [comm, label] of Object.entries(parsed)) {
        if (typeof label !== "string" || label.length === 0) {
            throw new Error(`account_label_scope value for "${comm}" must be a non-empty string`);
        }
        map[comm] = label;
    }
    return map;
}
export function accountLabelScopeFromParams(params) {
    if (params.account_label_scope === null)
        return null;
    if (typeof params.account_label_scope === "string") {
        return serializeAccountLabelScope(parseAccountLabelScope(params.account_label_scope));
    }
    if (typeof params.comm_labels === "string") {
        return serializeAccountLabelScope(parseAgentsCommLabels(params.comm_labels));
    }
    return null;
}
export function filterRegistrationsByScope(registrations, scopeStored) {
    const scope = parseAccountLabelScope(scopeStored ?? null);
    if (!scope)
        return [...registrations];
    return registrations.filter((reg) => {
        const expected = scope[reg.comm];
        return expected !== undefined && reg.account_label === expected;
    });
}
export function registrationMatchesConversationScope(scopeStored, conversation) {
    const scope = parseAccountLabelScope(scopeStored ?? null);
    if (!scope)
        return true;
    const expected = scope[conversation.comm];
    return expected !== undefined && expected === conversation.account_label;
}
/**
 * Pick the session that should receive an inbound for `conversation`.
 * Labeled sessions win over unlabeled; among labeled, exact comm+label match.
 */
export function resolveSessionForConversation(sessions, conversation, pickSessionId) {
    const labeledMatches = sessions.filter((sess) => sess.account_label_scope != null &&
        registrationMatchesConversationScope(sess.account_label_scope, conversation));
    if (labeledMatches.length > 0) {
        return labeledMatches[0];
    }
    const unlabeled = sessions.filter((sess) => sess.account_label_scope == null);
    if (unlabeled.length === 1) {
        return unlabeled[0];
    }
    if (unlabeled.length > 1) {
        return undefined;
    }
    return undefined;
}
//# sourceMappingURL=session-label-scope.js.map