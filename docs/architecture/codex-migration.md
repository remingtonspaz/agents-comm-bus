# Codex Migration Notes

Phase 3 moves Codex onto the same v4 daemon shape as Claude.

## Runtime State

Codex runtime state now belongs under the shared per-user daemon root:

- `~/.agents-comm-bus/agents-comm-bus.db`
- `~/.agents-comm-bus/chats/*/transcript.jsonl`
- `~/.agents-comm-bus/audit/*.jsonl`

The old `~/.codex-telegram/*` tree is migration input only. New Codex hooks do
not read `queue.json`, `pending-permission.json`, `permission-response.json`, or
`last-chat.json` from that tree.

## Agent Identity

Codex identity is stored as adapter/session metadata:

- account registrations use `agent = "codex"`
- sessions use `agent = "codex"`
- queries use `agent = "codex"`

The Codex installer does not pass `--agent=codex` to the MCP shim. It sets
`AGENTS_COMM_BUS_AGENT=codex` as process metadata so the shared MCP shim can
report the calling agent while daemon ownership remains in v4 storage.

## Hooks

Codex hooks are thin daemon clients:

- `hosts/codex/hooks/user-prompt-submit.js` calls `ensureDaemon()`,
  `codex_register_session`, then `codex_drain_inbound`.
- `hosts/codex/hooks/permission-request.js` calls `ensureDaemon()`,
  `codex_register_session`, then blocks on `codex_open_query`.

The permission hook fails closed if the daemon cannot resolve a decision before
the query timeout.

## Wake And Steering

Codex wake behavior is capability based:

- `canWake = true` maps to Codex app-server `turn/start`.
- `canSteer = true` maps to Codex app-server `turn/steer`.
- `midTurnPolicy = "steer"`.
- `canInterrupt = false` until Codex exposes a stable interruption path.

The app-server URL comes from `CODEX_APP_SERVER_URL` with
`ws://127.0.0.1:4500` as the default fallback.
