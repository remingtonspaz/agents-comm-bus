# Day-2 regression-fix findings (2026-05-17)

Discovered while implementing the Codex bridge alongside Claude, with
both registered under `comm="telegram"` with their own bots.

- **`mcp-server` bundle must be rebuilt after editing
  `bootstrap/ensure-daemon.ts`.** esbuild inlines the spawn target into
  the bundle. The fix for the daemon-vs-serve.js entry-point change
  (commit `96b40ad`) updated `ensure-daemon.ts` and the live `agents-comm-bus`
  dist, but `mcp-server/dist/claude-mcp-shim.js` carried the stale spawn line
  until a separate `npm run build` in `mcp-server/`. Symptom: hooks
  worked (they import the live `ensure-daemon.js`); a cold start where
  the MCP server is the first to call `ensureDaemon()` would have
  spawned the wrong path. Caught by Codex in code review; fixed in
  commit `438f48b`.
- **`MessageBus.comms` map collision on `comm.id`.** Two
  `account_registrations` rows with `comm="telegram"` (Claude bot
  `8950482517` + Codex bot `8988792099`) both produced `TelegramCommAdapter`
  instances with `comm.id="telegram"`. The bus's `Map<CommId, CommAdapter>`
  let the second adapter overwrite the first. Whichever bot lost the
  race sat orphaned (constructed but never started, inbound handler
  wired to nothing). The surviving adapter then 409'd against whichever
  external process was already polling its bot (e.g. the Codex MCP
  server polling Codex's bot directly). Fixed by adding
  `accountId: AccountId` to `CommAdapter`, threading it through
  `CommAdapterFactory.create`, and keying the bus map by
  `(commId, accountId)`. See commit `db8b4fd`. Codex correctly diagnosed
  this from the map structure alone before the polling 409 was traced.
- **`registrationFor` was over-constrained by `bus.options.project`.**
  Once `bus.send` started calling `registrationFor(target)` to resolve
  `target.account` → `bot_user_id`, manually-started daemons (whose cwd
  ≠ project) silently broke outbound from `openClaudeQuery`: the
  label-fallback lookup filtered by `bus.options.project = process.cwd()`,
  found nothing, and threw `no account registration for telegram/main`.
  Fix: widen the label fallback to all projects after the cwd-scoped
  lookup misses. Daemon is per-user, not per-project; cwd is just a
  hint. See commit `081b550`.
- **Adapter polling errors are silent by default.** When the daemon's
  Telegram adapter went `connected → degraded` repeatedly with no
  visible cause, the actual `polling_error` text (`ETELEGRAM: 409
  Conflict`) was being swallowed. The fix was diagnostic: temporarily
  log the error payload in the adapter's `polling_error` handler.
  Worth keeping a debug-mode toggle for this; otherwise future
  poll-failure bugs reduce to "stuck in degraded for unknown reason."
