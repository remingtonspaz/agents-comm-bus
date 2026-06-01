# Codex + Telegram E2E findings (2026-05-17)

See `docs/architecture/2026-05-17-codex-telegram-e2e-test-report.md`.
High-signal findings:

- `scripts/bootstrap-codex-session.ps1` is the supported local launcher for
  a Codex session with a companion app-server. It finds a free `4500-4600`
  port, starts the app-server in a separate PowerShell window, and can resume
  a thread with `-ThreadId ... -Exec`. It also supports
  `-RestartCurrent -SameTerminal -Exec` for one-line self-restart testing;
  use `-PlanOnly -Json` with those flags to inspect process discovery without
  killing the current session.
- Bootstrapper app-server metadata lives under
  `~/.agents-comm-bus/codex-bootstrapper/sessions/`. Same-terminal restart
  relays pass `-StopPreviousAppServer` so repeated bootstrap runs can replace
  their own prior app-server window/process.
- The global Codex MCP entry should be path-only. `hosts/codex/codex-mcp-shim.js`
  discovers Codex runtime context and performs persistent
  `codex_register_session` with `persist_after_disconnect`.
- `upsertSession` must not clobber lease columns either. Hook registrations
  are short-lived; the persistent MCP registration owns the useful app-server
  mapping.
- Codex inbound must use `turn/steer` first. Live testing showed unconditional
  `turn/start` after an outbound tool call can leave Codex stuck in
  `"working..."`.
- Session-derived outbound and query prompts must send via concrete
  `bot_user_id`. `account_label="main"` is ambiguous when Claude and Codex
  both use Telegram.
- Conversation identity includes `agent` as of storage migration v2. Without
  it, Claude and Codex shared transcript/query windows for the same Telegram
  chat when both registrations used `account_label=main`.
