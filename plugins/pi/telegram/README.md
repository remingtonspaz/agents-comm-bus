# @agents-comm-bus/pi-telegram

Pi host extension for [agents-comm-bus](https://github.com/earendil-works/agents-comm-bus): Telegram comm tools (`comm_send_message`, `comm_check_messages`, …) and inbound message delivery for Pi coding-agent sessions. Bundles the shared `@agents-comm-bus/pi-core` extension (comm-generic tools + lifecycle).

## Install

**Local dev (monorepo checkout):**

```bash
pi -e ./plugins/pi/telegram
```

Or add a local path in `.pi/settings.json` pointing at this directory. The core resolves via the monorepo workspace link.

**Released package (Option B):** after CI syncs this tree to the dedicated Pi package repo:

```bash
pi install git:github.com/<you>/agents-comm-bus-pi-telegram@v1
# or
pi install npm:@agents-comm-bus/pi-telegram
```

## Prerequisites

Register a Telegram account for the `pi` agent on your project:

```bash
agents-comm account-add \
  --project "<absolute project path>" \
  --agent pi \
  --account-label main \
  --comm telegram \
  --bot-token "<token>"
```

## Dev mode

When developing against a monorepo checkout, place `.agents-comm-bus-dev.json` at the repo root. The extension's daemon client imports `entryEnsures` from `agents-comm-bus/host-entry` with `fromDir: import.meta.dirname`, so dev vs prod discovery resolves automatically:

- **Dev:** daemon from `agents-comm-bus/dist/core-daemon/serve.js`, state root `.agents-comm-bus-dev/`, discovery `.agents-comm-bus-discovery/`
- **Prod:** central install at `~/.agents-comm-bus/` (no dev marker)

Comm-resource leases stay homedir/global in both modes.

## Status

- **Phase 4:** daemon client, inbound polling, and session lifecycle implemented in the bundled core.
- **Phase 5:** four comm tools implemented in the bundled core.
- **Phase 6:** fill in `skills/telegram/SKILL.md` content.

## Design docs

- [`docs/research/pi/README.md`](../../../docs/research/pi/README.md) — full Pi host design
- [`docs/research/pi/CHECKLIST.md`](../../../docs/research/pi/CHECKLIST.md) — implementation checklist
