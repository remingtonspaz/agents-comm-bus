# Sequence: Telegram inbound → Claude

This document describes the inbound path for a user message arriving on Telegram
and being delivered to a Claude Code session. It covers normalization, durable
persistence, deterministic routing, and the watcher-based wake mechanism.

For the parallel Codex path (which differs only in the wake step) see
[Telegram → Codex](./sequence-telegram-to-codex.md). For the storage layout
referenced in the persistence step see [storage layout](./storage-layout.md).
For the invariants enforced along this path see [invariants](./invariants.md).

## Flow

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant TG as Telegram
    participant TCA as TelegramCommAdapter
    participant Bus as MessageBus (daemon)
    participant DB as SQLite (agents-comm-bus.db)
    participant CAA as ClaudeAgentAdapter
    participant Hook as Claude UserPromptSubmit hook
    participant Watcher as enter-watcher.ps1

    User->>TG: send "fix the build"
    TCA->>TG: long-poll / webhook
    TG-->>TCA: Update { chat, from, text, ... }
    TCA->>TCA: normalize to Message envelope<br/>(comm="telegram", bot_user_id, ChatRef, sender, payload)
    TCA->>Bus: deliverInbound(Message)
    Bus->>DB: SELECT FROM account_registrations<br/>WHERE comm="telegram" AND bot_user_id=?
    DB-->>Bus: account_id (owner + agent target)
    Bus->>DB: INSERT conversation row (if new)<br/>INSERT message row (durable)
    Bus->>DB: append chats/<conv>/transcript.jsonl
    Note over Bus,DB: Persistence happens BEFORE wake.<br/>If the agent never wakes, the message<br/>is still recoverable on next start.
    Bus->>CAA: dispatch(Message, account)
    CAA->>Watcher: write trigger file<br/>(~/.claude-telegram/<session>/trigger-enter)
    Watcher->>Watcher: PostMessage WM_CHAR "." + Enter<br/>to session's cmd.exe hwnd
    Watcher-->>Hook: Claude wakes, fires UserPromptSubmit
    Hook->>Bus: fetch pending inbound (control connection)
    Bus-->>Hook: Message envelope (incl. ChatRef)
    Hook-->>CAA: inject as additionalContext
    Note over Hook,CAA: Claude prompt now contains the<br/>envelope; the agent picks its reply<br/>target from the inbound ChatRef.
```

## Notes on routing

Routing is performed by an **explicit registration lookup** keyed on
`(comm, bot_user_id)`. The daemon never guesses based on which session was
recently active and never walks the OS process tree to find a target. The
legacy `last-chat.json` heuristic from the v3 plugin is **gone** — that file
exists only to disambiguate proactive sends with no explicit target, and even
then only as a fallback to "most recent inbound."

If no `account_registration` row matches the incoming `(comm, bot_user_id)`
pair, the message is dropped at the adapter with an audit entry. The daemon
does not auto-create accounts from unknown bots.

## Notes on persistence ordering

Step 4 (durable insert + transcript append) happens **before** step 5
(dispatch / wake). This is invariant *durable enqueue before wake/dispatch*
in [invariants.md](./invariants.md). The crash-safety property the system
gives is: if `deliverInbound` returns success to the comm adapter, the message
will be visible to the agent on next wake even if the daemon is killed
between steps 4 and 5.

## Notes on the hook

The hook does not read from the legacy per-session `queue.json` file. It opens
a control connection to the daemon (see
[daemon bootstrap](./sequence-daemon-bootstrap.md)) and pulls the inbound
envelope by `session_id`. The per-session JSON queue files survive only as a
fallback for offline / daemon-unreachable degraded mode; the canonical source
of truth is the daemon's SQLite database.
