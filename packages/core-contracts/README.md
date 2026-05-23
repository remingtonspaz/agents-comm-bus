# packages/core-contracts

Shared types, contracts, records, query semantics, security invariants, and the
`Storage` interface for the agents-comm-bus daemon and adapter shims.

This package contains **no runtime implementation** — only the type surface and
pure invariants that both the daemon and host-side shims depend on.

## Build

```bash
npm run build       # tsc compile to dist/
npm run typecheck   # tsc --noEmit
```

## Test

```bash
npm test
```

**What `npm test` covers** (explicit list, 34 assertions):

- `query-resolution.test.ts` — `tryResolve`, `matchReplyToQuery`, `hasOpenQuery`
- `query-staleness.test.ts` — TTL expiry, duplicate-resolution rejection
- `security-loop-prevention.test.ts` — hop limits, foreign-bot policy, origin assertions
- `session-lease.test.ts` — connection-loss query ownership cleanup

All four tests import **only** from this package (`packages/core-contracts/src/`).
They exercise pure functions and type contracts; they do **not** start a daemon,
open WebSockets, or touch SQLite.

**What `npm test` does NOT cover:**

- Tests that import from `core-daemon/` (daemon runtime, bridges,
  adapters, storage impl) — e.g. `codex-turn-control.test.ts`,
  `sqlite-schema.test.ts`, `claude-wake.test.ts`, `telegram-comm-adapter.test.ts`.
- Bridge-specific behavior (Codex turn control, Claude wake registry, etc.).

Run those via the daemon package (`cd agents-comm-bus && npm test`) or direct
root-level `node --test --import tsx ...` commands for ad-hoc architecture test
groups.
