import type { AccountRegistration, CommId, Session } from "agents-comm-bus-core";
import type { SessionOwnerLiveness } from "./runtime/session-owner-liveness.js";
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
export type SessionScopeRecord = Pick<Session, "session_id" | "project" | "agent" | "account_label_scope" | "status" | "lease_holder_connection_id" | "lease_owner_process_pid" | "lease_owner_process_registered_at" | "lease_owner_process_start_time">;
/**
 * Resolve the registrations a concrete session may consume.
 *
 * A labeled session owns only its exact scope. An unlabeled session preserves
 * the legacy catch-all behavior except for registrations claimed by a live
 * labeled sibling in the same (project, agent).
 */
export declare function filterRegistrationsForSession(registrations: readonly AccountRegistration[], target: SessionScopeRecord, sessions: readonly SessionScopeRecord[], isSessionLive?: SessionOwnerLiveness): AccountRegistration[];
/**
 * Whether a session owns a conversation after live labeled-session precedence.
 */
export declare function sessionOwnsConversation(target: SessionScopeRecord, sessions: readonly SessionScopeRecord[], conversation: {
    project: string;
    agent: string;
    comm: CommId | string;
    account_label: string;
}, isSessionLive?: SessionOwnerLiveness): boolean;
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