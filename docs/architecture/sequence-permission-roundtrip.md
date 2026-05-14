# Sequence: Permission Round-Trip

Permission prompts flow agent → bus → comm → user → bus → agent. Every reply is
validated against a server-side record (request_id, source chat, TTL,
authorization) so the bus can reject stale, mis-routed, or unauthorized replies
without ever forwarding a wrong decision back to the agent.

```mermaid
sequenceDiagram
    autonumber
    participant Agent as Claude / Codex
    participant Bus as MessageBus<br/>(in daemon)
    participant Store as PermissionStore<br/>(durable)
    participant TA as TelegramAdapter
    participant User as Telegram User
    participant Audit as AuditLog

    Agent->>Bus: PermissionRequest{<br/>request_id, source_chat,<br/>source_message_id, ttl_ms,<br/>prompt}
    Bus->>Store: persist(request) [durable]
    Bus->>TA: send prompt to source_chat
    TA->>User: "Allow X? (y/n/a) [id: abc123]"

    User->>TA: reply "y"
    TA->>Bus: incomingReply(chatId, userId, text, replyToMessageId)
    Bus->>Store: lookup(request_id)
    Bus->>Bus: validateReply(reply, record)

    alt valid (within ttl, correct chat, authorized user, not yet resolved)
        Bus->>Store: markResolved(request_id, decision)
        Bus->>Audit: log(request_id, decision, userId, chatId, "accepted")
        Bus-->>Agent: PermissionDecision{request_id, allow}
    else expired (now > created_at + ttl_ms)
        Bus->>Audit: log(request_id, reject_reason="expired")
        Note over Bus: Drop reply, request stays open<br/>until TTL sweep removes it
    else wrong_chat (chatId != source_chat)
        Bus->>Audit: log(request_id, reject_reason="wrong_chat")
        Note over Bus: Drop reply, keep waiting
    else unauthorized (userId not in allowlist)
        Bus->>Audit: log(request_id, reject_reason="unauthorized")
        Note over Bus: Drop reply, keep waiting
    else stale_link (replyToMessageId doesn't match source_message_id)
        Bus->>Audit: log(request_id, reject_reason="stale_link")
        Note over Bus: Drop reply, keep waiting
    else already_resolved (markResolved already ran)
        Bus->>Audit: log(request_id, reject_reason="already_resolved")
        Note over Bus: Drop duplicate, no second decision sent
    end
```

## Notes

- **Durability survives daemon restart.** The persisted record in
  `PermissionStore` means a `y` arriving after a daemon crash + restart still
  resolves the original request. The agent side may need to re-issue if it also
  restarted, but the bus never silently swallows a valid reply.
- **`stale_link` example.** If a user scrolls up and replies to an *earlier*
  permission prompt that's already been answered (or to a prompt for a
  different `request_id`), the `replyToMessageId` won't match the live record
  and the reply is dropped. Without this check, an out-of-order reply could
  satisfy a fresh, unrelated prompt.
- **Audit log entry on every decision** — including rejections. This is
  Invariant 10 and is the basis for after-the-fact accountability when a
  permission outcome is disputed.
- **Default-deny TTL sweep.** Requests not resolved within `ttl_ms` are reaped
  by a periodic sweep that emits a synthetic `denied(timeout)` decision back to
  the agent so it doesn't hang forever.
