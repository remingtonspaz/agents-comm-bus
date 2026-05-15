# Transition Release

The v4 transition release keeps old Telegram layouts readable while the
`agents-comm-bus` daemon becomes the authoritative owner of runtime state.
This compatibility is temporary and is marked in code with
`transition-only` and cleanup release `v4.1-cleanup`.

## Temporary Fallbacks

Allowed transition-only fallbacks:

- Read legacy `last-chat.json` only when no daemon conversation inventory row
  exists yet. Import it as conversation inventory metadata, not routing state.
- Read legacy `pending-permission.json` only for a fresh request that predates
  daemon startup. Import it as a durable `Query` candidate with TTL semantics.
- Inspect legacy `queue.json` for read-only first-run ingestion. New inbound
  delivery must use daemon state.

These fallbacks must not start Telegram polling outside the daemon, write new
legacy state, copy bot tokens into ordinary JSON state, or restore the old
Claude/Codex split as the ownership model.

## Credential Handling

Credential files are discovery inputs only:

- `<project>/.claude/telegram.json`
- `<project>/.codex/telegram.json`
- `~/.claude/telegram.json`
- `~/.codex/telegram.json`

The migration command reports sanitized credential candidates and uses an
opaque `credentialRef`. Registration requires explicit confirmation with
`--confirm-credentials`. Raw bot tokens are never included in migration results
or audit details.

## Cleanup Window

The transition reader code and standalone fallback behavior are scheduled for
removal in `v4.1-cleanup`, after one release where migration is available and
documented. Before removal, tests under `tests/migration/` must be updated to
assert the readers are gone or fail closed.
