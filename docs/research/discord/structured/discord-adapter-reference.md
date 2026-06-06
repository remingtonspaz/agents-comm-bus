# Discord Platform Reference for Adapter Design

> Research summary for agents-comm-bus Discord adapter design.  
> Sources: Discord official docs (discord-api-docs main branch, via raw.githubusercontent.com), accessed 2026-06-06.  
> Raw notes cached in `../raw-notes/`.

---

## 1. Authentication & Bot Application Setup

### Creating an App
- Apps are created in the Discord Developer Portal (`discord.com/developers/applications`).
- Each app has a **client ID** and **client secret** used for OAuth2.
- A **bot user** is added from the Bot tab; this generates the **bot token** used for API authentication.
- The bot token is the primary credential for both REST and Gateway connections.

### Bot Token Security
- **NEVER** expose bot tokens in client-side code or public repositories.
- If a token is leaked, it should be regenerated immediately in the Developer Portal.
- Tokens grant full bot permissions within scoped servers/DMs.

### OAuth2 & Scopes
- Discord supports authorization code grant, implicit grant, client credentials, and special bot/webhook flows.
- Key scopes for bots:
  - `bot` — adds the bot to a guild
  - `applications.commands` — registers slash commands (included by default with `bot` scope)
  - `webhook.incoming` — generates an incoming webhook
- The `integration_type` parameter (0 = GUILD_INSTALL, 1 = USER_INSTALL) determines installation context when scope contains `applications.commands`.
- Token and revocation endpoints **only** accept `application/x-www-form-urlencoded`; JSON is rejected.
- Use the `state` parameter to mitigate CSRF attacks.

### User-Installable Apps (New Model)
- Apps can be installed directly to a user account (not just servers).
- This enables usage in DMs with the bot user (`BOT_DM` context) and in group DMs (`PRIVATE_CHANNEL` context).
- Installation contexts and interaction contexts are configured per command.
- This is an increasingly important deployment model alongside traditional guild bots.

---

## 2. Gateway vs REST Responsibilities

### Gateway (WebSocket)
- **Real-time event delivery** — messages, reactions, member joins, channel updates, etc.
- Required for most bots that need to listen to events.
- WebSocket URL: `wss://gateway.discord.gg/?v=10&encoding=json`
- Must keep a persistent connection with heartbeats.
- Some actions (e.g., voice state updates) must go through Gateway.

### REST API
- All **CRUD operations** on Discord resources (channels, messages, roles, etc.).
- Used for sending messages, creating channels, managing roles, fetching data.
- Base URL: `https://discord.com/api/v10`
- Most bot operations use the REST API; Gateway is primarily for receiving events.

### Interactions Endpoint (HTTP)
- For **slash commands, buttons, select menus, modals** — Discord sends an HTTP POST to your registered interactions endpoint.
- Does **not** require a persistent Gateway connection.
- Must respond within **3 seconds** or Discord considers the interaction failed.
- For operations that take longer, send a deferred response (type 5) first.

### Adapter Implications
- A full-featured Discord adapter likely needs **both Gateway and REST**.
- Gateway-only is viable for pure event consumers.
- REST-only (with interactions endpoint) works for command-response bots but cannot receive spontaneous events (e.g., regular messages, reactions).

---

## 3. Event & Message Handling Patterns

### Gateway Events
- Events are encapsulated in a payload: `{op, d, s, t}`.
- `op` = opcode (0 = Dispatch, 1 = Heartbeat, 2 = Identify, etc.)
- `t` = event name for Dispatch events
- `s` = sequence number (must cache latest for resume)

### Key Event Types
- `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`
- `GUILD_MEMBER_ADD`, `GUILD_MEMBER_REMOVE`, `GUILD_MEMBER_UPDATE`
- `INTERACTION_CREATE` (received via Gateway, not just HTTP)
- `THREAD_CREATE`, `THREAD_UPDATE`, `THREAD_DELETE`
- `CHANNEL_CREATE`, `CHANNEL_UPDATE`, `CHANNEL_DELETE`
- `GUILD_CREATE`, `GUILD_DELETE`
- `READY` — sent after successful Identify, contains `resume_gateway_url`
- `RESUMED` — sent after successful Resume

### Message Structure
- Messages contain `id`, `channel_id`, `author`, `content`, `timestamp`, `embeds`, `components`, `attachments`, `mentions`, `referenced_message`, etc.
- **Messages in threads share the same message object** but have a `thread` parent channel.

### Thread Model
- Threads are channels with types: `ANNOUNCEMENT_THREAD` (10), `PUBLIC_THREAD` (11), `PRIVATE_THREAD` (12).
- Threads have `thread_metadata` (archive timestamp, auto-archive duration, locked, etc.).
- Users must be "members" of a thread to receive updates; sending a message auto-adds the user.
- Thread list sync events are sent when gaining access to a channel.
- Guilds have limits on active threads and members per thread.
- **Threads do not count against the per-guild channel limit** (500 channels).

---

## 4. Slash Commands & Interactions

### Command Types
- **Chat Input** (slash commands)
- **User** context menu commands
- **Message** context menu commands

### Interaction Response
- Must respond within **3 seconds**.
- Response types:
  - `1` = Pong (for ping)
  - `4` = Channel message with source
  - `5` = Deferred channel message with source (ack + "thinking...")
  - `6` = Deferred update message (for components)
  - `7` = Update message (for components)
- After a deferred response, you have **up to 15 minutes** to edit the original response.

### Interaction Contexts
- `GUILD` (0) — server channel
- `BOT_DM` (1) — DM with the bot user
- `PRIVATE_CHANNEL` (2) — DM or group DM with other users
- Commands can be restricted to specific contexts.

### Installation Types
- `GUILD_INSTALL` (0) — installed to a server
- `USER_INSTALL` (1) — installed to a user account

### Webhook Follow-ups
- After the initial response, use the webhook URL to send follow-up messages.
- The `application_id` and interaction token form the webhook credentials.

---

## 5. Channels, Threads & DM Considerations

### Channel Types
| Type | ID | Description |
|------|-----|-------------|
| GUILD_TEXT | 0 | Text channel in a server |
| DM | 1 | Direct message |
| GUILD_VOICE | 2 | Voice channel |
| GROUP_DM | 3 | Group DM |
| GUILD_CATEGORY | 4 | Category channel |
| GUILD_ANNOUNCEMENT | 5 | Announcement channel |
| ANNOUNCEMENT_THREAD | 10 | Thread in announcement channel |
| PUBLIC_THREAD | 11 | Public thread |
| PRIVATE_THREAD | 12 | Private thread |
| GUILD_FORUM | 15 | Forum channel (thread-only) |
| GUILD_MEDIA | 16 | Media channel (thread-only) |

### DM & Group DM Behavior
- DMs (`DM` type) are between two users.
- Group DMs (`GROUP_DM` type) are multi-user direct messages.
- Bots cannot initiate DMs with users who have not previously interacted with them.
- User-installable apps enable `BOT_DM` context for direct bot-user interaction.
- Group DMs can be managed via OAuth2 `gdm.join` scope.

### Thread Behavior
- Threads can be archived; archived threads are mostly immutable.
- Sending a message in an archived thread auto-unarchives it.
- Threads inside private channels are completely private to channel members.
- Threads track membership separately from channel permissions.

---

## 6. Intents & Privileged Intents

### Gateway Intents
Intents are a bitwise value OR'd together and sent in the Identify payload. They control which events the bot receives.

| Intent | Bit | Description |
|--------|-----|-------------|
| GUILDS | 1 << 0 | Guild create/update/delete, channel updates |
| GUILD_MEMBERS | 1 << 1 | **Privileged** — member join/leave/update |
| GUILD_BANS | 1 << 2 | Ban add/remove |
| GUILD_EMOJIS | 1 << 3 | Emoji updates |
| GUILD_INTEGRATIONS | 1 << 4 | Integration updates |
| GUILD_WEBHOOKS | 1 << 5 | Webhook updates |
| GUILD_INVITES | 1 << 6 | Invite create/delete |
| GUILD_VOICE_STATES | 1 << 7 | Voice state updates |
| GUILD_PRESENCES | 1 << 8 | **Privileged** — presence updates |
| GUILD_MESSAGES | 1 << 9 | Messages in guild channels |
| GUILD_MESSAGE_REACTIONS | 1 << 10 | Reactions in guild channels |
| GUILD_MESSAGE_TYPING | 1 << 11 | Typing indicators in guild channels |
| DIRECT_MESSAGES | 1 << 12 | Messages in DMs |
| DIRECT_MESSAGE_REACTIONS | 1 << 13 | Reactions in DMs |
| DIRECT_MESSAGE_TYPING | 1 << 14 | Typing indicators in DMs |
| MESSAGE_CONTENT | 1 << 15 | **Privileged** — access to message content |
| GUILD_SCHEDULED_EVENTS | 1 << 16 | Scheduled event updates |
| AUTO_MODERATION_CONFIGURATION | 1 << 20 | Auto-mod rule updates |
| AUTO_MODERATION_EXECUTION | 1 << 21 | Auto-mod action execution |

### Privileged Intents
Three intents require **explicit enabling** in the Developer Portal and **approval** for verified apps (100+ guilds):

1. **GUILD_MEMBERS** — Required to receive member join/leave events and request full member lists.
2. **GUILD_PRESENCES** — Required to receive presence updates and request presence data.
3. **MESSAGE_CONTENT** — Required to receive message `content`, `embeds`, `attachments`, `components` fields, and `poll` data.

### Critical Implications for Adapter Design
- **Without MESSAGE_CONTENT**, the bot sees empty message content for all events. This is a major constraint for message-forwarding adapters.
- Privileged intents must be enabled AND approved (for verified apps) before they can be used.
- On API v8+, intents are **mandatory** in the Identify payload.
- For API v6, GUILD_PRESENCES and GUILD_MEMBERS events are off by default regardless of version.

---

## 7. Permissions Model

### Permission System
- Discord uses a **64-bit integer bitfield** for permissions.
- Permissions can be set at:
  - **Guild level** (default permissions for @everyone)
  - **Channel level** (overrides per role or user)
  - **Command level** (slash command permissions)

### Key Permissions for Bots
| Permission | Bit | Relevance |
|------------|-----|-----------|
| VIEW_CHANNEL | 1 << 10 | Read channels |
| SEND_MESSAGES | 1 << 11 | Send messages |
| MANAGE_MESSAGES | 1 << 13 | Delete/edit messages |
| EMBED_LINKS | 1 << 14 | Embed links |
| ATTACH_FILES | 1 << 15 | Upload files |
| READ_MESSAGE_HISTORY | 1 << 16 | Access history |
| MENTION_EVERYONE | 1 << 17 | @everyone/@here |
| USE_APPLICATION_COMMANDS | 1 << 31 | Use slash commands |
| MANAGE_THREADS | 1 << 34 | Manage threads |
| CREATE_PUBLIC_THREADS | 1 << 35 | Create public threads |
| SEND_MESSAGES_IN_THREADS | 1 << 38 | Send in threads |

### Permission Resolution
- Channel permission overwrites take precedence over guild-level permissions.
- Administrator (1 << 3) bypasses all channel overwrites.
- Command permissions can restrict which roles/users can use specific commands.
- The `app_permissions` field in interactions tells you what permissions the app has in the interaction context.

---

## 8. Rate Limits

### HTTP API Rate Limits
- **Per-route limits**: Different endpoints have different limits, often keyed by top-level resource (`guild_id`, `channel_id`, `webhook_id`).
- **Global rate limit**: Applies to total requests from a bot, independent of per-route limits.
- Rate limit headers:
  - `X-RateLimit-Limit` — total allowed
  - `X-RateLimit-Remaining` — remaining
  - `X-RateLimit-Reset` — epoch time of reset
  - `X-RateLimit-Reset-After` — seconds until reset
  - `X-RateLimit-Bucket` — rate limit bucket identifier
  - `X-RateLimit-Global` — present on 429 if global limit hit
  - `X-RateLimit-Scope` — `user`, `global`, or `shared`
- On 429, check `Retry-After` header or `retry_after` field.
- **Do not hardcode rate limits** — parse headers dynamically.

### Gateway Rate Limits
- **120 events per connection per 60 seconds** (avg 2/sec).
- Exceeding this causes immediate disconnect.
- Repeat offenders may have API access revoked.

### Identify Limit
- **1000 IDENTIFY calls per 24 hours, globally across all shards**.
- Does NOT include RESUME calls.
- Hitting this limit: all sessions terminated, token reset, owner emailed.
- This is a **critical** operational constraint for large-scale bots.

### Emoji Rate Limits
- Emoji routes are limited on a **per-guild basis** to prevent abuse.
- Quota may be inaccurate; be prepared for 429s.

---

## 9. Message Content Restrictions

### Without MESSAGE_CONTENT Intent
- `content` field is **empty string** for messages received via Gateway.
- `embeds`, `attachments`, `components` are **empty arrays**.
- `poll` field is **omitted entirely**.
- The bot still receives the message object with metadata (id, author, timestamp, etc.).

### With MESSAGE_CONTENT Intent
- Full access to message content, embeds, attachments, components, and polls.
- Must be enabled in Developer Portal and approved for verified apps.

### Adapter Design Impact
- If the adapter needs to forward message text, **MESSAGE_CONTENT intent is mandatory**.
- For an agent-communication bus, this is almost certainly required.
- Consider that this intent requires approval for any bot in 100+ guilds.

---

## 10. Sharding & Scaling Considerations

### When Sharding is Required
- **Mandatory** when bot is in **2500+ guilds**.
- Each shard handles a subset of guilds.
- Maximum **2500 guilds per shard**.

### Sharding Formula
```
shard_id = (guild_id >> 22) % num_shards
```
- Events without a `guild_id` (DMs, subscriptions) go only to **shard 0**.

### Session Start Limits
- `Get Gateway Bot` endpoint returns:
  - `shards` — recommended shard count
  - `session_start_limit` — max concurrency, remaining, reset_after, total
- `max_concurrency` determines how many shards can be started concurrently.
- Rate limit key per shard: `shard_id % max_concurrency`
- Must start shards by bucket **in order**.

### Scaling Strategy
- Multiple sessions with the same `[shard_id, num_shards]` are allowed for load balancing.
- Allows "zero-downtime" scaling by starting new sessions before retiring old ones.
- No state sharing required between shards.

---

## 11. Reconnect & Session Behavior

### Connection Lifecycle
1. Fetch Gateway URL via `Get Gateway` or `Get Gateway Bot`
2. Connect WebSocket
3. Receive Hello (opcode 10) with heartbeat_interval
4. Start heartbeat loop (first after random jitter)
5. Send Identify (opcode 2)
6. Receive Ready (opcode 0) — connection established

### Heartbeat Behavior
- Wait `heartbeat_interval * jitter` (jitter is 0-1 random) before first heartbeat
- Then send heartbeat every `heartbeat_interval` ms
- Include last sequence number (`s` field) in heartbeat `d`
- Discord responds with Heartbeat ACK (opcode 11)
- If no ACK received between heartbeats, close connection and resume

### Resume vs Re-identify
- **Resume** (opcode 6): Reconnect using `resume_gateway_url`, session_id, and last seq. Replays missed events.
- **Re-identify**: Start fresh connection with Identify payload.

### Close Codes
| Code | Description | Reconnect? |
|------|-------------|------------|
| 4000 | Unknown error | Yes |
| 4001 | Unknown opcode | Yes |
| 4002 | Decode error | Yes |
| 4003 | Not authenticated | Yes |
| 4004 | Authentication failed | **No** (token invalid) |
| 4005 | Already authenticated | Yes |
| 4007 | Invalid seq | Yes (new session) |
| 4008 | Rate limited | Yes |
| 4009 | Session timed out | Yes (new session) |
| 4010 | Invalid shard | **No** |
| 4011 | Sharding required | **No** (must shard) |
| 4012 | Invalid API version | **No** |
| 4013 | Invalid intent(s) | **No** |
| 4014 | Disallowed intent(s) | **No** |

### Server-Initiated Reconnect
- Discord may send Reconnect event (opcode 7): client should reconnect and resume immediately.
- Or send Invalid Session (opcode 9): if `d` is `true`, can resume; if `false`, must re-identify.

### Operational Notes
- Cache `resume_gateway_url` from Ready event; use it for resumes, not the initial URL.
- Use a close code **other than 1000 or 1001** when closing a zombied connection.
- During outages, continue heartbeats; Gateway will eventually respond.

---

## 12. Operational Caveats & Pitfalls

### Token Management
- 1000 IDENTIFY limit per 24h is **hard and punitive** — token reset + email notification.
- Use RESUME instead of IDENTIFY whenever possible.
- Cache Gateway URL and resume_gateway_url separately.

### Intent Gotchas
- Privileged intents must be explicitly toggled in Developer Portal **before** being used in Identify.
- Verified apps (100+ guilds) must be **approved** for privileged intents.
- Specifying a disallowed intent results in close code 4014 (no reconnect).
- On v8+, intents are mandatory. Forgetting to include them means receiving no events.

### Rate Limiting Pitfalls
- Do not hardcode rate limits — always parse response headers.
- Global rate limits can be hit unexpectedly during bulk operations.
- The `X-RateLimit-Reset` is epoch time; `X-RateLimit-Reset-After` is easier to use.
- Emoji routes have special per-guild limits that may not match header quotas.

### Message Content Caveat
- Without MESSAGE_CONTENT, the adapter cannot see what users are saying — only metadata.
- This is the most common surprise for new Discord bot developers.
- Consider whether the adapter can work with interactions-only (slash commands) to avoid needing MESSAGE_CONTENT.

### DM Limitations
- Bots cannot proactively DM users who haven't interacted with them.
- Group DMs require OAuth2 `gdm.join` scope to add members.
- DM events only go to **shard 0**.

### Thread Complexity
- Thread membership is tracked separately from channel access.
- Users are auto-added to threads when they send a message.
- Thread list sync events are sent on channel access changes.
- Archived threads are mostly immutable; sending a message unarchives.

### WebSocket Payload Limits
- Gateway payloads must not exceed **4096 bytes**.
- Larger payloads cause close code 4002.

### Encoding & Compression
- Supported encodings: `json`, `etf` (Erlang Term Format)
- Transport compression: `zlib-stream`, `zstd-stream`
- Default is JSON; ETF can be more efficient for high-volume bots.

### Community Libraries
- Discord.js (Node), discord.py (Python), JDA (Java) are mature and handle Gateway complexity, rate limits, reconnects, etc.
- For a custom adapter, consider whether to use a library or implement raw Gateway handling.

### Developer Policy Constraints
- Bots must comply with Discord Developer Terms of Service and Developer Policy.
- Abuse of API (spam, harassment, unauthorized data collection) can result in app termination.
- Bots in many guilds are subject to verification requirements.

---

## Source Attribution

All content in this document is derived from:
- **Discord API Documentation** — `discord/discord-api-docs` GitHub repository, main branch
  - `docs/developers/events/gateway.mdx`
  - `docs/developers/events/gateway-events.mdx`
  - `docs/developers/topics/rate-limits.mdx`
  - `docs/developers/topics/permissions.mdx`
  - `docs/developers/topics/oauth2.mdx`
  - `docs/developers/topics/opcodes-and-status-codes.mdx`
  - `docs/developers/resources/channel.mdx`
  - `docs/developers/resources/message.mdx`
  - `docs/developers/resources/webhook.mdx`
  - `docs/developers/interactions/application-commands.mdx`
  - `docs/developers/interactions/receiving-and-responding.mdx`
  - `docs/developers/interactions/overview.mdx`
  - `docs/developers/platform/bots.mdx`
  - `docs/developers/platform/webhooks.mdx`
  - `docs/developers/platform/oauth2-and-permissions.mdx`
  - `docs/developers/bots/overview.mdx`
  - `docs/developers/tutorials/developing-a-user-installable-app.mdx`
  - `docs/developers/reference.mdx`

Retrieved via `raw.githubusercontent.com` on 2026-06-06.
