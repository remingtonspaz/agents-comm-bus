# Sequence: Telegram → Claude

Inbound flow when a Telegram user sends a message that should reach a Claude
session. The `TelegramAdapter` and `MessageBus` both live inside the per-user
daemon process; the `ClaudeAdapter` straddles the daemon (routing side) and the
target Claude session (delivery side, via the existing watcher + hook IPC).

```mermaid
sequenceDiagram
    autonumber
    participant User as Telegram User
    participant TG as TelegramAPI
    participant TA as TelegramAdapter<br/>(in daemon)
    participant Bus as MessageBus<br/>(in daemon)
    participant CA as ClaudeAdapter
    participant CS as ClaudeSession<br/>(watcher + hook)

    User->>TG: send text
    TG-->>TA: getUpdates / webhook delivery
    TA->>Bus: enqueueInbound(envelope)
    Note over Bus: Durable write to<br/>~/.agents-comm/inbox<br/>BEFORE wake
    Bus->>Bus: route(envelope)
    alt explicit binding exists
        Bus-->>CA: deliver(envelope, sessionId)
    else no binding
        Bus-->>CA: deliver(envelope, lastActiveSessionId)
    end
    CA->>CS: write queue.json + trigger-enter
    CS-->>CA: ack (file written)
    CA-->>Bus: deliveryReceipt(ok)

    Note over CS: Claude processes turn,<br/>emits outbound reply
    CS->>CA: outbound(text, sourceChatId)
    CA->>Bus: enqueueOutbound(envelope)
    Bus->>TA: send(envelope)
    TA->>TG: sendMessage(chatId, text)
    TG-->>User: message delivered
```

## Notes

- **Durable enqueue happens before wake.** The bus persists the inbound
  envelope to `~/.agents-comm/` before any attempt to wake the Claude session.
  If the daemon or session crashes between enqueue and delivery, the message is
  redelivered on restart — no inbound is ever silently lost.
- **Routing is deterministic.** The bus first consults explicit
  `(commChatId → sessionId)` bindings; only if no binding exists does it fall
  back to the last-active session for that `(comm, account)` pair.
- **Outbound replies travel the same adapter.** The Claude session never talks
  to the Telegram API directly; outbound text is enqueued onto the bus and
  emitted by the same `TelegramAdapter` instance that owns the polling
  connection, preserving the one-comm-owner-per-`(comm, account)` invariant.
- **Per-chat reply targeting** is preserved by carrying `source_chat_id` on the
  inbound envelope; the outbound envelope echoes it so the bus knows where to
  route the reply without reusing last-active.
