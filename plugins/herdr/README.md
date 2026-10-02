# agents-comm-bus herdr plugin

Thin dispatcher that keeps agents-comm-bus daemon sessions aligned with herdr panes running Claude Code or Codex.

## Install

**Development (linked checkout):**

```powershell
herdr plugin link D:\path\to\acb-age110\plugins\herdr
```

Projects under that checkout with `.agents-comm-bus-dev.json` route sync through the checkout CLI (`agents-comm-bus/dist/core-daemon/cli/index.js`). Other projects use the central install at `~/.agents-comm-bus/bin/cli.js`.

**Production:**

```powershell
herdr plugin install <owner>/<repo>/plugins/herdr
```

Use named herdr sessions for dev vs prod, e.g. `herdr --session dev` for a dev socket and a separate session for production bots.

## Wake mode

Prefer herdr wake (agent prompt) vs native (watcher / Codex app-server) per agent:

```powershell
agents-comm wake-mode set --agent claude native
agents-comm wake-mode set --agent codex auto
agents-comm wake-mode get --agent claude
```

Set `"wakeStrict": "herdr"` in `.agents-comm-bus-dev.json` to fail closed on herdr delivery errors (no native fallback).

## Behavior

- **startup** — `herdr agent list`, sync each claude/codex/pi pane via `herdr-pane-sync`.
- **pane.agent_detected** — parse event JSON (or `agent get`), sync when agent is claude, codex, or pi.
- **pane.closed** — idempotent `herdr-pane-release` for claude, codex, and pi identities.

Logs append JSON lines to `HERDR_PLUGIN_STATE_DIR/plugin.log` (best-effort). The plugin never spawns the daemon directly; the CLI ensures it.
