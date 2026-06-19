# AGE-59 Phase 5 — Pi comm tools implementation plan

**Issue:** AGE-59 (The Pi Host)
**Branch:** `satriodewantono/age-59-pi-tools`
**Worktree:** `D:\tmp\acb-age59-p5`
**Base:** `main` (currently at `2de681f`)
**Scope:** Phase 5 ONLY — implement the four comm tools in `plugins/pi/agents-comm/extensions/agents-comm/tools.ts`. The daemon bridge (Phase 1) and extension core (Phase 4) are merged and **live-verified for inbound** (Telegram → Pi session, 2026-06-19). Phase 5 makes the **round-trip** testable: Pi can reply over `comm_send_message`.

## Context — what's already working

- The `PiDaemonClient` (Phase 4) already has the request-wrapper methods: `sendCommMessage(params)`, `sendCommAttachment(params)`, `drainPiInbound(params)`, `listConversations(params)`. They call `${comm}_send`, `${comm}_send_image`, `pi_drain_inbound`, `list_conversations` on the daemon. **Phase 5 only needs to wire `pi.registerTool(...)` definitions that call these wrappers** — the IPC plumbing exists.
- `index.ts` already calls `registerCommTools(pi)` inside a try/catch guard. Phase 5 replaces the `throw new Error("phase5: not implemented")` body with real registrations. **Do not touch `index.ts`'s guard** — leave it so a future stub failure can't break load. (After Phase 5 the guard becomes a no-op safety net; that's fine.)
- The `CommSendMessageParams` / `CommSendAttachmentParams` interfaces in `daemon-client.ts` already encode the AGE-15 invariant (`target.account` is "concrete bot_user_id — not an account label"). Use them as the source of truth for the typebox schemas.

## READ THESE FIRST (in order)

1. **`docs/research/pi/CHECKLIST.md`** — read the **Phase 5** section (§5.1–5.4) and tick boxes as you satisfy them.
2. **`docs/research/pi/README.md`** § "Tool semantics" — the four tools' intended behavior + the "omit target to reply to most-recent inbound" + "target.account must be concrete bot id" rules.
3. **The current `tools.ts` stub** at `plugins/pi/agents-comm/extensions/agents-comm/tools.ts` — your starting point; the doc comment lists the four tools.
4. **`plugins/pi/agents-comm/extensions/agents-comm/daemon-client.ts`** — the `PiDaemonClient` methods you'll call (`sendCommMessage`, `sendCommAttachment`, `drainPiInbound`, `listConversations`) and the typed param interfaces.
5. **`hosts/common/mcp-shim-shared.js`** — the **canonical reference** for tool descriptions, input schemas, and result text formatting. The MCP shim's `createMcpServer` lists all four tools with their JSON-Schema `inputSchema` and `description` strings, and `handleSendMessage` / `handleSendAttachment` / `handleCheckMessages` / `formatMessages` / `formatConversations` show the result-text shape. **Mirror the descriptions and result text closely** so skills/prompt contracts stay uniform across hosts.
6. **`C:/Users/Satrio/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`** § "Custom Tools" — the `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters, execute })` API. Note `promptSnippet` (one-line `Available tools` entry) and `promptGuidelines` (bullets appended to the `Guidelines` section — **each bullet must name the tool it refers to**, e.g. "Use comm_send_message when..." not "Use this tool when...").
7. **`C:/Users/Satrio/AppData/Roaming/npm/node_modules/@earendil-works/pi-ai`** — `StringEnum` for any string-enum params (Google-API compatibility). Not strictly needed for these tools (no enums), but the `typebox` `Type.Object` / `Type.String` / `Type.Optional` / `Type.Union` builders are what you'll use.

## Deliverable — `tools.ts`

Replace the stub with a `registerCommTools(pi: ExtensionAPI, client: PiDaemonClient)` implementation. **Signature change:** the stub is `registerCommTools(_pi: ExtensionAPI)`. Phase 5 needs the `client` to call the daemon. Update the signature to `registerCommTools(pi: ExtensionAPI, client: PiDaemonClient)` and update the call site in `index.ts` (it currently calls `registerCommTools(pi)` inside the try/catch — change to `registerCommTools(pi, client)`; the guard stays).

**Why the client is passed in, not imported:** the `client` is created in `session_start` and owns the persistent IPC connection + session identity. Tools are registered once at extension load, but they execute later when the model calls them — so they need a reference to the live client. Capture it in a closure. (Pattern: `registerCommTools` closes over `client`; the `execute` functions call `client.sendCommMessage(...)` etc.)

Edge case to handle: **a tool may be invoked before `session_start` completes** (e.g. the model calls `list_conversations` immediately on a fresh session). If `client` is null/not-started, the tool should return a concise error (`"agents-comm-bus not connected yet"`) rather than throw and crash. The `PiDaemonClient` methods already throw `"PiDaemonClient not started"` if `client` is null — catch that in the tool's `execute` and return it as `isError: true` text. (Per Pi docs: **throw to signal a tool error** sets `isError: true`; but for a not-connected state we want a graceful text result, so catch + return `{ content: [{type:"text", text: "..."}], isError: true }`.)

### 5.1 `comm_send_message`

- **typebox schema** matching the MCP shim's `inputSchema`:
  - `comm`: `Type.String({ description: "Comm adapter id to route through. Must match a registered comm." })` — required
  - `message`: `Type.String({ description: "The message text to send" })` — required
  - `target`: optional object `{ chat_native_id: string|number, thread_native_id?: string|number, account?: string|number }`. `account` description: `"Concrete bot id only (the account=<id> value in your inbound block, or bot=<id> from list_conversations) — account LABELS like \"main\" are rejected, they are ambiguous across agents."`
- **label:** `"Send Comm Message"`
- **description:** mirror the MCP shim's `comm_send_message` description (the "OMIT target to reply to the session's most-recent-inbound conversation" guidance is load-bearing — keep it).
- **promptSnippet:** e.g. `"Send a text reply over a comm (Telegram/Discord/Matrix/curl). Omit target to reply to the most-recent inbound."`
- **promptGuidelines:** bullets that **name the tool**:
  - `"Use comm_send_message for user-visible remote replies over a comm — local terminal output is NOT seen by the remote user."`
  - `"When replying to an inbound message, omit target on comm_send_message to route back to the most-recent inbound conversation automatically."`
  - `"comm_send_message's target.account must be a concrete bot id (the account=<id> from your inbound block), never an account label like \"main\"."`
- **execute:** `const result = await client.sendCommMessage({ comm, text: message, target })`. Return `{ content: [{ type: "text", text: \`Message sent via agents-comm-bus (${result.message_id})\` }] }`. On `DisconnectedError` or not-started, return `isError: true` with the concise message.
- **Validate** `comm` and `message` are non-empty strings; return an `isError` text if not (mirror `handleSendMessage`'s `toolError` guards).

### 5.2 `comm_send_attachment`

- **schema:** `comm` (required), `path` (required, `"Absolute path to the file/image"`), `caption` (optional), `target` (optional, same shape as 5.1).
- **label:** `"Send Comm Attachment"`
- **description:** mirror the MCP shim's `comm_send_attachment` description.
- **promptSnippet:** `"Send a file/image attachment over a comm."`
- **promptGuidelines:** `"Use comm_send_attachment to share a file or image with a remote user over a comm; it respects the same target semantics as comm_send_message."`
- **execute:** **validate `path` exists** with `existsSync` (from `node:fs`) before calling the daemon — mirror `handleSendAttachment`'s `if (!existsSync(args.path)) return toolError(\`Error: File not found: ${args.path}\`)`. Then `const result = await client.sendCommAttachment({ comm, path, caption, target })`. Return `\`Attachment sent via agents-comm-bus (${result.message_id})\``.

### 5.3 `comm_check_messages`

- **schema:** optional `comm` (`Type.Optional(Type.String({ description: "Optional comm filter; when omitted all pending inbound messages across comms are returned." }))`).
- **label:** `"Check Comm Messages"`
- **description:** mirror the MCP shim's `comm_check_messages` description.
- **promptSnippet:** `"Drain pending inbound comm messages (optionally filter by comm)."`
- **promptGuidelines:** `"Use comm_check_messages when you suspect new inbound arrived since your last turn and no [Daemon Inbound Messages] block has appeared."`
- **execute:** `const { messages } = await client.drainPiInbound({ agent: "pi", session: <piSession>, project: <cwd>, comm, limit: 100 })`. **Use `pi_drain_inbound`** (the Pi bridge method), NOT the generic `drain_pending_inbound` — per README § Tool semantics, this keeps inbound scoping consistent with session registration. (The `PiDaemonClient.drainPiInbound` wrapper already targets `pi_drain_inbound`.) **You need the `session` + `project`** — the tool's `execute` receives `ctx` (the `ExtensionContext`); read `ctx.cwd` for project. For `session`, the client doesn't currently expose the piSession id; **see the session-plumbing note below.**
- **result text:** if `messages.length === 0`, return `\`No pending messages${comm ? \` from ${comm}\` : ""}\``. Else reuse `formatInboundMessages(messages)` from `inbound-format.ts` to produce the same `[Daemon Inbound Messages]` block the poller uses — **do not** use the MCP shim's `formatMessages` (that's a different, looser format). Import `formatInboundMessages` from `./inbound-format.js`.

### 5.4 `list_conversations`

- **schema:** optional `comm`, optional `limit` (`Type.Optional(Type.Number({ description: "Maximum conversations to return" }))`).
- **label:** `"List Conversations"`
- **description:** mirror the MCP shim's `list_conversations` description.
- **promptSnippet:** `"List conversation inventory from the daemon (surfaces bot_user_id routing keys)."`
- **promptGuidelines:** `"Use list_conversations only when you need to target a conversation other than your most-recent inbound; the bot=<id> it surfaces is the concrete account to pass to comm_send_message's target.account."`
- **execute:** `const conversations = await client.listConversations({ comm, limit })`. If empty, return `"No conversations found"`. Else format with the **bot-id-oriented display** the MCP shim's `formatConversations` uses (surface `bot_user_id` explicitly — it's the routing key): `\`${comm} bot=${bot_user_id} chat_native_id=${chat}${thread ? ":"+thread : ""} agent=${agent} account_label=${account_label} last=${lastTime}\`` per line. **Port `formatConversations` from `hosts/common/mcp-shim-shared.js`** into `tools.ts` (or a small helper) — keep the bot-id-surfacing behavior identical.

## Session-plumbing note (for `comm_check_messages`)

`comm_check_messages` needs the Pi session id (`piSession`) for the `pi_drain_inbound` call. Currently `piSession` lives in `index.ts` module scope and isn't passed to `registerCommTools`. Two clean options — **pick one and note it in a comment**:

1. **Pass a `getSession()` getter to `registerCommTools`**: `registerCommTools(pi, client, () => piSession)`. The tool's `execute` calls `getSession()` at invocation time (not registration time) to read the current piSession. Handles `/new`/`/resume` correctly since `index.ts` updates `piSession` on each `session_start`.
2. **Read from `ctx.sessionManager` in `execute`**: the tool's `execute` receives `ctx`; call `piSessionId(ctx.sessionManager)` directly. Self-contained, no closure over `index.ts` state. Slightly reimplements the session-id derivation at the call site, but `piSessionId` is already a one-liner import.

**Recommend option 2** — cleaner, no new plumbing through `registerCommTools`, and `piSessionId(ctx.sessionManager)` is the documented derivation. The `execute(_id, params, _signal, _onUpdate, ctx)` signature gives you `ctx` directly. For `project`, use `ctx.cwd`.

## Out of scope (do NOT do these — later phases)

- Skill content (`skills/<comm>/SKILL.md`) — Phase 6.
- Diagnostic commands (`/comm-status` etc.) — Phase 7 (optional); `commands.ts` stays a stub.
- Live smoke testing — Phase 8 (you can't run `pi -e` headlessly; the round-trip test happens after merge with Satrio's live Pi + Telegram bot).
- Any change to `core-daemon/` (daemon side done).
- Any change to `daemon-client.ts` method bodies (they exist; you only call them). You MAY add a small helper to `daemon-client.ts` if a return-type shape is needed, but prefer keeping `tools.ts` self-contained.
- Editing `index.ts` beyond the one call-site change (`registerCommTools(pi)` → `registerCommTools(pi, client)`). The guard stays.

## Verify (after implementation)

From the worktree root (`D:/tmp/acb-age59-p5`):

```powershell
# Workspace prep (fresh worktree — install all workspace deps or subprocess tests flake, AGE-48)
cd packages/core-contracts && npm install && npm run build && cd ../..
cd agents-comm-bus && npm install && npm run build && cd ..
cd hosts && npm install && cd ..

# 1. tools.ts loads cleanly (no top-level throw now that it's implemented)
npx tsx -e "import('./plugins/pi/agents-comm/extensions/agents-comm/tools.ts').then(m=>console.log('tools ok:',Object.keys(m))).catch(e=>{console.error('FAIL:',e.message);process.exit(1)})"
# 2. index.ts still parses (the call-site change is valid)
npx tsx -e "import('./plugins/pi/agents-comm/extensions/agents-comm/index.ts').then(()=>console.log('index parses')).catch(e=>{console.error('FAIL:',e.message);process.exit(1)})" 2>&1 | tail -3
#    (index.ts may throw on pi.on without a runtime — if it does, that's expected; verify it PARSES via tsc --noEmit against a loose config, or just eyeball + node --check after tsx strip)

# 3. Daemon package still builds + full test suite green (no regressions — Phase 5 doesn't touch daemon code)
npm test 2>&1 | tail -8
npm run verify:clean-build 2>&1 | tail -5
npm run check:version-bump 2>&1 | tail -3
```

If `npx tsx` isn't available, `npm install tsx --no-save` in the worktree root.

**Key success criterion:** `tools.ts` imports cleanly (no `phase5: not implemented` throw at module load), the four `pi.registerTool` calls are well-formed, and the daemon package's tests/verify-gates stay green. A live round-trip test (Pi replies over Telegram) happens in Phase 8 after merge.

## Commit discipline

- Commit messages prefixed `AGE-59 ...`.
- One commit for the tools.ts implementation + the index.ts call-site change + CHECKLIST ticks.
- **No `DAEMON_VERSION` bump** (no daemon code changed). **Do NOT edit `agents-comm-bus/package.json`, the root `package.json`, or `package-lock.json`** — Phase 5 is extension-only. If `check:version-bump` complains, investigate before touching anything; it shouldn't.
- **Commit your own work. Do not ask whether to commit.** Run the Verify commands, then `git add -A && git commit -m "AGE-59 ..."`.

## Definition of done (Phase 5)

- [ ] `tools.ts` implements `registerCommTools(pi, client)` with all four tools registered via `pi.registerTool`.
- [ ] `comm_send_message`: typebox schema (comm/message required, target optional with AGE-15 account description), calls `sendCommMessage`, returns concise `message_id` text, validates inputs, handles not-connected gracefully.
- [ ] `comm_send_attachment`: schema (comm/path required, caption/target optional), `existsSync` path validation, calls `sendCommAttachment`, returns `message_id` text.
- [ ] `comm_check_messages`: schema (optional comm), calls `drainPiInbound` with `piSessionId(ctx.sessionManager)` + `ctx.cwd`, returns `formatInboundMessages` block or "no pending" text.
- [ ] `list_conversations`: schema (optional comm/limit), calls `listConversations`, returns bot-id-oriented `formatConversations`-style text.
- [ ] Each tool has `promptSnippet` + `promptGuidelines` with bullets that **name the tool**.
- [ ] `index.ts` call-site updated to `registerCommTools(pi, client)`; guard preserved.
- [ ] No top-level throw in `tools.ts`; not-connected state returns `isError` text, doesn't crash.
- [ ] `npm test` green (678 pass baseline); `verify:clean-build` passes; `check:version-bump` passes.
- [ ] Tick §5.1–5.4 boxes in `docs/research/pi/CHECKLIST.md`.
- [ ] **No changes to `agents-comm-bus/package.json`, root `package.json`, or `package-lock.json`.**

## After Phase 5

Report back with: the implemented tools, confirmation that `tools.ts` loads + gates green, which session-plumbing option you picked (1 or 2), and any decisions. After merge, Satrio runs the live round-trip: Pi replies to the Telegram inbound via `comm_send_message` → Telegram bot/chat receives it (completing the remaining 8.1 items).
