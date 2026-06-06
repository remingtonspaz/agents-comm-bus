> Written 2026-05-18.

# Setting up Matrix for `agents-comm-bus`

This walks you through connecting `agents-comm-bus` to Matrix end-to-end:
picking or running a homeserver, creating a bot account, getting an
access token, and pointing the daemon at it.

If you want the protocol-level details for any of this, see
[matrix-api.md](./matrix-api.md) in the same folder.

## 1. What you're setting up

Matrix is a federated chat protocol — there isn't a single Matrix service
like there's a single Telegram. You (or someone) runs a *homeserver*, and
your account lives on that homeserver. Other users on other homeservers
can still message you via federation.

To use Matrix as a comm channel for the daemon, you need:

1. An account on **some** Matrix homeserver. This account is the "bot" —
   you'll log into it once to get a token, then never touch it again.
2. The bot's access token, configured into a daemon registration.
3. A room with the bot in it, where you and the bot will talk.

Matrix has no separate "bot account" type. A bot account is just a regular
user account with a long-lived access token, used by software rather than
a human.

## 2. Choose a homeserver

Three options, easiest first.

### Option A — Easy: register on `matrix.org`

Free, public, works out of the box. Rate-limited (around a few messages
per second per account), shared infrastructure, occasional federation
issues with smaller homeservers.

1. Go to [app.element.io](https://app.element.io).
2. Click **Create Account**.
3. Leave the homeserver as `matrix.org`.
4. Pick a username — `agents-comm-bot-<yourname>` is a reasonable choice,
   `matrix.org` username squatting is real so add a suffix.
5. Pick a strong password. Save it in your password manager.
6. Complete signup (email verification, captcha).

You now have `@agents-comm-bot-<yourname>:matrix.org`.

### Option B — Privacy: register on a community homeserver

Public homeservers operated by people who aren't Element. Faster signups
in some cases, less crowded, varying federation reliability.

1. Browse [joinmatrix.org/servers](https://joinmatrix.org/servers/) for a
   homeserver that looks reputable.
2. Follow its signup link (most use Element-web on their own domain).
3. Pick a username, save the password.

### Option C — Self-host: run Synapse

Full control, no rate limits, your data stays yours. Operational burden:
you have to keep it running and federated.

The smallest reasonable setup is a Synapse Docker container with a reverse
proxy. Walk through:
[element-hq.github.io/synapse/latest/setup/installation.html](https://element-hq.github.io/synapse/latest/setup/installation.html).

For a localhost-only test setup (no federation), Synapse via Docker plus
`generate` to seed `homeserver.yaml` is about 10 minutes of work. Federate
later if you want.

### Cost summary

Synapse itself is free software (AGPL). What costs money is the hosting.
Prices accurate as of 2026-05-18; verify against the linked sources before
budgeting.

| Option | Out-of-pocket | Operator who admins it (= who can read unencrypted messages) |
|---|---|---|
| A — `matrix.org` | Free | Element / matrix.org admins |
| B — community server | Usually free | That server's operator |
| C-DIY — VPS + self-host Synapse | ≈ €5–9/month | You |
| C-managed — `etke.cc` and similar | ≈ €10–20/month (see caveat below) | The managed host's operator (you also have admin access) |

**DIY breakdown (C-DIY).** Hetzner is the value pick: CX23 is €3.49/month
for 2 vCPU / 4 GB RAM, and the slightly larger CPX22 (2 vCPU / 4 GB / 40 GB
NVMe) is €7.99/month — comfortable for a low-traffic single-bot homeserver.
Add a domain (~$10–15/year, ~$1/month amortized). DigitalOcean equivalents
start around $24/month for the same RAM, so they're not competitive for
this use case. Synapse's documented minimum is 1 vCPU / 1 GB RAM with
PostgreSQL; the [single-board-computer
notes](https://element-hq.github.io/synapse/latest/other/running_synapse_on_single_board_computers.html)
confirm you can run it leaner if disciplined. Initial setup is 1–2 hours
via Docker.

**Managed breakdown (C-managed).** [etke.cc](https://etke.cc/) is the
most-used at-cost Matrix-hosting service: they price as the underlying
Hetzner costs (no markup beyond their ops overhead) and bill in EUR. Their
order form is JavaScript-rendered, so exact pricing must be read directly
at [etke.cc/order](https://etke.cc/order/) — community-reported small-tier
pricing is around €10–20/month all-in (server + management + optional
extras like email/bridges). [Element Matrix Services
(EMS)](https://element.io/en/pricing) Business is $5/user/month and
Enterprise / Synapse Pro is contact-sales (~$10+/user/month); both are
sold by-the-seat to organizations and aren't competitive for a single bot
account.

**Recommendation for a single-bot daemon.** C-DIY on Hetzner CX23 — about
€5/month all-in, ~1–2 hours of setup time, and you become the operator
(which also resolves the question of "who can read my bot's unencrypted
messages": only you). The "managed" premium over DIY is essentially
buying back your time, not infrastructure. If you don't want to administer
Synapse updates, certs, and backups, the managed path is reasonable;
otherwise DIY wins on every axis except setup time.

Pricing sources:
- [Hetzner Cloud pricing](https://www.hetzner.com/cloud)
- [DigitalOcean Droplet pricing](https://www.digitalocean.com/pricing)
- [etke.cc pricing & ordering](https://etke.cc/order/)
- [Element plans and pricing](https://element.io/en/pricing)
- [Synapse hosting notes (matrix.org)](https://matrix.org/docs/older/understanding-synapse-hosting/)

## 3. Create the bot account

If you did option A or B, you already have an account. Done.

If you self-hosted (option C), create the account with `register_new_matrix_user`:

```bash
docker exec -it synapse register_new_matrix_user \
  -c /data/homeserver.yaml \
  -u agents-comm-bot \
  -p '<strong-password>' \
  --no-admin \
  http://localhost:8008
```

Save the password in a password manager — you'll need it once more in the
next step.

## 4. Get an access token

Two paths. The CLI path is preferred for daemon use.

### Option A — Element web (easy, but coupled to your live session)

1. Log into [app.element.io](https://app.element.io) as the bot account.
2. Click your name (top-left) → **All settings**.
3. Go to **Help & About**.
4. Scroll to **Advanced** and click **Access Token** to reveal it.
5. Copy carefully. This token grants **full control** of the account.

**Gotcha:** this token belongs to your Element web session's device. If
you log out of Element web, the token dies. Use the CLI path instead for
anything long-running.

### Option B — CLI (recommended for daemons)

Creates a fresh `device_id` that's independent of any browser session.

Replace `<homeserver-url>`, `<username>`, `<password>`:

```bash
curl -X POST 'https://matrix.org/_matrix/client/v3/login' \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "m.login.password",
    "identifier": { "type": "m.id.user", "user": "agents-comm-bot" },
    "password": "<password>",
    "initial_device_display_name": "agents-comm-bus"
  }'
```

Example response:

```json
{
  "access_token": "syt_YWdlbnRzLWNvbW0tYm90_xyzabc123...",
  "device_id": "GHTYAJCE",
  "user_id": "@agents-comm-bot:matrix.org",
  "expires_in_ms": null,
  "well_known": { "m.homeserver": { "base_url": "https://matrix.org" } }
}
```

Save:

- `access_token` — the secret. Treat it like a password.
- `user_id` — the canonical MXID of the bot.
- `device_id` — used by the daemon to identify which device is syncing.

**Replace `matrix.org` in the URL** if you're on a different homeserver.

## 5. Pick or create a room

The bot needs to be in a room to send and receive messages.

### Easiest path: invite the bot to a room you control

1. In your normal Matrix client (Element, etc.), create a new room. **Turn
   off encryption** when creating it — see gotcha 1 below.
2. Invite the bot by MXID: `@agents-comm-bot:matrix.org`.
3. Either:
   - Log into the bot once and accept the invite, or
   - Configure the daemon's adapter with auto-accept (it will join on
     first sync).

### Get the room ID

The daemon needs the *room ID*, not the human-friendly alias.

- **Element web**: right-click the room → **Settings** → **Advanced** →
  **Internal room ID**. Format: `!abcdef:matrix.org`.
- **CLI**: from a `/sync` response, every joined room shows up as a key
  under `rooms.join`.

## 6. Configure the daemon

Add a Matrix registration to the daemon. The exact JSON shape lives next
to the other comm registrations and looks roughly like this:

```json
{
  "comm": "matrix",
  "homeserver_url": "https://matrix.org",
  "access_token": "syt_YWdlbnRzLWNvbW0tYm90_xyzabc123...",
  "bot_user_id": "@agents-comm-bot:matrix.org",
  "device_id": "GHTYAJCE",
  "default_room_id": "!abcdef:matrix.org",
  "allowed_room_ids": ["!abcdef:matrix.org"]
}
```

Field notes:

- `bot_user_id` is the canonical key in `account_registrations` — see the
  [routing invariant](../../docs/architecture/invariants.md). The daemon verifies
  this against `/account/whoami` at startup and refuses to start if they
  disagree.
- `allowed_room_ids` is an allowlist; messages from rooms not listed are
  audit-logged and dropped.
- `device_id` is optional but recommended — keeps the same E2EE identity
  across restarts and avoids accumulating phantom device rows on the
  account.

## 7. Verify it works

Two quick `curl` checks before you start the daemon.

### whoami — does the token work?

```bash
curl -H 'Authorization: Bearer <access_token>' \
  'https://matrix.org/_matrix/client/v3/account/whoami'
```

Expected:

```json
{
  "user_id": "@agents-comm-bot:matrix.org",
  "device_id": "GHTYAJCE",
  "is_guest": false
}
```

If you get `401 M_UNKNOWN_TOKEN` instead, the token is wrong or has been
invalidated — see gotcha 3 below.

### send a test message — does the room work?

```bash
curl -X PUT \
  -H 'Authorization: Bearer <access_token>' \
  -H 'Content-Type: application/json' \
  'https://matrix.org/_matrix/client/v3/rooms/!abcdef:matrix.org/send/m.room.message/setup-test-1' \
  -d '{ "msgtype": "m.text", "body": "hello from setup" }'
```

Expected:

```json
{ "event_id": "$xyz:matrix.org" }
```

You should see the message appear in the room from your other client. If
you get `403 M_FORBIDDEN`, the bot isn't in the room — go back to step 5.

The `setup-test-1` in the URL is the transaction ID. If you re-run the
same command, the homeserver de-duplicates it and you get the *same*
`event_id` back rather than a second message.

## 8. Common gotchas

**1. Encrypted rooms aren't supported in V1.**
V1 of the adapter does not implement E2EE (Olm/Megolm key handling). If
you invite the bot to an encrypted room, it will see opaque
`m.room.encrypted` events it cannot read, and the daemon will log an
audit entry. Turn off encryption when creating the room. You can verify
in Element by going to room settings → Security & Privacy; "Encryption"
should read **Off**. Encryption cannot be un-set once enabled on a room
— you'd have to make a new room.

**2. Federation can fail.**
If your bot is on `example.org` and the human user is on `matrix.org`,
both homeservers need to be talking. Some servers block specific others
for moderation reasons. Symptom: messages appearing on one side but not
the other. Workaround: put both accounts on the same homeserver (or
self-host).

**3. Logging the bot out invalidates the token.**
If you grabbed the token through Element web and later log out of that
Element session, the daemon's token dies. Use the CLI flow (step 4 option
B), which creates a token bound to a fresh `device_id` independent of any
browser session.

**4. `matrix.org` rate limits.**
The shared homeserver is rate-limited toward humans, not bots. Sustained
chatter from the bot may hit
[`M_LIMIT_EXCEEDED`](./matrix-api.md#14-rate-limits) (429). If you see
these regularly, either slow down the bus or self-host (option C in step
2).

**5. Don't paste the token anywhere public.**
The access token is full account control. Treat it like a password.
Never commit it to a repo. Never share screenshots that include it. If
you suspect it leaked, log out the bot account everywhere and start over
from step 4.

**6. Long initial sync.**
If the bot account has been in many rooms historically, its first
connection to the homeserver may take a while as `/sync` returns
everything. Subsequent syncs are incremental and fast.

## 9. Migrating to a different homeserver later

Matrix bakes the homeserver into the user ID (`@bot:server.tld`). You
can't *move* an account — you create a new one on the new homeserver
and abandon the old identity. For a daemon bot this is annoying but
not catastrophic; the operational cost is mostly re-inviting it to
rooms.

### What survives, what doesn't

**Survives:**

- Room membership your new bot account is invited to fresh.
- Daemon state for new conversations (new `account_registrations` row,
  new `conversations` rows keyed by the new `bot_user_id`).

**Doesn't:**

- The old `@bot:old-server.tld` identity. Messages it sent stay attached
  to that user ID forever — rooms keep showing them as historical
  messages from a user that has left.
- Access tokens, `device_id`, any cross-signing material.
- The old `account_registrations` row stops routing because no inbound
  events match its `bot_user_id` anymore. It stays in the DB as a
  historical record (not GC'd in V1) unless you delete it.

### Migration procedure for the bot

1. **Register on the new homeserver** — repeat step 3 with a new user on
   the new server.
2. **Mint a new access token** — repeat step 4 using the CLI flow (4B),
   which gives the token a fresh `device_id` independent of any
   browser session.
3. **Get the bot invited to the rooms again** — from each room you want
   the bot in, invite `@new-bot:new-server.tld`. Don't archive the old
   bot account on the old homeserver until this is done; some rooms
   need an admin (often the old bot itself, if it had power level) to
   handle the invite.
4. **Update the registration** — replace `homeserver_url`, `user_id`,
   and `credentials.access_token` on the existing registration row, or
   add a new row and remove the old. Keeping the same `account_label`
   preserves continuity in the conversation grouping.
5. **Restart the daemon** — the Matrix adapter re-runs
   `/account/whoami` on startup, picks up the new `bot_user_id`, and
   starts a fresh `/sync` cursor against the new homeserver.
6. **Verify** — repeat step 7 with the new access token and a known
   room. Inbound message from the room should route to the new
   registration.

### Skip the question entirely: self-host from day one

The most durable answer to "what if I want to move later?" is to never
be on someone else's homeserver. If you run Synapse yourself (option C
in step 2), the homeserver moves *with you* — when you change cloud
providers or hardware, you migrate the Synapse instance, not the
Matrix identity. The bot's `@bot:your-domain.tld` stays stable as long
as you keep the domain.

This is more operational work upfront. It's the right call if you
expect the daemon to be long-lived and care about identity continuity.

### Note on encrypted rooms

If you were ever in encrypted rooms with the old account, the message
history is unrecoverable on the new account unless you exported room
keys *before* logging out the old one and imported them after. This is
moot for V1 of the adapter (encrypted rooms aren't supported anyway)
and listed here for future reference.

## 10. Where to go next

- Protocol-level details: [matrix-api.md](./matrix-api.md).
- Adapter invariants (single ownership, routing, etc.):
  [`../../docs/architecture/invariants.md`](../../docs/architecture/invariants.md).
- Storage layout (where the daemon caches the `next_batch` sync token):
  [`../../docs/architecture/storage-layout.md`](../../docs/architecture/storage-layout.md).
