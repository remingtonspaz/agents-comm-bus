# Distributability and Lifecycle

How the daemon ships, starts, upgrades, and recovers — written from the
perspective of a user who installs the plugin and never thinks about a
"daemon" at all.

## Spawn protocol

The daemon is started on demand by the first hook that needs it. The protocol
is intentionally crash-safe and race-safe.

```
ensureDaemon():
    if connect(daemon.sock) succeeds:
        handshake()
        return client
    if daemon.pid exists and kill(pid, 0) == ESRCH:
        unlink daemon.pid, daemon.sock, daemon.lock   # stale, clean up
    if open(daemon.lock, O_EXCL|O_CREAT) succeeds:
        spawn detached <plugin>/bin/agents-comm-daemon
        wait for daemon.sock to accept (bounded retry)
        handshake()
        unlink daemon.lock
        return client
    # Lost the race — another hook is bootstrapping
    sleep + retry connect(daemon.sock)
```

The lockfile is only held across spawn → handshake; if the daemon spawns but
handshake fails, the lock is still released so the next hook can retry rather
than wedge forever.

## Single daemon per `(user, AGENTS_COMM_HOME)`

Ownership is keyed on the OS user and the `AGENTS_COMM_HOME` env (default
`~/.agents-comm/`), not per-project. A user with the plugin installed globally
across ten Claude Code projects gets exactly one daemon — not ten — and that
daemon owns Telegram polling for all of them.

Multi-tenant or multi-account setups override `AGENTS_COMM_HOME` per shell to
get separate daemons with independent state and credentials.

## Protocol / version handshake

Every client connection starts with:

```
client → daemon: { protocol_version, client_version }
daemon → client: { protocol_version, daemon_version }
```

If `protocol_version` doesn't match, the daemon refuses the connection with an
actionable error: *"daemon is protocol v3, client is v2 — restart Claude Code
or upgrade the plugin."* No silent degradation, no "best-effort" mode where
half the messages route correctly.

`daemon_version` and `client_version` are informational (logged for support);
only `protocol_version` is a compat gate.

## Stable state path, unstable code path

| Path | Mutability | Contents |
| ---- | ---------- | -------- |
| `~/.agents-comm/` | stable across upgrades | `daemon.sock`, `daemon.pid`, `daemon.lock`, durable inbox/outbox, permission store, audit log, bindings, credentials |
| `<plugin install>/` | rewritten on every plugin upgrade | daemon binary, hook scripts, MCP server bundle |

The daemon records the absolute path of the executable that launched it so
operators can answer "which install is currently running?" without guessing.
State is *never* written into the plugin install dir; that dir can be moved,
overwritten, or deleted by a plugin upgrade and the daemon (already running)
survives because it doesn't depend on those files post-spawn.

## No standalone polling fallback

If `ensureDaemon()` cannot start the daemon — binary missing, port/socket
permission denied, lockfile stuck — the hook **fails loudly**. It does not
fall back to polling Telegram from the hook process itself.

Rationale: Invariant 1 (one comm owner per account). A "fallback" polling
shim would compete with a future daemon for the same account's `getUpdates`
slot and produce intermittent 409s that are extremely hard to diagnose.

## Optional service install

For users who want the daemon to run independently of any Claude Code session
(e.g. always-on Telegram availability), there is an opt-in CLI:

```
agents-comm install-service   # systemd-user / launchd / Windows-service
agents-comm uninstall-service
```

The default UX is session-spawned-on-demand; service install is for power
users and is documented separately. Either way, the same `ensureDaemon()`
protocol is used by hooks — they don't know or care whether the daemon was
spawned by them or by the OS service manager.

## Crash recovery

Three failure modes, all recovered by the next `ensureDaemon()`:

1. **Daemon crashed, files left behind.** `daemon.pid` points to a dead PID
   and `daemon.sock` is unresponsive. The probe sequence detects this
   (`connect` fails → `kill(pid, 0)` returns `ESRCH`) and unlinks all stale
   files before retrying cold start.
2. **Lockfile orphaned by a spawner crash.** `daemon.lock` exists but no
   daemon ever came up. The next hook's socket probe fails, the cleanup
   branch unlinks the lock alongside the dead pid/sock, and bootstrap retries.
3. **Daemon hung but process alive.** Probe times out, but `kill(pid, 0)`
   succeeds. We do **not** auto-kill in this case — that's an operator
   decision (`agents-comm restart`). Auto-killing risks killing a healthy
   daemon that's just slow to handshake under load.

## Binary-discovery rule

Each plugin (Claude's, Codex's, future ones) bundles its own copy of the
`agents-comm-daemon` binary under its own install dir. The spawning hook
uses **its own plugin's** bundled binary — it does not search PATH, it does
not look in the other plugin's install dir.

Two plugins racing to spawn is fine: they ship the same daemon bytes from the
same release, so whichever loses the `O_EXCL` race attaches to the winner's
daemon and its on-disk binary just stays dormant. No coordination across
plugin install dirs is required, which keeps each plugin independently
installable and upgradable.
