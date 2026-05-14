# Sequence: Daemon Bootstrap

Cold-start and warm-start paths for `ensureDaemon()`. The daemon is a per-user
singleton keyed on `(user, AGENTS_COMM_HOME)`; any hook activation in any
project calls `ensureDaemon()` and either attaches to the existing daemon or
spawns one.

## Cold start (no daemon running)

```mermaid
sequenceDiagram
    autonumber
    participant Hook as Plugin Hook
    participant ED as ensureDaemon()
    participant FS as ~/.agents-comm/
    participant Daemon as Daemon Process

    Hook->>ED: ensureDaemon()
    ED->>FS: connect(daemon.sock)
    FS-->>ED: ECONNREFUSED / ENOENT
    Note over ED: Probe failed → cold start

    ED->>FS: open(daemon.lock, O_EXCL|O_CREAT)
    FS-->>ED: lock acquired
    ED->>Daemon: spawn detached<br/>(plugin-bundled binary)
    Daemon->>FS: write daemon.pid
    Daemon->>FS: bind daemon.sock
    Daemon-->>ED: ready (via socket accept)
    ED->>Daemon: handshake{client_version, protocol_version}
    Daemon-->>ED: handshake_ack{daemon_version, protocol_version}
    ED->>FS: unlink daemon.lock
    ED-->>Hook: client (connected)
    Hook->>Daemon: IPC requests (per-feature)
```

## Warm start (daemon already running)

```mermaid
sequenceDiagram
    autonumber
    participant Hook as Plugin Hook
    participant ED as ensureDaemon()
    participant FS as ~/.agents-comm/
    participant Daemon as Daemon Process

    Hook->>ED: ensureDaemon()
    ED->>FS: connect(daemon.sock)
    FS-->>ED: connected
    ED->>Daemon: handshake{client_version, protocol_version}
    Daemon-->>ED: handshake_ack{daemon_version, protocol_version}
    ED-->>Hook: client (connected)
    Hook->>Daemon: IPC requests
```

## Crash recovery (stale pidfile + dead socket)

```mermaid
sequenceDiagram
    autonumber
    participant Hook as Plugin Hook
    participant ED as ensureDaemon()
    participant FS as ~/.agents-comm/

    Hook->>ED: ensureDaemon()
    ED->>FS: connect(daemon.sock)
    FS-->>ED: ECONNREFUSED
    ED->>FS: read daemon.pid
    FS-->>ED: pid = 12345
    ED->>ED: kill(pid, 0) → ESRCH (dead)
    Note over ED: Stale state — clean up
    ED->>FS: unlink daemon.pid
    ED->>FS: unlink daemon.sock
    ED->>FS: unlink daemon.lock (if present)
    ED->>ED: retry cold start
```

## Notes

- **Socket probe is the source of truth for liveness.** A pidfile is only
  consulted to identify a dead daemon for cleanup; we never trust it to mean
  "alive."
- **`O_EXCL` lockfile races safely.** Two hooks racing to bootstrap will both
  probe-fail; whichever loses the `O_EXCL` open retries the socket probe in a
  short loop and attaches to the daemon the winner spawned.
- **Daemon is spawned detached from the plugin-bundled binary.** The hook
  process can exit immediately after handshake; the daemon outlives it.
- **Handshake is mandatory on every connect.** Mismatched protocol versions
  fail loudly with an actionable upgrade message rather than degrading silently.
- **Lockfile is released after handshake**, not after spawn — so a daemon that
  spawns but fails to handshake doesn't leave a permanently-held lock.
