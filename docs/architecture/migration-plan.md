# Migration Plan

This document enumerates the compatibility surface that must be readable during
the v4 transition from per-process Telegram ownership to the shared
`agents-comm-bus` daemon.

The goal of migration is not to preserve old runtime ownership. Legacy files
and install paths are inputs only. The target runtime state lives under
`~/.agents-comm-bus/`, with structured records in SQLite and append-only audit
events.

## Target State

- State root: `~/.agents-comm-bus/`
- Database: `~/.agents-comm-bus/agents-comm-bus.db`
- Audit log: `~/.agents-comm-bus/audit/*.jsonl`
- Transcripts: `~/.agents-comm-bus/chats/<conversation-id>/transcript.jsonl`
- Attachments: `~/.agents-comm-bus/chats/<conversation-id>/attachments/`
- Daemon discovery: `~/.agents-comm-bus/port`
- Daemon ownership: one active owner per `(comm, account)`

Credentials must not be copied into ordinary JSON state. Migration may discover
legacy credential locations, but moving or registering credentials requires
explicit user confirmation and should store only an opaque `credentials_ref` in
account registration records.

## Compatibility Surface

| Surface | Current meaning | Migration handling |
| --- | --- | --- |
| `<project>/.claude/telegram.json` | Claude project-local Telegram credentials. Current Claude server and hooks prefer this path. | Discover as a Claude account-registration candidate. Require explicit confirmation before registering. Do not auto-copy token material into daemon state. |
| `<project>/.codex/telegram.json` | Codex project-local Telegram credentials. Present locally as a gitignored config path; Codex branch also uses it as first-class credential input. | Discover as a Codex account-registration candidate. Require explicit confirmation before registering. Prefer this over Claude credentials for Codex when both exist. |
| `~/.claude/telegram.json` | Possible user-global Claude credential fallback in Codex branch compatibility code. | Discover as a fallback candidate only. Treat as lower priority than project-local config. |
| `~/.codex/telegram.json` | Possible user-global Codex credential fallback in Codex branch compatibility code. | Discover as a fallback candidate only. Treat as lower priority than project-local config. |
| `~/.claude-telegram/*` | Legacy Claude session state root. Contains per-project/session folders named `<basename>-<hash>`. | Read during transition only. Import conversations, pending query state, and recent chat hints where possible. Never let the daemon continue writing this layout except for documented transition fallback. |
| `~/.codex-telegram/*` | Legacy Codex session state root on `origin/codex`. Contains per-project/session folders named `<basename>-<hash>` plus Codex startup diagnostics. | Read during transition only. Import compatible state using the same model as Claude, with agent set to `codex`. |
| `last-chat.json` | Heuristic for "reply to the last inbound chat". Stores `chat_id`, optional `message_thread_id`, `from_user_id`, and `updated_at`. | Convert to conversation inventory and last-inbound metadata if the related account can be identified. Do not use as primary routing state after import. |
| `pending-permission.json` | Legacy pending approval request. Claude writes it for watcher/permission response; Codex branch writes it while blocking a PermissionRequest hook. | Import as a pending `Query` only when it is fresh enough and structurally valid. Expired or malformed files should be audited and ignored. |
| `permission-response.json` | Legacy response bridge for permission hooks/watchers. | Do not import as durable state. At most use during transition fallback for an already-running legacy request. |
| `queue.json` | Per-session inbound message queue. Claude and Codex hooks drain this file into agent context. | Import unread messages as inbound events only when the session and account can be resolved. Prefer read-only first-run ingestion; do not keep queue files as active routing state. |
| `session-info.json` | Claude watcher diagnostics and target-window metadata. | Do not migrate into daemon state. Useful only for troubleshooting legacy sessions. |
| `watcher.pid` | Claude enter-watcher process marker. | Do not migrate. The daemon lifecycle replaces this ownership model. |
| `debug.log` / `startup.log` | Legacy diagnostic files under Claude/Codex session roots. | Do not migrate. Leave in place; docs may point users to them for troubleshooting transition failures. |
| `.claude-plugin/plugin.json` | Claude plugin manifest. Currently points `telegram` MCP server to `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.js`. | Update during Phase 1 distribution work so the MCP surface becomes a thin daemon IPC shim. The old path remains a transition install input. |
| `.codex-plugin/plugin.json` | Codex plugin manifest on `origin/codex`. Describes Codex Telegram capability and app-server flow. | Preserve as Codex install metadata, but route runtime behavior through the shared daemon once Codex adapter work lands. |
| `install.js`, `install.sh`, `INSTALL.bat` | Claude-oriented install and queue setup. | Update after daemon bootstrap exists. Must stop treating `~/.claude-telegram/` as the canonical state root. |
| `install-codex.js` | Codex installer on `origin/codex`; writes `[mcp_servers.telegram]` to `~/.codex/config.toml` with `--agent=codex`. | Treat as migration/install input. The `--agent=codex` split should not survive as a runtime architecture dependency. |
| `hooks/permission-telegram.cjs` | Claude PermissionRequest hook that sends Telegram prompts directly and writes `pending-permission.json`. | Convert to daemon client in Phase 2. Any direct Telegram send path retained before then must be labeled transition-only. |
| `hooks/telegram-context.js` | Claude hook that drains `queue.json` and starts watcher behavior. | Convert to daemon-backed inbound delivery. Legacy queue drain may exist only as transition fallback. |
| `hooks/session-start.js` and `scripts/enter-watcher.ps1` | Claude watcher bootstrap and keystroke injection support. | Leave as Claude-specific transition compatibility until the daemon/adapter path can wake sessions. Do not apply to Codex. |
| `hooks/codex/user-prompt-submit.js` | Codex branch hook that drains `~/.codex-telegram/.../queue.json`. | Convert to daemon-backed inbound delivery in Phase 3. |
| `hooks/codex/permission-request.js` | Codex branch blocking PermissionRequest hook using `pending-permission.json` and `permission-response.json`. | Convert to daemon-backed `Query` flow in Phase 3. |
| `mcp-server/server.js` | Current MCP server owns Telegram polling, file queues, last-chat routing, and pending permission responses. Codex branch adds `--agent=codex`. | Becomes a thin IPC shim. During transition it is the main source for legacy path and payload formats. |
| `mcp-server/codex-app-server.js` | Codex branch JSON-RPC client for waking Codex via app-server. | Convert into Codex adapter capability dispatch. Do not tie general daemon routing to this file. |
| `mcp-server/dist/server.js` | Generated bundle used by plugin manifests and local MCP configs. | Migration/install code must account for users running the bundled file. Source changes must be accompanied by rebuild/repackaging in distribution tasks. |
| `.mcp.json` / `.mcp.json.template` | Local development MCP config with env credential support. | Treat as install/config input only. Do not require it for daemon state after account registration exists. |

## Import Rules

1. Discovery must be side-effect free. Listing migration candidates cannot start
   Telegram polling, mutate legacy files, or register accounts.
2. Credential migration requires an explicit user action. The daemon may show
   where credentials were found and which account label would be created, but it
   must not silently persist token material.
3. State ingestion can be automatic and read-only on first run. `last-chat.json`,
   `queue.json`, and fresh `pending-permission.json` may be imported when they
   can be tied to a resolved project, agent, comm, and account.
4. Malformed, expired, or ambiguous legacy files should be skipped with audit
   events. Migration must continue for other candidates.
5. Import should be idempotent. Re-running migration should not duplicate account
   registrations, conversations, messages, or queries.
6. Legacy layouts remain readable during the transition release only. New writes
   should target daemon state unless a fallback is explicitly documented and
   test-covered.

## Audit Events

The daemon-guided migration command should append audit entries for:

- migration scan started/completed
- credential candidate found
- credential registration accepted or skipped
- legacy state file imported
- legacy state file skipped with reason
- ambiguous account or project mapping
- transition fallback used

Audit details must avoid storing raw bot tokens or user secrets.

## Fallback Boundaries

Any retained standalone fallback must be documented as temporary and assigned a
cleanup release. Valid transition-only fallbacks include:

- reading old `last-chat.json` when no daemon conversation record exists yet
- draining old `queue.json` for an already-started legacy session
- completing an already-open `pending-permission.json` request that predated
  daemon startup

Invalid fallbacks:

- starting a second Telegram polling owner outside the daemon
- continuing to use `last-chat.json` as the normal routing source
- silently copying credentials into daemon JSON or SQLite records
- keeping `--agent=codex` as the long-term ownership split

## Open Implementation Dependencies

M1 can be completed before Phase 1, but the executable migration command depends
on daemon work:

- `core-daemon/paths.ts` for canonical daemon paths
- `core-daemon/storage/sqlite.ts` and schema migrations
- `core-daemon/storage/audit.ts`
- account registration CLI/storage behavior
- transition readers for `last-chat.json`, `queue.json`, and
  `pending-permission.json`
- adapter-side conversion for Claude and Codex hooks

Until those exist, migration work should stay at the inventory, format, and
contract level.
