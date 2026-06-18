# @agents-comm-bus/pi-agents-comm

Pi host extension for [agents-comm-bus](https://github.com/earendil-works/agents-comm-bus): comm tools (`comm_send_message`, `comm_check_messages`, …) and inbound message delivery for Pi coding-agent sessions.

## Install

**Local dev (monorepo checkout):**

```bash
pi -e ./plugins/pi/agents-comm
```

Or add a local path in `.pi/settings.json` pointing at this directory.

**Released package (Option B):** after CI syncs this tree to the dedicated Pi package repo:

```bash
pi install git:github.com/<you>/pi-agents-comm@v1
# or
pi install npm:@agents-comm-bus/pi-agents-comm
```

## Prerequisites

Register at least one comm account for the `pi` agent on your project:

```bash
agents-comm account-add \
  --project "<absolute project path>" \
  --agent pi \
  --account-label main \
  --comm telegram \
  --bot-token "<token>"
```

Replace `telegram` with `discord`, `matrix`, or `curl` as needed.

## Dev mode

When developing against a monorepo checkout, place `.agents-comm-bus-dev.json` at the repo root. The extension's daemon client will use the shared `entryEnsures` seam (see `docs/research/pi/README.md` § Dev mode) so the dev daemon, discovery root, and state paths resolve correctly.

**Phase 4 prerequisite:** `entryEnsures` lives in `hosts/common/install/` and is not yet published from `agents-comm-bus`. Phase 4 must either:

1. **Vendor a thin copy** in this package that calls `applyDevConfig` + `ensureDaemon` from `agents-comm-bus/bootstrap/ensure-daemon`, or
2. **Publish `entryEnsures`** as a new `agents-comm-bus` export (cleaner long-term).

## Status

- **Phase 3 (this tree):** package skeleton — extension modules are stubs with documented signatures.
- **Phase 4:** implement daemon client, inbound polling, session lifecycle, and comm tools.
- **Phase 6:** fill in per-comm `skills/*/SKILL.md` content.

## Design docs

- [`docs/research/pi/README.md`](../../../docs/research/pi/README.md) — full Pi host design
- [`docs/research/pi/CHECKLIST.md`](../../../docs/research/pi/CHECKLIST.md) — implementation checklist
