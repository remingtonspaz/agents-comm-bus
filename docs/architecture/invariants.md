# Architectural Invariants

Properties the system MUST preserve across all features, refactors, and
extensions. Each is one we've already paid for in real bugs (or anticipated
from the RFC review on issue #7) — violating one re-introduces a class of
defect, not just a single regression.

1. **One comm owner per `(comm, account)`.**
   Why: external services (Telegram, Matrix) reject concurrent polling
   sessions or duplicate webhooks for the same account.
   Breakage: Telegram returns HTTP 409 and inbound delivery stops for both
   would-be owners until one backs off.

2. **Durable enqueue before wake.**
   Why: a crash between "received from network" and "delivered to agent"
   would otherwise drop the message with no record.
   Breakage: silent inbound loss; users resend; agents report messages they
   never saw.

3. **Deterministic routing precedence: bindings before last-active.**
   Why: explicit `(comm_chat_id → session_id)` bindings represent user intent
   and must beat heuristics.
   Breakage: messages get steered to whichever session most recently spoke,
   surprising users who think they've pinned a chat to a session.

4. **No implicit cross-agent delivery.**
   Why: a Claude session and a Codex session sharing a user account must not
   automatically see each other's transcripts; that's a privacy/consent
   boundary.
   Breakage: confidential output from one agent leaks into another agent's
   context window without the user opting in.

5. **Pending permission requests survive daemon restart.**
   Why: permission prompts have multi-second-to-minutes TTLs and the daemon
   may restart in that window.
   Breakage: user replies `y` after a restart, the bus has no record, the
   reply is silently dropped, and the agent hangs until TTL expiry.

6. **Permanent send failure clears only the affected route.**
   Why: 403 (bot blocked / kicked) from one chat means *that* chat is dead,
   not that the whole `(comm, account)` last-active fallback should be wiped.
   Breakage: one user blocking the bot disrupts unrelated last-active routing
   for every other chat that account serves.

7. **Default-deny transcript subscriptions.**
   Why: cross-session/cross-agent fanout must be explicit; opt-in keeps the
   blast radius small and predictable.
   Breakage: a feature added later quietly fans out to every subscriber and
   becomes a privacy incident the moment a tester shares a transcript.

8. **Hop-count enforcement on every cross-agent fanout.**
   Why: agent A forwarding to agent B forwarding to agent A is a loop; bounded
   hops cap the damage.
   Breakage: unbounded message storms saturate the bus, the comm rate-limits,
   and inbound from real users gets starved out.

9. **Recently-seen dedupe window covers short-cycle loops.**
   Why: hop-count alone doesn't catch tight A↔B↔A oscillation within budget;
   a content-hash dedupe window does.
   Breakage: identical messages bounce back and forth `max_hops` times per
   cycle, multiplying load even when the hop ceiling holds.

10. **Audit log entry on every permission decision.**
    Why: permissions are the security boundary; both grants and rejections
    (including reasons: expired, wrong_chat, unauthorized, stale_link,
    already_resolved) need a paper trail.
    Breakage: a disputed action — "did I really approve that?" — has no
    answer, and silent rejections look like the system is broken.
