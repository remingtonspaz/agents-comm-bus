# Sequence: Query roundtrip (approval / choice / freetext)

This document describes the lifecycle of an agent-initiated **query** — a
request from the agent to the user that blocks the agent until resolved.
Examples include Claude's `PermissionRequest`, `AskUserQuestion`, and
`ExitPlanMode` hook events, all of which require a user decision before the
agent can continue.

Queries are first-class records in the daemon. They are distinct from
ordinary outbound messages because they have resolution semantics: a query
is open until exactly one valid reply resolves it, after which it is closed
forever. The rules around what counts as a valid reply are codified in
`query-semantics.ts` and tested in `tests/architecture/query-semantics.spec.ts`.

For the inbound and outbound flows that frame queries see
[Telegram → Claude](./sequence-telegram-to-claude.md) and the
[invariants](./invariants.md) doc.

## Flow

```mermaid
sequenceDiagram
    autonumber
    participant Hook as Claude hook<br/>(PermissionRequest / AskUserQuestion / ExitPlanMode)
    participant CAA as ClaudeAgentAdapter
    participant Bus as MessageBus (daemon)
    participant DB as SQLite
    participant TCA as TelegramCommAdapter
    actor User

    Hook->>CAA: blocking IPC: openQuery({ kind, prompt, options?, ttl })
    CAA->>Bus: createQuery(session_id, kind, payload)
    Bus->>DB: INSERT INTO queries<br/>(session_id, status="open", ...)<br/>partial unique index enforces<br/>at-most-one-open per session
    DB-->>Bus: query_id
    Bus->>Bus: pick reply ChatRef<br/>= query.originChat ?? most-recent-inbound
    Bus->>TCA: sendQueryPrompt(ChatRef, query_id, payload)
    TCA->>User: "Approve? [y/n/a]" (or numbered options)
    Note over CAA,Bus: IPC connection from hook stays open.<br/>Closing it = query cancelled.
    User-->>TCA: reply "y"
    TCA->>Bus: deliverInbound(Message)
    Bus->>Bus: tryResolve(query_id, message)
    alt valid (same chat, query still open, within TTL)
        Bus->>DB: UPDATE queries SET status="resolved",<br/>resolution=?, resolved_at=now
        Bus-->>CAA: resolution payload (via held connection)
        CAA-->>Hook: hook return value<br/>(e.g. { decision: { behavior: "allow" } })
    else stale (TTL expired)
        Bus->>DB: UPDATE queries SET status="expired"
        Bus-->>CAA: fail-closed (treat as deny)
        CAA-->>Hook: deny / cancel
    else wrong chat
        Bus->>TCA: reply "this query was sent to a different chat; ignored"
        Note over Bus: query remains open
    else already resolved
        Bus->>TCA: reply "query already answered"
        Note over Bus: no-op
    end
```

## Resolution rules

Encoded in `query-semantics.ts`:

- **At-most-one-open-per-session.** A partial unique index on
  `queries(session_id) WHERE status = 'open'` prevents the daemon from
  ever having two open queries for the same agent session. If an adapter
  tries to open a second one while the first is still open, the create call
  fails — the agent must close or wait on the existing query first.
- **Same-chat-match.** A reply only resolves a query if it arrives on the
  same `ChatRef` the query prompt was sent to. A reply from a different chat
  (even from the same user, even from an authorized user) is rejected with
  an informational message and does **not** resolve the query.
- **Resolved-once.** Once a query transitions out of `open`, no further
  message can change its resolution. Late replies receive an "already
  answered" notice.
- **TTL fail-closed.** Every query has a TTL. When the TTL elapses without
  resolution, the daemon marks the query `expired` and returns a deny /
  cancel value to the agent. The default is to treat expiry as the safest
  possible outcome — for `PermissionRequest` that means deny, for
  `AskUserQuestion` that means user-cancelled.

## Connection lifetime

The IPC connection from the Claude hook to the daemon stays open for the
duration of the query. Closing that connection — for any reason: the hook
process dies, the user kills Claude, the daemon process is killed — is
treated as **query cancellation**: the daemon marks the query closed with
no resolution and runs any cleanup hooks. This is the same lease pattern
used for session liveness; see the *session/query leases bound to IPC
connection lifetime* entry in [invariants](./invariants.md).

There is no application-level heartbeat in V1. The TCP / Unix-socket
half-close is the liveness signal.
