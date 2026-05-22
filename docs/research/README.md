> Indexed 2026-05-18.

# Comm-platform research

Background research on the chat platforms the daemon will grow `CommAdapter`s
for after the v4 Telegram baseline lands. Each doc is a per-platform API
reference scoped to the decisions a `CommAdapter` author has to make:
authentication, connection model, identity probe, event/message shape,
threading, attachments, bot-to-bot semantics, rate limits, and the
platform→core type mapping.

## Files

- [`matrix-api.md`](./matrix-api.md) — Client-Server API reference for a
  Matrix `CommAdapter`. Covers `/sync` long-polling, `m.room.message`,
  `m.replace` edits, redactions, the `mxc://` content repository, the
  `m.thread` relation, E2EE scope decision (deferred past V1), and the
  `matrix-bot-sdk` vs `matrix-js-sdk` choice.
- [`matrix-setup-guide.md`](./matrix-setup-guide.md) — Numbered walkthrough
  for a non-expert: pick a homeserver, register a bot account, mint an
  access token, choose an unencrypted room, fill in the registration JSON,
  verify with `whoami` and a test send.
- [`discord-api.md`](./discord-api.md) — Gateway + REST reference for a
  Discord `CommAdapter`. Gateway lifecycle (HELLO/IDENTIFY/READY/HEARTBEAT/
  RESUME), intents (including the `MESSAGE_CONTENT` privileged intent
  trap), `MESSAGE_CREATE` shape, threads-as-channels, the new signed-CDN
  attachment expiry behavior, and the `@discordjs/core` modular library
  choice over full `discord.js`.
- [`slack-api.md`](./slack-api.md) — Web API + Socket Mode reference for a
  Slack `CommAdapter`. Token zoo (`xoxb-`/`xoxp-`/`xapp-`), Socket Mode
  envelope + 3-second ack, the `message` event subtype catalog
  (including `bot_message` and the nested `message_changed` envelope),
  the `files.getUploadURLExternal` 3-step upload flow after
  `files.upload` retirement, and the `@slack/web-api` + `@slack/socket-mode`
  library choice over Bolt.
- [`install-model.md`](./install-model.md) — Proposal (2026-05-18,
  expanded 2026-05-19) for the plugin install / distribution shape:
  peer-class `agents-comm-bus-<comm>` plugins instead of a privileged
  core, **CommAdapter vs AgentAdapter** terminology pinned, shared
  `~/.agents-comm-bus/bin/` + `/adapters/` populated by each plugin's
  install hook with **reference-counted `installed_by` metadata** to
  handle multi-agent installs, **three-repo distribution** (source
  monorepo containing source + built artifacts + two thin per-agent
  marketplace repos pointing into it via git-subdir — Option A), build
  matrix with PR-noise mitigations, install lifecycle, daemon version
  reconciliation, multi-agent coexistence, **duplicate-invocation
  safety** (bootstrap lockfile, session-key dedupe on WS handshake,
  idempotent message delivery, stateless MCP shim design),
  **dev-mode env-var overrides** (`AGENTS_COMM_BUS_ROOT` /
  `AGENTS_COMM_BUS_BIN` / `AGENTS_COMM_BUS_ADAPTERS_DIR` for running
  daemon + adapters from project source with isolated state), and the
  migration path for `claude-code-telegram` users.
- [`dist-tree-plan.md`](./dist-tree-plan.md) — canonical directory
  sketch of the source monorepo (`agents-comm-bus/`) with built
  artifact dirs `plugins/claude/<comm>/` and `plugins/codex/<comm>/`
  plus the two thin
  marketplace repos. The visual reference that `install-model.md`'s
  "Repo layout and distribution" section narrates.

## Cross-platform findings that touch [the invariants](../architecture/invariants.md)

### Single-ownership of `(comm, bot_user_id)` — enforcement varies

The `account_registrations UNIQUE(comm, bot_user_id)` invariant assumes one
daemon process owns one bot identity at a time. Every platform agrees the
*daemon side* must enforce this, but the *platform side* varies:

| Platform | Platform-side enforcement |
|---|---|
| Telegram | `getUpdates` returns `409 Conflict` if a second poller starts. |
| Discord | A second `IDENTIFY` for the same bot token returns close code **4005 "Already Authenticated"** on the offending socket. |
| Slack (Socket Mode) | `apps.connections.open` returns a fresh WS URL per call; multiple sockets coexist and each receives independent event copies. No platform-side conflict. |
| Slack (Events API) | Webhook deliveries fan out to whatever URL is configured — single owner is the registered URL, not the daemon. |
| Matrix | None. Multiple `/sync` clients on the same access token are explicitly supported (multi-device is a first-class concept). |

**Consequence:** on Matrix and Slack Socket Mode, the daemon cannot rely on
the platform to reject a second owner. The `UNIQUE` constraint in the
registrations table is the only stop, plus single-writer discipline in the
daemon process. The bootstrap sequence must check for a still-live daemon
before starting a second one.

### Bot-to-bot delivery — load-bearing for multi-agent fanout

The fanout / hop-counting / recently-seen-dedupe / foreign-bot-policy
invariants in [`invariants.md`](../architecture/invariants.md) exist
because every comm we ship for now *can* deliver bot-authored messages
to other bots — including Telegram, as of 2026-05-19. The differences
are in how delivery is enabled and what envelope marker identifies the
sender as a bot:

| Platform | Bot-to-bot delivery | Mechanism |
|---|---|---|
| Telegram | **Yes — opt-in, both sender and receiver must enable** ([as of 2026-05-19](https://core.telegram.org/bots/features#bot-to-bot-communication)). | "Bot-to-Bot Communication Mode" toggle in BotFather, required on both bots. DMs via `sendMessage` with `@username` as target; group via `/command@OtherBot` mentions or replies to the other bot's messages. **Telegram enforces NO loop prevention**; their docs explicitly delegate dedupe / rate-limiting / depth-limiting to the developer. Up to 3 guest bots per message. `is_bot` field behavior on inbound envelopes [TBD — needs empirical test]. |
| Matrix | **Yes.** No protocol-level bot/user distinction. | Bot accounts are regular users with access tokens. |
| Discord | **Yes** at the Gateway. SDK-level filters give the illusion of a block. | `MESSAGE_CREATE` includes `author.bot: true`; `discord.js` tutorials default to filtering on it. |
| Slack | **Yes.** | `message` event with `subtype: "bot_message"`, carrying `bot_id` and `bot_profile`. |

**Consequence:** for **every** comm adapter (no longer "every non-Telegram
adapter"), the daemon's hop counter and recently-seen dedupe are not
optional — they're the only thing standing between a multi-agent room
and an infinite reply loop. Adapter implementers must NOT filter
bot-authored events at the inbound boundary. The Telegram-specific
nuance is that bot-to-bot only flows between bots that have both
opted in via BotFather; a Telegram bot from a user that hasn't opted
in simply won't receive the inbound, regardless of how the adapter is
written.

**Implication for issue #5** (side-channel transcript for bot-to-bot
on Telegram): the original motivation dissolves with this change. The
issue can be closed or reduced in scope once both bots involved enable
the BotFather setting.

### Identity probe — `getMe` analogs

| Platform | Method | Notes |
|---|---|---|
| Telegram | `getMe` | Returns `id`, `username`. |
| Matrix | `GET /_matrix/client/v3/account/whoami` | Returns `user_id`, `device_id`, `is_guest`. |
| Discord | `GET /users/@me` with `Authorization: Bot <token>`, or read the `READY` Gateway event. | Returns `id`, `username`, `global_name`. |
| Slack | `POST https://slack.com/api/auth.test` | Returns `user_id` (the bot user) **and** a separate `bot_id` (the internal Slack bot id). `account_registrations.bot_user_id` should be `user_id`, not `bot_id`. |

### Connection model — choosing the inbound transport

| Platform | Transport | Notes |
|---|---|---|
| Telegram | Long-poll (`getUpdates`) or webhook. | Daemon uses long-poll. |
| Matrix | Long-poll (`/sync` with `since` token). | One persistent request at a time per device. |
| Discord | WebSocket (Gateway). | Heartbeat-driven; supports `RESUME` for reconnects within the session-invalidation window. |
| Slack | WebSocket (Socket Mode) OR webhook (Events API). | Daemon should use Socket Mode — webhook requires a public HTTPS endpoint. |

Three of four are WebSocket-or-long-poll friendly without inbound HTTPS;
Slack Events API is the only one that demands a public endpoint, which is
why Socket Mode is the recommended path.

### Threading model — three different shapes

| Platform | Thread representation | Reply target shape |
|---|---|---|
| Telegram | `message_thread_id` on forum-topic messages; otherwise `reply_to_message`. | Two distinct concepts. |
| Matrix | `m.thread` relation with `rel_type: "m.thread"`. | Same room, threaded by event id. |
| Discord | Threads ARE channels (`parent_id` points at the source channel). | Reply by POST to the thread's channel id. |
| Slack | `thread_ts` linkage to parent message in the same channel. | Lightweight — no separate object. |

`ChatRef` in core types needs an optional `thread` field that compresses
all four: `(channel_id, thread_id | null)`. The Discord case is the
awkward one — its "thread" is just another `channel_id`, so the daemon
either nests `thread` inside `channel` or normalizes Discord threads to
the same `(channel_id, thread_id)` shape with `channel_id` pointing at
the parent.

### Attachment durability — diverges by platform

| Platform | Inbound attachment URL | Durability |
|---|---|---|
| Telegram | `getFile` returns a path on the bot file server. | Stable for the bot's lifetime. |
| Matrix | `mxc://server/mediaid` resolved to authenticated download. | Stable. |
| Discord | CDN URL with `?ex=&is=&hm=` signed query string. | **Expires.** Adapter must download eagerly on inbound. |
| Slack | `files.*` API returns a permalink + private URL. | Stable, but requires bot token to fetch. |

The invariant "attachments are content-addressed by sha256" lines up with
Discord's expiry behavior — eager download isn't just nice-to-have for
Discord, it's required.

## How this folder relates to the rest of `docs/`

- [`architecture/invariants.md`](../architecture/invariants.md) — the
  testable contracts a `CommAdapter` must honor. The cross-platform
  findings above are the empirical basis for several of those invariants.
- [`architecture/storage-layout.md`](../architecture/storage-layout.md) —
  the on-disk shape of `account_registrations`, `conversations`,
  `queries`, `sessions`. The platform→core type mapping tables at the end
  of each research doc inform how each platform's identifiers flatten
  into those rows.
- [`architecture/sequence-telegram-to-claude.md`](../architecture/sequence-telegram-to-claude.md)
  and siblings — the per-comm flow the future adapters will mirror.
