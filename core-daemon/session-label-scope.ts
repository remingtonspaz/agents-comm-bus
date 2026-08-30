import type {
  AccountRegistration,
  CommId,
  Session,
} from "agents-comm-bus-core";
import type {
  SessionOwnerLiveness,
  SessionOwnerRecord,
} from "./runtime/session-owner-liveness.js";

/** Parsed `AGENTS_COMM_LABELS` map: comm id → account label. */
export type AccountLabelScopeMap = Readonly<Record<string, string>>;

/**
 * Parse `AGENTS_COMM_LABELS=discord:subagent,telegram:main`.
 * Returns null when unset/empty (today's unscoped behavior).
 */
export function parseAgentsCommLabels(raw: string | undefined | null): AccountLabelScopeMap | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const map: Record<string, string> = {};
  for (const entry of trimmed.split(",")) {
    const piece = entry.trim();
    if (piece.length === 0) {
      throw new Error(`AGENTS_COMM_LABELS contains an empty entry in "${raw}"`);
    }
    const colon = piece.indexOf(":");
    if (colon <= 0 || colon === piece.length - 1) {
      throw new Error(
        `AGENTS_COMM_LABELS entry "${piece}" is malformed; expected comm:label`,
      );
    }
    const comm = piece.slice(0, colon).trim();
    const label = piece.slice(colon + 1).trim();
    if (comm.length === 0 || label.length === 0) {
      throw new Error(
        `AGENTS_COMM_LABELS entry "${piece}" is malformed; expected comm:label`,
      );
    }
    if (map[comm] !== undefined) {
      throw new Error(`AGENTS_COMM_LABELS lists comm "${comm}" more than once`);
    }
    map[comm] = label;
  }
  return map;
}

/** Canonical persisted form (sorted comm keys) or null when unscoped. */
export function serializeAccountLabelScope(
  scope: AccountLabelScopeMap | null | undefined,
): string | null {
  if (!scope || Object.keys(scope).length === 0) return null;
  const sorted = Object.keys(scope).sort();
  const canonical: Record<string, string> = {};
  for (const comm of sorted) {
    canonical[comm] = scope[comm]!;
  }
  return JSON.stringify(canonical);
}

export function parseAccountLabelScope(
  stored: string | null | undefined,
): AccountLabelScopeMap | null {
  if (stored === undefined || stored === null) return null;
  const trimmed = stored.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`account_label_scope is not valid JSON: ${stored}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`account_label_scope must be a JSON object: ${stored}`);
  }
  const map: Record<string, string> = {};
  for (const [comm, label] of Object.entries(parsed)) {
    if (typeof label !== "string" || label.length === 0) {
      throw new Error(`account_label_scope value for "${comm}" must be a non-empty string`);
    }
    map[comm] = label;
  }
  return map;
}

export function accountLabelScopeFromParams(
  params: Record<string, unknown>,
): string | null {
  if (params.account_label_scope === null) return null;
  if (typeof params.account_label_scope === "string") {
    return serializeAccountLabelScope(parseAccountLabelScope(params.account_label_scope));
  }
  if (typeof params.comm_labels === "string") {
    return serializeAccountLabelScope(parseAgentsCommLabels(params.comm_labels));
  }
  return null;
}

export function filterRegistrationsByScope(
  registrations: readonly AccountRegistration[],
  scopeStored: string | null | undefined,
): AccountRegistration[] {
  const scope = parseRoutingScope(scopeStored);
  if (scope === undefined) return [];
  if (!scope) return [...registrations];
  return registrations.filter((reg) => {
    const expected = scope[reg.comm];
    return expected !== undefined && reg.account_label === expected;
  });
}

export type SessionScopeRecord = Pick<
  Session,
  | "session_id"
  | "project"
  | "agent"
  | "account_label_scope"
  | "status"
  | "lease_holder_connection_id"
  | "lease_owner_process_pid"
  | "lease_owner_process_registered_at"
  | "lease_owner_process_start_time"
>;

function liveSessionScopeCandidates(
  target: SessionScopeRecord,
  sessions: readonly SessionScopeRecord[],
  isSessionLive: SessionOwnerLiveness,
): SessionScopeRecord[] {
  const liveSiblings = sessions.filter(
    (session) =>
      session.session_id !== target.session_id &&
      session.project === target.project &&
      session.agent === target.agent &&
      session.status === "active" &&
      isSessionLive(session),
  );
  return [target, ...liveSiblings];
}

/**
 * Resolve the registrations a concrete session may consume.
 *
 * A labeled session owns only its exact scope. An unlabeled session preserves
 * the legacy catch-all behavior except for registrations claimed by a live
 * labeled sibling in the same (project, agent).
 */
export function filterRegistrationsForSession(
  registrations: readonly AccountRegistration[],
  target: SessionScopeRecord,
  sessions: readonly SessionScopeRecord[],
  isSessionLive: SessionOwnerLiveness = hasLiveConnectionLease,
): AccountRegistration[] {
  if (target.account_label_scope != null) {
    return filterRegistrationsByScope(
      registrations,
      target.account_label_scope,
    );
  }
  const labeledSiblings = liveSessionScopeCandidates(
    target,
    sessions,
    isSessionLive,
  ).filter(
    (session) =>
      session.session_id !== target.session_id &&
      session.account_label_scope != null,
  );
  if (labeledSiblings.length === 0) return [...registrations];
  return registrations.filter(
    (registration) =>
      !labeledSiblings.some((session) =>
        registrationMatchesConversationScope(
          session.account_label_scope,
          registration,
        ),
      ),
  );
}

/**
 * Whether a session owns a conversation after live labeled-session precedence.
 */
export function sessionOwnsConversation(
  target: SessionScopeRecord,
  sessions: readonly SessionScopeRecord[],
  conversation: {
    project: string;
    agent: string;
    comm: CommId | string;
    account_label: string;
  },
  isSessionLive: SessionOwnerLiveness = hasLiveConnectionLease,
): boolean {
  if (
    conversation.project !== target.project ||
    conversation.agent !== target.agent
  ) {
    return false;
  }
  const resolved = resolveSessionForConversation(
    liveSessionScopeCandidates(target, sessions, isSessionLive),
    conversation,
    (session) => session.session_id,
  );
  return resolved?.session_id === target.session_id;
}

export function registrationMatchesConversationScope(
  scopeStored: string | null | undefined,
  conversation: { comm: CommId | string; account_label: string },
): boolean {
  const scope = parseRoutingScope(scopeStored);
  if (scope === undefined) return false;
  if (!scope) return true;
  const expected = scope[conversation.comm];
  return expected !== undefined && expected === conversation.account_label;
}

export interface SessionScopeIdentity {
  project: string;
  agent: string;
  account_label_scope: string | null;
}

/**
 * Pick the session that should receive an inbound for `conversation`.
 * Labeled sessions win over unlabeled; among labeled, exact comm+label match.
 */
export function resolveSessionForConversation<T extends SessionScopeIdentity & { session_id: string }>(
  sessions: readonly T[],
  conversation: { comm: CommId | string; account_label: string },
  pickSessionId: (session: T) => string,
): T | undefined {
  const labeledMatches = sessions.filter(
    (sess) =>
      sess.account_label_scope != null &&
      registrationMatchesConversationScope(sess.account_label_scope, conversation),
  );
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

function hasLiveConnectionLease(session: SessionOwnerRecord): boolean {
  return session.lease_holder_connection_id != null;
}

/**
 * Corrupt persisted scopes fail inert for routing: they neither consume nor
 * reserve registrations. The strict public parser still throws for validation
 * callers; only runtime routing is hardened against a damaged row.
 */
function parseRoutingScope(
  stored: string | null | undefined,
): AccountLabelScopeMap | null | undefined {
  try {
    return parseAccountLabelScope(stored ?? null);
  } catch (error) {
    console.error(
      "agents-comm-bus: invalid persisted account_label_scope; " +
        "treating session as scope-inert: " +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}
