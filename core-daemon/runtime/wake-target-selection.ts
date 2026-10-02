import type { AgentId, CommId, Conversation, Session, Storage } from "agents-comm-bus-core";

import { normalizeProjectPath } from "../project-path.js";
import { resolveSessionForConversation } from "../session-label-scope.js";
import { sessionEndObservation } from "./session-end-sweep.js";
import type { SessionOwnerRecord } from "./session-owner-liveness.js";

type ScopeConversation = { comm: CommId; account_label: string };

export type PreferredWakeTier = (session: Session) => boolean;

/** Codex/Pi inbound selection: prefer sessions holding a connection lease. */
export function sessionLeaseHeld(session: SessionOwnerRecord): boolean {
  return session.lease_holder_connection_id != null;
}

function pickScopeMatchedSession(
  pool: Session[],
  conversation?: ScopeConversation,
): Session | undefined {
  if (pool.length === 0) return undefined;
  if (!conversation) return pool[0];
  const match = resolveSessionForConversation(
    pool,
    conversation,
    (sess) => sess.session_id,
  );
  if (match) return match;
  if (!conversation) return undefined;
  // Legacy project-only wake dir: unrelated labeled rows must not veto this fallback.
  return pool.find((session) => session.account_label_scope == null);
}

/**
 * Storage-first inbound wake target: preferred tier, then herdr identity, then legacy.
 * Claude passes owner liveness; Codex/Pi pass {@link sessionLeaseHeld}.
 */
export async function selectActiveSessionForInboundWake(
  storage: Storage,
  project: string,
  agent: AgentId,
  conversation: ScopeConversation | undefined,
  isPreferredTier: PreferredWakeTier,
): Promise<Session | null> {
  const resolved = normalizeProjectPath(project);
  const sessions = await storage.listSessions({
    project: resolved,
    agent,
    status: "active",
  });
  if (sessions.length === 0) return null;

  const preferred = sessions.filter(isPreferredTier);
  const herdr = sessions.filter(
    (session) => !isPreferredTier(session) && session.wake_identity != null,
  );
  const legacy = sessions.filter(
    (session) => !isPreferredTier(session) && session.wake_identity == null,
  );

  for (const tier of [preferred, herdr, legacy]) {
    const picked = pickScopeMatchedSession(tier, conversation);
    if (picked) return picked;
  }
  return null;
}

function scopesMatch(a: Session, b: Session): boolean {
  if (a.account_label_scope == null && b.account_label_scope == null) return true;
  return a.account_label_scope === b.account_label_scope;
}

/** End stale unleased siblings when a herdr session is registered for the same scope. */
export async function supersedeStaleSessionsOnHerdrRegister(
  storage: Storage,
  herdrSession: Session,
  sessionOwnerIsLive: PreferredWakeTier,
  now: number = Date.now(),
): Promise<void> {
  const sessions = await storage.listSessions({
    project: herdrSession.project,
    agent: herdrSession.agent,
    status: "active",
  });
  for (const row of sessions) {
    if (row.session_id === herdrSession.session_id) continue;
    if (!scopesMatch(row, herdrSession)) continue;
    if (sessionOwnerIsLive(row)) continue;
    if (row.lease_holder_connection_id != null) continue;
    await storage.endSessionIfUnchanged(
      row.session_id,
      sessionEndObservation(row),
      now,
    );
  }
}
