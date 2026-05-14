# Sequence: Telegram → Codex

Inbound flow for Codex, which exposes an app-server with explicit `turn/start`
semantics rather than a console session that's woken by a watcher. The bus
consults `AgentCapabilities.midTurnPolicy` to decide what to do when a message
arrives while a turn is already in progress.

```mermaid
sequenceDiagram
    autonumber
    participant User as Telegram User
    participant TG as TelegramAPI
    participant TA as TelegramAdapter<br/>(in daemon)
    participant Bus as MessageBus<br/>(in daemon)
    participant CA as CodexAdapter
    participant AS as CodexAppServer

    User->>TG: send text
    TG-->>TA: getUpdates / webhook delivery
    TA->>Bus: enqueueInbound(envelope)
    Note over Bus: Durable write to<br/>~/.agents-comm/inbox<br/>BEFORE wake
    Bus->>Bus: route(envelope)<br/>[routing model TBD]
    Bus->>CA: deliver(envelope, sessionId)
    CA->>AS: getTurnState(sessionId)
    AS-->>CA: state = {idle | running}

    alt state == idle
        CA->>AS: turn/start(text)
        AS-->>CA: turnId
    else state == running
        CA->>CA: lookup capabilities.midTurnPolicy
        alt midTurnPolicy == queue
            CA->>CA: queue envelope, deliver on turn/end
        else midTurnPolicy == steer
            CA->>AS: turn/steer(turnId, text)
            AS-->>CA: ack
        else midTurnPolicy == reject
            CA-->>Bus: deliveryReceipt(rejected, "mid-turn")
            Bus->>TA: send(rejection notice)
            TA->>TG: sendMessage(chatId, "busy, try again")
        end
    end

    Note over AS: Turn completes
    AS-->>CA: turn/end(output)
    CA->>Bus: enqueueOutbound(envelope)
    Bus->>TA: send(envelope)
    TA->>TG: sendMessage(chatId, output)
    TG-->>User: reply delivered
```

## Notes

- **Wake mechanism differs from Claude.** Codex doesn't have a console-attached
  watcher; the adapter calls `turn/start` on the app-server directly. The bus
  layer is unchanged — only the agent-side delivery path differs.
- **`midTurnPolicy` is a capability, not a global setting.** Each
  `AgentCapabilities` declaration specifies how to handle inbound while a turn
  is running. Bus and adapter both consult it so the same envelope is handled
  consistently regardless of which queue path it takes.
- **Durable enqueue still precedes wake.** Same invariant as the Claude flow:
  the inbound is on disk before the adapter touches the app-server, so a crash
  between enqueue and `turn/start` doesn't lose the message.
- **Outbound on `turn/end`.** Codex emits its reply when the turn completes;
  the adapter wraps it as an outbound envelope so it travels the same bus →
  TelegramAdapter path as a Claude reply.
