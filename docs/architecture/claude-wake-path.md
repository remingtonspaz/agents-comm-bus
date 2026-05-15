# Claude Wake Path

Claude Code needs a watcher on Windows because the current harness has no
daemon-native way to wake an idle Claude session. The watcher is a Claude
adapter detail only: it sends keystrokes to the Claude terminal after the daemon
has already decided a wake is appropriate.

## Ownership Boundary

`agents-comm-bus` owns comm state, routing, account registrations,
conversations, queries, and durable session records under:

```text
~/.agents-comm-bus/
```

`scripts/enter-watcher.ps1` owns only the local keystroke bridge into a Claude
window. It watches a Claude wake directory for `trigger-enter` and then uses
`PostMessage WM_CHAR` to type into that window. It must not poll Telegram, infer
reply targets, pick conversations, mutate daemon records, or decide whether a
query should wake Claude.

New Claude wake files should live under:

```text
~/.agents-comm-bus/claude-wake/sessions/<session-or-project-key>/
```

During the transition release, hooks may still pass a legacy
`~/.claude-telegram/<session>/` path with `-SessionDir`. The watcher accepts the
path unchanged for compatibility, but that path is not the authoritative state
root for new writes.

## Daemon-Driven Wake

Normal inbound delivery follows this order:

1. The comm adapter normalizes the inbound message and hands it to the daemon.
2. The daemon resolves the explicit `(comm, bot_user_id)` account registration.
3. The daemon durably records the conversation, transcript, and audit entry.
4. The Claude adapter decides whether the target Claude session can be woken.
5. If wake is allowed, the adapter writes `trigger-enter` in the Claude wake
   directory.
6. The watcher observes `trigger-enter` and types the wake characters into the
   already-running Claude window.

This preserves the durable-before-wake invariant: if the process dies after the
message is stored but before Claude wakes, the message remains recoverable on
the next daemon/session pass.

## Query Wake Suppression

Queries are daemon records with resolved-once and TTL semantics. When a Claude
hook opens a query, the per-query connection lifetime is the query lease. While
that query is open, inbound replies that resolve the query should complete the
query path instead of creating an unrelated normal-turn wake.

The suppression decision belongs to the daemon and Claude adapter, not to the
watcher. The watcher may type a transition `permission-response.json` or
`slash-command.json` response after it is triggered, but those files are only a
keystroke bridge. They are not durable query state and must not become a second
comm ownership model.

## Session Collision

A live Claude session lease is scoped by `(agent, project)`, not just by
`session_id`. While a Claude lease is active for a project, a second Claude
session for the same project must be refused. A second session for another
project, or another agent with its own adapter semantics, is a separate lease
decision.

The current storage API exposes `acquireSessionLease(session_id, connection_id,
at)`, which protects a single session row. Phase 2 integration still needs a
storage or daemon helper that atomically refuses a live same-agent/same-project
lease before the new Claude session becomes active.
