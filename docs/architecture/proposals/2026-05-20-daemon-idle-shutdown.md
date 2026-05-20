# Daemon idle shutdown via session liveness - proposal

**Status:** proposal, follow-up after session owner PID tracking
**Author origin:** synthesized from Telegram discussion between the human,
Claude, and Codex on 2026-05-20.

## Motivation

The daemon is intentionally lazy-bootstrapped and per-user. Today, once it
starts, it tends to keep running until manually killed, replaced by
`ensureDaemon()` during a version mismatch, or terminated by the OS.

Session owner PID tracking creates a path toward a more courteous lifecycle:
when no agents are alive and no daemon work is pending, the daemon can shut
itself down after a grace period. The next hook or MCP call will respawn it
from the currently installed bundle. That helps with:

- resource hygiene: no idle WebSocket port, SQLite handle, or comm polling loop
  after all agent sessions are gone;
- upgrade behavior: stale daemon versions naturally age out after idle exit;
- recovery: owner PID checks can catch stale leases when sockets or shims do
  not close cleanly.

This is not a replacement for the optional service-install mode planned later.
It is a better default for the existing lazy-bootstrap mode.

## Current signals

### Codex

Codex now has meaningful owner PID tracking for managed app-server sessions:

- the MCP shim registers a session owner PID;
- the daemon stores that PID on the session lease;
- `CodexBridge` checks active leases periodically;
- if the owner PID dies, the bridge releases the lease and runs the existing
  verified managed app-server cleanup path.

For Codex, a live owner PID is a useful "agent session is still alive" signal.

### Claude

Claude hook-side registration can populate `owner_process_pid`, but Claude
leases are currently short-lived per hook:

1. hook opens daemon IPC;
2. hook calls `claude_register_session`;
3. hook drains/opens query/etc.;
4. hook process exits and the IPC socket closes;
5. daemon releases the lease, usually within a few hundred milliseconds.

That means Claude may be alive while there is no active lease and no live owner
PID recorded. Until a future long-lived Claude lease owner exists, PID-only
idle detection would incorrectly treat an idle-but-open Claude session as gone.

## Proposed idle predicate

Do not use "no live tracked PIDs" as the sole shutdown trigger.

The daemon should enter the idle candidate state only when all of these are
true:

- no active IPC clients that represent live agent or MCP control connections;
- no active session leases with live owner PIDs;
- no open queries;
- no pending inbound messages waiting for agent delivery;
- no in-flight adapter sends or adapter startup/shutdown work;
- no recent inbound or outbound comm activity inside the grace window;
- no comm adapter has reported pressure or transient failure that needs a retry.

Sessions without owner PID should be treated conservatively. If they still hold
a socket lease, they count as live. If they do not hold a lease, they should not
alone keep the daemon alive indefinitely.

After the idle predicate remains true for a grace period, the daemon can shut
down cleanly:

1. stop comm adapters so polling ownership is released intentionally;
2. close the IPC server;
3. remove or retire discovery files (`port`, `daemon.pid`);
4. close storage;
5. exit.

Suggested initial grace period: 10-15 minutes, configurable.

## Prerequisites

### Durable polling offset / duplicate suppression

Auto-shutdown makes daemon restarts normal rather than exceptional. Telegram
polling offset and duplicate suppression are currently too process-memory
dependent for that to be comfortable.

Before idle shutdown lands, persist enough comm progress to prevent duplicate
redelivery after restart. Options:

- persist Telegram polling offset per `(comm, bot_user_id)`;
- or persist a recent processed platform-update/message id window;
- ideally do both only if testing shows offset alone is insufficient.

This is a correctness prerequisite, not just an optimization.

### Activity accounting

The daemon needs explicit activity counters/timestamps instead of deriving
idleness indirectly from sessions alone:

- active IPC client count;
- active agent-control connection count, if distinct from one-shot tool calls;
- open query count;
- pending inbound count;
- in-flight outbound send count;
- most recent inbound/outbound timestamp.

This accounting should live in daemon runtime code, not inside a specific
adapter.

### Claude long-lived lease owner

For parity with Codex, Claude should eventually have a long-lived session owner
process. The cleanest shape is likely a small Node sidecar launched by
`wake-support.js` alongside `enter-watcher.ps1`:

- registers/holds a persistent daemon IPC connection;
- uses `owner_process_pid = claude.exe PID`;
- exits when `claude.exe` dies, causing normal socket-close lease release;
- keeps `enter-watcher.ps1` focused on keystroke delivery.

Teaching the PowerShell watcher the WebSocket IPC protocol is possible but
unnecessarily couples keystroke delivery to daemon lease ownership.

This sidecar is not strictly required before idle shutdown if the idle predicate
also uses IPC/activity/recent-comm signals, but it makes Claude liveness more
explicit and symmetric.

## Suggested sequencing

1. Persist comm polling progress / duplicate suppression across daemon restarts.
2. Add daemon activity accounting and tests for the idle predicate.
3. Add Claude long-lived lease-owner sidecar, or explicitly document why the
   first idle-shutdown version does not require it.
4. Add idle shutdown behind a conservative config flag or long default grace
   period.
5. Revisit defaults after real usage.

## Open questions

1. What is the right initial idle grace period: 5, 10, or 15 minutes?
2. Should idle shutdown be enabled by default in development installs only, or
   in all lazy-bootstrap installs?
3. Should inbound comm activity keep the daemon alive even when no agent
   sessions are currently active?
4. Is Telegram polling offset enough, or do we also need durable recent-message
   dedupe to avoid duplicate transcript/pending-inbound records after restart?
5. How should optional future service mode override idle shutdown? Likely:
   service mode disables auto-exit by default.

## Non-goals

- Do not add idle shutdown to service-install mode until that mode exists.
- Do not make PID liveness the only daemon lifecycle signal.
- Do not let daemon idle exit bypass graceful adapter shutdown.
- Do not couple Claude's PowerShell keystroke watcher to daemon IPC unless a
  Node sidecar proves insufficient.

