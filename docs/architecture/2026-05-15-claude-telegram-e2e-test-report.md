# Claude + Telegram E2E Test Report

- **Date:** 2026-05-15
- **Branch:** `universal-overhaul`
- **Guide:** [`claude-telegram-e2e-test-guide.md`](./claude-telegram-e2e-test-guide.md)
- **Outcome:** Steps 1–10 of the test guide all exercised end-to-end. Inbound, outbound, wake-trigger, and permission-query Telegram routing are all confirmed working after the LE-7/LE-9/LE-10 fixes landed during this session.

## Scope

Followed the test guide steps 1–7 to validate the daemon-bootstrap +
explicit-account-registration + MCP-shim + hook delivery path. Found
two real bugs blocking step 7 and one cluster of operational loose
ends that did not block the test.

## Issues found and fixes applied

### 1. Missing SQL schema in `dist/` (blocked step 2)

`agents-comm-bus`'s `build` script was just `tsc`, which only emits
`.js`/`.d.ts` for `.ts` sources. `src/storage/schema/001_initial.sql`
is read at runtime by `dist/storage/schema/runner.js` via
`import.meta.url` and was never copied into `dist/`.

Symptom: `account-add` crashed with
`ENOENT: ... dist/storage/schema/001_initial.sql`, and
`~/.agents-comm-bus/agents-comm-bus.db` stayed at 0 bytes — silently,
because the CLI exits non-zero but state-on-disk is the only thing the
guide later checks.

Fix landed in commit `a57e1aa` (Satrio):

- `agents-comm-bus/scripts/copy-assets.js` recursively copies `.sql`
  from `src/storage/schema/` to `dist/storage/schema/`.
- `package.json`'s `build` now runs `tsc && node scripts/copy-assets.js`.

### 2. Daemon ignored account registrations (blocked step 7)

The daemon attached a Telegram adapter only when
`process.env.TELEGRAM_BOT_TOKEN` was set in **its own** environment at
startup (`agents-comm-bus/src/daemon.ts:45`, pre-fix). It never read
account registrations from SQLite. The CLI's `account-add` was
therefore decorative: it inserted a row that nothing ever consulted.

Compounding problem: `defaultSpawnDaemon` in
`bootstrap/ensure-daemon.ts:175` propagates the spawning process's
env to the daemon. Whoever first calls `ensureDaemon()` wins. In
practice the hooks ran before the MCP server, so the daemon inherited
a hook env with no `TELEGRAM_BOT_TOKEN`, attached zero adapters, and
never polled Telegram. The DB grew (sessions, queries, audit) but
`~/.agents-comm-bus/chats/` stayed empty.

Fix landed in commit `8fd20ea`:

- Daemon enumerates `storage.listAccountRegistrations({comm:"telegram"})`
  at startup and attaches one `TelegramCommAdapter` per row, deduped by
  `bot_user_id`.
- New `resolveTelegramCredentials()` resolves `credentials_ref`:
  - `env:VARNAME` — reads `process.env[VARNAME]`; if missing, falls back
    to reading `<registration.project>/.claude/telegram.json`.
  - `file:<absolute-path>` — reads a JSON file with `{ botToken, userId? }`.
- `allowedUserIds` merges `TELEGRAM_USER_ID` (env, CSV) with `userId`
  from the project's `telegram.json`.
- Legacy env-only path preserved as fallback when zero accounts are
  registered.

## Steps to current working state

1. Verified build outputs from prior `npm run build` runs existed under
   `agents-comm-bus*/dist` and `mcp-server/dist`. Found the missing SQL
   asset (issue 1) and copied it manually so the CLI could proceed —
   the proper build fix landed independently in `a57e1aa`.
2. Registered the Telegram account against this project via
   `node agents-comm-bus/dist/cli/index.js account-add --project ... --agent claude --account-label main` with `TELEGRAM_BOT_TOKEN` exported.
   Bot `refactor_claude_test_bot` (`bot_user_id=8950482517`) registered.
3. Updated `.mcp.json` to include `TELEGRAM_BOT_TOKEN` and
   `TELEGRAM_USER_ID` in the `telegram` server's `env` block.
4. Repointed hooks in `.claude/settings.local.json`:
   - `UserPromptSubmit` → `hooks/claude/user-prompt-submit.js`
   - `PermissionRequest` → `hooks/claude/permission-request.js`
   - `SessionStart` unchanged.
5. Diagnosed the missing inbound (issue 2) via daemon audit log and
   source read.
6. Patched `agents-comm-bus/src/daemon.ts` (commit `8fd20ea`) and rebuilt.
7. Stopped the running daemon (PID 64780), cleared
   `~/.agents-comm-bus/{port,daemon.pid}`, and started a fresh daemon.
   A duplicate daemon (PID 16044) auto-spawned in the same second from
   another caller; the two pollers conflicted on Telegram's
   `getUpdates` lock until PID 16044 was killed.
8. Asked the user to send a fresh `Test 1234` message to
   `@refactor_claude_test_bot`. The `UserPromptSubmit` hook on the
   user's next submit injected the message into the prompt context with
   full envelope:

   ```
   [Daemon Inbound Messages]
   [2026-05-15T23:40:07.829Z] satrio_d_r (comm=telegram account=8950482517 chat_native_id=8296218244 conversation_id=conv_edf117fc37de0ae83bde3d2b platform_message_id=7 message_id=telegram:7): Test 1234
   [End Daemon Inbound Messages]
   ```

   Inbound path confirmed working.

## Loose ends

### LE-1. ~~`chats/*/transcript.jsonl` not written~~ — RESOLVED (false alarm)
Re-checked during step 10. `~/.agents-comm-bus/chats/conv_edf117fc37de0ae83bde3d2b/transcript.jsonl`
exists with one record per inbound and outbound (3 records total at
inspection time, including the outbound test). The earlier "missing"
read was just timing — the file is written incrementally by
`JsonlTranscriptStore` after each `bus.send` / `enqueueInbound`. Test
guide step 10 is accurate.

### LE-2. `connection_state: "degraded"` is sticky
`adapters/comm/telegram.ts:56` calls `stateHandler?.("degraded")` on
every `polling_error` event but never transitions back to
`"connected"` when polling recovers. The flag was stuck at `degraded`
after a transient conflict was resolved, even though polling was
demonstrably working (the `Test 1234` message arrived). The state
should be re-asserted to `"connected"` on the next successful
`getUpdates` cycle (or on a timer since the last error).

### LE-3. Daemon spawn race after a kill
When the in-context daemon was killed and its discovery files removed,
another process spawned a duplicate daemon within ~1 second — likely a
hook or MCP server from a sibling Claude session calling `ensureDaemon`
concurrently with the manual relaunch. Both pollers attached the same
bot adapter and triggered Telegram's `409 Conflict: terminated by other
getUpdates request`. `bootstrap/spawn-lock.ts` exists, but the race in
this case was between an internal spawn and an external one that did
not go through the lock. Worth thinking about whether
`writeDaemonDiscoveryFiles` should be an atomic claim, or whether the
daemon should self-terminate when it sees an already-written `port`
file that points at a live PID different from its own.

### LE-4. Test-guide steps 8, 9, 10 — all exercised end-to-end
- **Step 8** (Claude → Telegram outbound via `telegram_send`) —
  exercised. `telegram_send` with explicit `chat_id` returned
  `message_id=telegram:9` and the user confirmed arrival. Passing
  `chat_id` was required because the MCP shim's session-resolution
  path uses `session="mcp"` (no most-recent-inbound for that
  synthetic session); same-session implicit targeting works for the
  hook path but not for MCP tool calls. Worth confirming whether
  that is intended.
- **Step 9** (permission query routed through daemon) — exercised
  successfully after LE-7, LE-9, and LE-10 fixes landed. An
  `AskUserQuestion` from this session produced a Telegram message
  with the question text + numbered options. The user confirmed
  `"Yes, arrived in Telegram"` on the fifth probe.
- **Step 10** (daemon-state inspection) — done. See LE-1 (former
  prediction now resolved).

### LE-5. Stale plugin-cache MCP servers
Multiple `~/.claude/plugins/cache/telegram-integration/telegram/1.1.0/mcp-server/dist/server.js`
processes are running from a prior plugin install (PIDs 31084, 41916,
42572, 66484, dated 2026-05-08). They are not polling this bot, but
they are long-lived node processes whose lineage is unclear. Worth a
sweep at some point.

### LE-6. `account-add` silent failure mode
The CLI returned a non-zero exit when the schema asset was missing,
but the user's transcript suggests it was not obvious from the
ergonomics that step 2 had failed — the next steps assumed a populated
DB. Consider having `account-add` either pre-flight the schema or
print a louder error.

### LE-7. ~~Wake watcher pipe is unwired~~ — RESOLVED

**Resolution summary.** Daemon-side `trigger-enter` writer landed in
upstream commit `546c027` (Wire Claude wake trigger path). The
hook/watcher-spawn side regressed to the broken patterns from
CLAUDE.md Sessions 4 and 5 and was fixed in this session — see the
"Resolved during this session" entry at the bottom.

Status verified end-to-end: with the watcher running and PostMessage
targeting the persistent `cmd.exe` parent of `claude.exe`, a fresh
Telegram message triggers a `.`+Enter into the correct Claude window
and the session wakes on its own. One remaining UX quirk: the
`SessionStart` hook does not fire reliably on Windows, so the first
prompt in a new Claude session must still be typed manually to spawn
the watcher (then subsequent inbound wakes work). Same as the
original plugin (CLAUDE.md Session 4 workaround).

Historical content of LE-7 follows for context.

---

The pre-existing Windows wake watcher (`scripts/enter-watcher.ps1`,
sourced from Sessions 4/5 of `CLAUDE.md`) types `.`+Enter into the
Claude console window via `PostMessage WM_CHAR` after observing a
`trigger-enter` file in
`~/.agents-comm-bus/claude-wake/sessions/<key>/`. This is what gives
the user a hands-off "Telegram message arrives → Claude starts a turn"
experience.

`docs/architecture/claude-wake-path.md` describes the contract: at
step 5 of inbound delivery, the Claude adapter writes `trigger-enter`
in the wake directory. In the current universal-overhaul build, that
writer does not exist. `agents-comm-bus/src/adapters/agent/claude.ts`
and `bus.ts` contain zero references to `trigger-enter` or
`claude-wake`. The only callers that touch those paths in the repo
are `hooks/session-start.js` (spawns the watcher) and the watcher
script itself.

Compounding: during this test the watcher itself was not running for
the universal-overhaul project. No `enter-watcher.ps1` process was
attached to this session and `~/.agents-comm-bus/claude-wake/` did
not exist at all. Either `SessionStart` did not fire (known
Claude Code harness issue per `CLAUDE.md` Session 4), or
`session-start.js` failed silently. The old plugin worked around
the `SessionStart`-doesn't-fire bug by spawning the watcher from
`UserPromptSubmit`; the new `hooks/claude/user-prompt-submit.js`
does not have that fallback.

Concretely the gap covers three pieces:
1. **Daemon-side writer.** When `MessageBus.enqueueInbound` runs (or
   the equivalent Claude-adapter hook), pick the active Claude session
   for the conversation's `(agent, project)` and write
   `~/.agents-comm-bus/claude-wake/sessions/<session-key>/trigger-enter`.
   Query-wake suppression (see `claude-wake-path.md`) belongs at this
   layer too.
2. **Session-key agreement.** `hooks/session-start.js` derives the
   wake dir from `basename(project) + fnv1a(project)`. The daemon
   needs to write to the same key — easiest if the hook stores the
   resolved path in the daemon's session record at register time.
3. **Watcher spawn resilience.** Either fix `SessionStart` to fire
   reliably (harness concern), or move the spawn-if-missing check
   into `user-prompt-submit.js` so the first prompt always ensures a
   live watcher.

Without LE-7 fixed, inbound Telegram messages still arrive in
context, but only on the user's next manual prompt submission. The
Claude session never wakes on its own.

### LE-8. ~~Real harness permission prompts don't reach the daemon~~ — RESOLVED (misdiagnosed)

The original three hypotheses turned out to all be wrong. A
heartbeat trace added to `permission-request.js` later in the
session confirmed the hook *was* being invoked for both
`AskUserQuestion` and unallowlisted `PowerShell`/`Bash` calls, and
it *was* reaching `claude_open_query`. The actual failure was on the
daemon side: `UNIQUE constraint failed: queries.session_id`. See LE-10.

Once LE-10 landed, no further changes to the hook contract were
needed. Historical content follows.

---

During step 9 testing the user confirmed that permission prompts DO
appear in their Claude Code CLI and they have been approving them
locally. Yet the `queries` table in the daemon DB contains only three
rows after a long session: the very first `AskUserQuestion` at 4:22
PM (under the old `permission-telegram.cjs` compatibility wrapper),
plus two probe rows added manually during this investigation. None of
the user's real permission approvals produced a query row.

Verification work that narrowed the cause:
- A direct IPC `claude_open_query` call against the running daemon
  inserted a row and emitted `query_opened` in audit. The daemon path
  is functional.
- A synthetic invocation of `hooks/claude/permission-request.js` with
  a JSON payload fed via `cmd /c node hook.js < payload.json` also
  inserted a row. The hook code is functional when given a real
  stdin.
- A PowerShell-pipe invocation (`$payload | node hook.js`) silently
  fail-closed at `readStdinJson()` returning null, with empty stderr,
  matching the symptom.

So the bug is at the harness/hook contract boundary. Three plausible
shapes:
1. The current Claude Code version isn't invoking `PermissionRequest`
   for the tools we tried (`AskUserQuestion`, `Bash(echo …)`,
   `WebFetch(example.com)`, `Bash(arp -a)`). The first AskUserQuestion
   at 4:22 PM did invoke the hook, so the hook *can* be triggered;
   something has changed since.
2. The harness is invoking the hook with an input shape that
   `readStdinJson()` reads as empty (e.g. arg-flag delivery, env-var
   delivery, or a different stdin framing on Windows that closes the
   stream before any bytes flush). Empty stdin takes the early-exit
   `{ behavior: "ask" }` branch with no audit trail at all.
3. The user is seeing Claude Code's *built-in* permission UI, which
   fires whether or not the hook does. The hook may be running in
   parallel and silently failing, but the UI the user sees is not
   sourced from the hook output.

A one-line `fs.appendFileSync` heartbeat at the top of
`permission-request.js` would distinguish (1) from (2)/(3) within one
real prompt. The investigation did not get to that step because the
hook file was being modified concurrently as part of the LE-7 fix.

Until LE-8 is resolved, step 9's contract — "Claude permission flow
goes through daemon-backed `Query` records" — is unverified for real
usage. The daemon-side machinery is ready; the harness leg is what
needs ground-truth tracing.

### LE-9. ~~`drainClaudeInbound` does not set `most_recent_inbound_conversation_id`~~ — RESOLVED (different root cause)

Direct probing showed the UPDATE inside `setSessionMostRecentInbound`
worked fine (`changes: 1`). The real bug was that
`claude_register_session` runs before every hook operation
(drain AND open_query) and unconditionally upserted the row with
`most_recent_inbound_conversation_id = null`, clobbering whatever
`setSessionMostRecentInbound` had just written. Fixed by removing
the column from the `ON CONFLICT(session_id) DO UPDATE SET` clause
in `agents-comm-bus/src/storage/sqlite.ts` so the value persists
across re-registrations. Verified — session row now shows the
correct conversation id.

Historical content follows.

---

The session row for this Claude session has
`most_recent_inbound_conversation_id = NULL` despite the
`UserPromptSubmit` hook having drained at least two inbound Telegram
messages from the daemon (`Test 1234` and `New test`). The drain
returned the messages — they reached prompt context — but the
companion column update did not stick.

`agents-comm-bus/src/daemon.ts:184-200` does:

```ts
async function drainClaudeInbound(...) {
  const session = typeof params.session === "string" ? params.session as SessionId : undefined;
  const drained = context.pendingInbound.splice(0);
  if (session && drained.length > 0) {
    await context.storage.setSessionMostRecentInbound(
      session,
      drained[drained.length - 1].conversation.conversation_id,
    );
  }
  return drained;
}
```

`setSessionMostRecentInbound` is a plain `UPDATE sessions SET ...
WHERE session_id = ?`. If the `session_id` value the hook sent does
not match an existing row, the UPDATE silently affects 0 rows and the
caller never knows. Likely root cause: the hook calls
`claude_register_session` to upsert the session row, then
`claude_drain_inbound` — but between the two daemon restarts during
this session the session row may have been recreated with a different
key, or the upsert and the drain are racing in some way that leaves
the column unwritten.

Suggested fix: change `setSessionMostRecentInbound` to return the
row count and either re-upsert + retry on 0, or surface the failure
in the IPC response so the hook can log it. Independent of root
cause, the silent-no-op behavior is the structural defect — the rest
of the query-routing path depends on this column and currently has no
indication when the linkage is broken.

### LE-10. `queries.session_id` UNIQUE constraint deadlock — RESOLVED

The partial unique index `idx_queries_one_open_per_session` enforces
"one open (unresolved) query per session", which is the right
semantic in isolation. But Claude Code's `PermissionRequest` hook
contract has no way to mark the query resolved when the user
answers locally — the harness shows its built-in UI in parallel
with the hook and never re-invokes the hook to deliver the
selection. So every query the hook opens stays in `resolved_at = NULL`
forever, and the very next permission prompt in the same session
hits `UNIQUE constraint failed: queries.session_id`.

Confirmed via heartbeat trace — the very first AskUserQuestion at
4:22 PM successfully landed a row; every subsequent permission
prompt failed with this constraint. That is why the daemon's
`queries` table only had 1 real entry across the whole session
prior to the fix.

Fixed in `agents-comm-bus/src/{daemon.ts, storage/sqlite.ts}`:

- New `SqliteSessionStorage.supersedeOpenQueriesForSession(session, now)`
  marks any open query for the session as `resolved_at = now,
  resolution_json = {"kind":"superseded"}`.
- `openClaudeQuery` calls it before `bus.openQuery` so the partial
  unique index is never violated by the local-UI-resolves-locally
  pattern.

Side effect to be aware of: if a query was already routed to
Telegram and the user is mid-typing a reply for it, a new query in
the same session will mark the old one superseded. A subsequent
Telegram reply for the old query will currently match via
`tryResolveOpenQuery` *only* if it arrives before the supersede;
after, it will be ignored. Acceptable for now since the local UI
is the authoritative resolver; worth revisiting if/when Telegram
reply routing for queries becomes a first-class flow.

## Resolved during this session

Code changes landed beyond the upstream commits:

- **`agents-comm-bus/src/storage/sqlite.ts`** —
  1. Removed `most_recent_inbound_conversation_id` from
     `upsertSession`'s `ON CONFLICT DO UPDATE SET` clause so
     `claude_register_session` does not clobber the value
     `claude_drain_inbound` writes (LE-9).
  2. Added `supersedeOpenQueriesForSession` (LE-10).
- **`agents-comm-bus/src/daemon.ts`** — `openClaudeQuery` now calls
  `supersedeOpenQueriesForSession` immediately before `bus.openQuery`
  so each new permission/question query gets a clean slate (LE-10).
- **`hooks/claude/wake-support.js`** — full rewrite of the watcher
  spawn path (LE-7):
  - Uses `Start-Process -PassThru | Select-Object -ExpandProperty Id`
    via `execSync` so the spawned watcher actually persists (Node
    `spawn` with `detached:true` is unreliable on Windows — CLAUDE.md
    Session 4).
  - Walks the full process tree past the *transient* cmd.exe (child
    of `claude.exe`, which dies with the hook) and returns the
    *persistent* cmd.exe (parent of `claude.exe`, which owns the
    visible console window) — CLAUDE.md Session 5.
  - Resolves the cmd.exe's `MainWindowHandle` directly and passes
    `-WindowHandle` to the watcher script, falling back to
    `-TargetPid` only if hwnd resolution fails.
  - Adds a `watcher.lock` file so concurrent hook invocations don't
    race to spawn duplicate watchers.

## Open follow-ups

- **Telegram-to-Claude reply routing for permission queries.** The
  daemon now opens query records and writes them to Telegram, and
  the watcher already knows how to type `y`/`n`/`a` if a
  `permission-response.json` exists in the wake dir. But nothing on
  the daemon side currently writes that file when a matching
  inbound reply arrives. `bus.tryResolveOpenQuery` exists but only
  records the resolution in the DB — it does not bridge to the
  watcher. Until that bridge lands, replying `y` in Telegram does
  nothing visible to Claude; the user still has to answer locally.
- **SessionStart hook unreliable on Windows.** First-prompt seed
  behavior persists. The original plugin worked around it by also
  ensuring the watcher in `UserPromptSubmit`. The new
  `user-prompt-submit.js` already calls `ensureClaudeWakeWatcher`, so
  technically the workaround is wired — but the *first* prompt is
  still required to land before the daemon has anywhere to deliver
  inbound. Worth investigating whether `hooks/session-start.js` ever
  fires on this Claude Code version.
- **LE-2, LE-3, LE-5, LE-6** remain open — small ergonomic /
  hygiene items, not blockers.

## Files of interest

- `agents-comm-bus/src/daemon.ts` — credentials resolver + DB-driven
  adapter attachment (commit `8fd20ea`); now also calls
  `supersedeOpenQueriesForSession` before each `bus.openQuery`.
- `agents-comm-bus/src/storage/sqlite.ts` — `upsertSession` no
  longer clobbers `most_recent_inbound_conversation_id`; adds
  `supersedeOpenQueriesForSession`.
- `agents-comm-bus/scripts/copy-assets.js` + `package.json` build
  script (commit `a57e1aa`).
- `hooks/claude/wake-support.js` — `Start-Process`-based watcher
  spawn + persistent-cmd.exe targeting.
- `.mcp.json` (gitignored) — `telegram` MCP server env block.
- `.claude/settings.local.json` (gitignored) — hook command paths.
- `~/.agents-comm-bus/audit/{2026-05-15,2026-05-16}.jsonl` —
  observability artifacts.
