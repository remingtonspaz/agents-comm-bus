import type { AccountRegistration, CommId } from "agents-comm-bus-core";
/** Parsed `AGENTS_COMM_LABELS` map: comm id → account label. */
export type AccountLabelScopeMap = Readonly<Record<string, string>>;
/**
 * Parse `AGENTS_COMM_LABELS=discord:subagent,telegram:main`.
 * Returns null when unset/empty (today's unscoped behavior).
 */
export declare function parseAgentsCommLabels(raw: string | undefined | null): AccountLabelScopeMap | null;
/** Canonical persisted form (sorted comm keys) or null when unscoped. */
export declare function serializeAccountLabelScope(scope: AccountLabelScopeMap | null | undefined): string | null;
export declare function parseAccountLabelScope(stored: string | null | undefined): AccountLabelScopeMap | null;
export declare function accountLabelScopeFromParams(params: Record<string, unknown>): string | null;
export declare function filterRegistrationsByScope(registrations: readonly AccountRegistration[], scopeStored: string | null | undefined): AccountRegistration[];
export declare function registrationMatchesConversationScope(scopeStored: string | null | undefined, conversation: {
    comm: CommId | string;
    account_label: string;
}): boolean;
export interface SessionScopeIdentity {
    project: string;
    agent: string;
    account_label_scope: string | null;
}
/**
 * Pick the session that should receive an inbound for `conversation`.
 * Labeled sessions win over unlabeled; among labeled, exact comm+label match.
 */
export declare function resolveSessionForConversation<T extends SessionScopeIdentity & {
    session_id: string;
}>(sessions: readonly T[], conversation: {
    comm: CommId | string;
    account_label: string;
}, pickSessionId: (session: T) => string): T | undefined;
//# sourceMappingURL=session-label-scope.d.ts.map