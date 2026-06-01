# Universal-overhaul findings (2026-05-15 → 2026-05-16)

Picked up during the E2E test described in
`docs/architecture/2026-05-15-claude-telegram-e2e-test-report.md` and the
follow-up commits.

- **Schema SQL must be copied into `dist/`** — `tsc` only emits `.js`/`.d.ts`.
  `agents-comm-bus/scripts/copy-assets.js` handles this; without it,
  account-add silently fails (DB stays 0 bytes).
- **`upsertSession` must not include `most_recent_inbound_conversation_id`
  in its `ON CONFLICT DO UPDATE SET` clause.** That column has its own
  update path (`setSessionMostRecentInbound`) called from `drainClaudeInbound`;
  re-asserting it on every `claude_register_session` nulls the value out
  before `openClaudeQuery` reads it.
- **`queries.session_id` has a partial unique index** on `(session_id) WHERE
  resolved_at IS NULL`. Claude Code never tells the hook the user's local
  selection, so hook-opened queries never resolve. Mitigation:
  `supersedeOpenQueriesForSession` runs before every `bus.openQuery` and
  marks any leftover open queries as `resolution = {kind:"superseded"}`.
- **Daemon must read accounts from storage.** An earlier version only
  attached Telegram adapters when `process.env.TELEGRAM_BOT_TOKEN` was set
  in the daemon's own environment, ignoring the `account_registrations`
  table the CLI populates. The `TelegramCommAdapterFactory` now resolves
  daemon-owned `file:` credentials from `credentials_ref` for every
  registered row.
- **HTML rendering for query prompts requires `parse_mode: HTML`** on the
  `sendMessage` call, plus an HTML-escaped prompt body. `OutboundPayload.format
  = "html"` propagates through `telegramSendOptions` to set `parse_mode`.
- **Inline `callback_data` cap is 64 bytes** on Telegram. The `q:<query_id>:<value>`
  scheme fits at ~46 bytes max.
- **`connection_state: "degraded"` is sticky** in the Telegram adapter —
  emitted on every `polling_error` but never reset to `"connected"` on
  recovery. The state flag is informational; polling continues to work.
