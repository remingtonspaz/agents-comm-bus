# AGE-59 Phase 6 — Pi Telegram skill implementation plan

**Issue:** AGE-59 (The Pi Host)
**Branch:** `satriodewantono/age-59-pi-skill`
**Worktree:** `D:\tmp\acb-age59-p6`
**Base:** `main` (currently at `8338cbf`)
**Scope:** Phase 6 — implement the **Telegram skill** (`plugins/pi/telegram/skills/telegram/SKILL.md`). This is the behavioral contract that teaches the model to always reply via `comm_send_message` on the same channel, automatically. Telegram only (the live-tested comm); discord/matrix/curl skills come when those comms are wired.

## READ THESE FIRST

1. **`hosts/claude/skills/telegram/SKILL.md`** — the **primary reference** for completeness and structure. It's 55 lines with: frontmatter (`name`, `description`, `skillName`, `metadata.hermes.tags`), "When To Use", "[Agent] Behavior", "Essential Telegram Tools" (4 tools listed), and the no-target/account-must-be-concrete-bot-id guidance block. **Mirror this structure and completeness** — your skill should be similarly concise but cover all the same points, adapted for Pi.
2. **`hosts/codex/skills/telegram/SKILL.md`** — second reference; same structure, slightly different "Behavior" section (Codex-specific steer path). Shows how the same comm skill adapts to a different agent's delivery model.
3. **The current stub** at `plugins/pi/telegram/skills/telegram/SKILL.md` — your starting point (it has frontmatter `name: agents-comm-telegram` + a `TODO(phase6)` body).
4. **`docs/research/pi/CHECKLIST.md`** § Phase 6 — the content checklist (7 items) you must satisfy.
5. **`docs/research/pi/README.md`** § "Skill plan" — the shared guidance points every Pi comm skill must include.
6. **Pi skills doc** (`C:/Users/Satrio/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/skills.md`) § "Frontmatter" — Pi's frontmatter spec: `name` (required, lowercase-hyphens, max 64), `description` (required, max 1024), `metadata` (optional, arbitrary key-value). No `skillName` or `metadata.hermes` needed (those are Claude/Codex-specific).

## The key adaptation: Pi's delivery model vs Claude/Codex

The Claude skill says:
> Claude Code receives Telegram inbound as hook-injected prompt context (the `[Daemon Inbound Messages]` block prepended by the UserPromptSubmit hook). ... The wake mechanism is a `.` keystroke typed into the session's terminal by the watcher; you never trigger it yourself.

The Codex skill says:
> Codex receives Telegram inbound through the agents-comm-bus Codex bridge and its app-server wake path. In current builds the bridge **steers the active Codex turn first** ...

The **Pi version** must describe Pi's delivery model instead:
- Pi receives Telegram inbound through the **agents-comm-bus Pi extension poller** (a 2s background loop that drains `pi_drain_inbound` and injects messages via `pi.sendUserMessage`). There are no hooks, no `.` watcher keystroke, no app-server wake path — the extension polls the daemon directly and injects inbound as a **user turn** containing the `[Daemon Inbound Messages]` block.
- The inbound block arrives as a normal user message (not hook-injected prompt context like Claude). Treat it as a live user instruction from the remote Telegram user.
- If Pi is busy (mid-turn/streaming), inbound arrives as a **follow-up** message queued after the current turn — not lost, not dropped.

## Deliverable: `plugins/pi/telegram/skills/telegram/SKILL.md`

Replace the stub with a complete skill, following the Claude Telegram skill's structure but adapted for Pi. Target ~50-60 lines (similar to the Claude reference).

### Frontmatter

```yaml
---
name: agents-comm-telegram
description: Use when Pi is connected to Telegram through agents-comm-bus -- especially when a Telegram message arrives as a [Daemon Inbound Messages] block, when you need to send a Telegram update, or when you inspect Telegram conversation state. The Telegram chat is the active collaboration channel, not a notification sink.
metadata:
  comm: telegram
  agent: pi
---
```

Notes:
- `name: agents-comm-telegram` (keep the stub's name — it's valid Pi naming: lowercase-hyphens, ≤64 chars).
- `description` must be ≤1024 chars. Include the trigger phrases ("when a Telegram message arrives", "when you need to send a Telegram update", "when you inspect Telegram conversation state") so Pi's skill-matching system prompt surfaces it.
- `metadata` with `comm` + `agent` tags (useful for filtering; not required but good practice).
- Do NOT include `skillName` or `metadata.hermes` (those are Claude/Codex-specific fields from their skill systems).

### Body structure (mirror the Claude skill's sections)

#### `# Telegram Integration for Pi`

#### `## When To Use`

Same intent as the Claude version: use whenever a Telegram message reaches the Pi session, when you need to send a Telegram update, or when inspecting conversation state. Emphasize: **the Telegram chat is part of the active collaboration channel, not an external notification sink.** When a message arrives from Telegram, **reply on Telegram** — do not assume the user is watching the local terminal.

#### `## Pi Behavior`

This is the key adaptation section. Describe Pi's delivery model:
- Pi receives Telegram inbound through the **agents-comm-bus Pi extension** — a background poller (2s interval) that drains pending inbound from the daemon and injects it as a **user message** containing the `[Daemon Inbound Messages]` block. No hooks, no watcher, no app-server.
- Treat the `[Daemon Inbound Messages]` block as a live user instruction from the remote Telegram user. The block contains the message text, sender, timestamp, and routing envelope (`comm`, `account`, `chat_native_id`, `conversation_id`, etc.).
- If Pi is busy (mid-turn), inbound arrives as a **follow-up** queued after the current turn completes — not lost.
- Outbound goes back over the same channel with `comm_send_message` (`comm: "telegram"`). A local-only response (terminal output) is **invisible** to a user watching from their phone.

#### `## Essential Telegram Tools`

List the four comm tools (same as the Claude skill):
- `comm_send_message` — send concise status, questions, and final reports with `comm: "telegram"`.
- `comm_send_attachment` — send a file or image when a report needs an artifact.
- `comm_check_messages` — drain pending inbound when you suspect new Telegram context arrived but hasn't appeared yet.
- `list_conversations` — inspect known conversations and get exact chat/thread targets before sending to a non-current chat.

#### `## Routing` (or fold into the tools section like the Claude skill does)

The no-target + AGE-15 guidance block (copy from the Claude skill, it's comm-generic):
- Prefer sending with **no target** — the daemon routes to the session's most-recent inbound conversation by concrete identity automatically.
- Only set a target to reach a different chat: `{ chat_native_id, thread_native_id?, account? }`.
- `account` must be the concrete **bot id** (the `account=<id>` value in your inbound block, or `bot=<id>` from `list_conversations`) — account *labels* like `"main"` are rejected as routing targets because they are ambiguous across agents.

### Content checklist (from CHECKLIST §6.2 — ALL must be present)

- [x] Explain the `[Daemon Inbound Messages]` block contract
- [x] Instruct: user-visible remote replies go via `comm_send_message`
- [x] Instruct: omit `target` to reply to most-recent inbound
- [x] Instruct: use `list_conversations` only when targeting elsewhere
- [x] Instruct: use `comm_check_messages` when suspecting new inbound
- [x] Note: local terminal output ≠ replying to remote comm user
- [x] Note: `account=<bot_id>` is the routing key; labels like `"main"` are rejected as send targets

## Out of scope

- Discord/matrix/curl skills — only Telegram (the live-tested comm). Those come when those comms are wired.
- Commands (`commands.ts`) — Phase 7 (optional).
- Any code changes — this is a **content-only** change (one SKILL.md file). Do NOT touch `tools.ts`, `index.ts`, `daemon-client.ts`, `package.json`, or any other code file.
- Any change to `core-daemon/` or `agents-comm-bus/`.

## Verify (after implementation)

```powershell
# From the worktree root
# 1. The skill file is valid markdown with correct frontmatter
node -e "
const fs = require('fs');
const content = fs.readFileSync('plugins/pi/telegram/skills/telegram/SKILL.md', 'utf8');
const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
if (!fmMatch) { console.error('FAIL: no frontmatter'); process.exit(1); }
const fm = fmMatch[1];
if (!fm.includes('name: agents-comm-telegram')) { console.error('FAIL: missing name'); process.exit(1); }
if (!fm.includes('description:')) { console.error('FAIL: missing description'); process.exit(1); }
const descLen = fm.match(/description: (.*)/)?.[1]?.length ?? 0;
if (descLen > 1024) { console.error('FAIL: description too long'); process.exit(1); }
console.log('frontmatter OK — name + description present, desc length', descLen);
const body = content.slice(fmMatch[0].length);
const checks = ['Daemon Inbound Messages', 'comm_send_message', 'comm: \"telegram\"', 'no target', 'account', 'list_conversations', 'comm_check_messages'];
const missing = checks.filter(c => !body.includes(c));
if (missing.length) { console.error('FAIL: missing content:', missing); process.exit(1); }
console.log('body OK — all 7 content checklist items present');
"

# 2. No code files changed
git diff --name-only main..HEAD

# 3. Gates (should be unaffected — content-only change)
npm test 2>&1 | tail -5
npm run verify:clean-build 2>&1 | tail -3
```

## Commit discipline

- One commit: `AGE-59 Phase 6: Pi Telegram skill (behavioral contract for comm_send_message replies)`
- **No `DAEMON_VERSION` bump.** No code changes. Content-only.
- **Commit your own work. Do not ask.**
- Tick §6.1 (telegram only) + §6.2 in `docs/research/pi/CHECKLIST.md`.

## Definition of done

- [ ] `plugins/pi/telegram/skills/telegram/SKILL.md` is a complete skill (not a stub).
- [ ] Frontmatter: `name: agents-comm-telegram`, `description` (≤1024 chars, with trigger phrases), `metadata: { comm, agent }`.
- [ ] Body: "When To Use" + "Pi Behavior" (poller model, no hooks/watcher) + "Essential Telegram Tools" (4 tools) + no-target/AGE-15 routing guidance.
- [ ] All 7 CHECKLIST §6.2 content items present.
- [ ] No code files changed (content-only).
- [ ] `npm test` + `verify:clean-build` pass (unaffected).
- [ ] CHECKLIST §6.1 (telegram) + §6.2 ticked.
