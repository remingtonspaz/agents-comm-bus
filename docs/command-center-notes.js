/*
 * Team scratchpad seed for docs/Command Center.html.
 *
 * Loaded as <script src="command-center-notes.js"> by the canvas. The
 * canvas's load() falls back to window.SEED_NOTES on first visit (gated
 * by a localStorage seed flag) and writes any user edits back to the
 * visitor's localStorage. To publish a snapshot to the team:
 *
 *   1. Open Command Center.html in a browser.
 *   2. Edit notes as you like (double-click to add, drag, etc.).
 *   3. Click "export → clipboard" in the scratchpad toolbar.
 *   4. Paste the clipboard contents over this file's SEED_NOTES array.
 *   5. Bump SEED_VERSION (e.g. "v1" -> "v2") so existing visitors get
 *      reseeded on their next reload — otherwise their localStorage
 *      wins and they won't see the new notes.
 *   6. git commit + push.
 *
 * Convention for entries: end the text with "— <handle>, <YYYY-MM-DD>"
 * so future readers know who wrote it and when. Colors: pink =
 * warning/blocker, blue = open question, yellow = general finding,
 * sage = status/done.
 */
window.SEED_VERSION = "v1";
window.SEED_NOTES = [
  {
    color: "pink",
    x: 30,
    y: 30,
    text: "⚠️ After editing agents-comm-bus/src/bootstrap/ensure-daemon.ts you MUST also `npm run build` in mcp-server/. The bundle inlines defaultSpawnDaemon; hooks pick up changes automatically, the MCP bundle does not. — claude/opus-4.7, 2026-05-17",
  },
  {
    color: "pink",
    x: 330,
    y: 30,
    text: "⚠️ MessageBus.comms is keyed by (commId, accountId). Don't add a second adapter with the same key — registerComm throws. For multi-bot support, set CommAdapter.accountId distinctly per instance (Telegram = bot_user_id). — claude/opus-4.7, 2026-05-17",
  },
  {
    color: "yellow",
    x: 30,
    y: 230,
    text: "📐 daemon.ts is adapter-agnostic. serve.ts is the only file that imports specific factories. To add a new comm/agent: one folder under adapters/{comm,agent}/<name>/ + one entry in serve.ts. Anything claude-/telegram-shaped in daemon.ts is a smell. — claude/opus-4.7, 2026-05-17",
  },
  {
    color: "blue",
    x: 330,
    y: 230,
    text: "❓ Open question: the 💬 Other button on AskUserQuestion flips query.kind to freetext and writes the user's text into the wake response. But the local Claude UI is in option-select mode — does it accept the freetext as-typed? Needs verification. Might need to type the Other option-number first, then text. — claude/opus-4.7, 2026-05-17",
  },
  {
    color: "sage",
    x: 30,
    y: 430,
    text: "ℹ️ Codex MCP server (claude-code-telegram-codex/mcp-server) polls Codex bot 8988792099 directly, separate from our daemon. Causes intermittent 409 on Codex bot polling loop. Not blocking, just noisy in audit. Resolution out of scope for the daemon. — claude/opus-4.7, 2026-05-17",
  },
  {
    color: "yellow",
    x: 330,
    y: 430,
    text: "🗒️ Drop notes here when you find something worth telling the rest of the team. Convention: end with `— <handle>, <YYYY-MM-DD>`. After editing in the browser, click `export → clipboard` and paste into docs/command-center-notes.js, bump SEED_VERSION, commit. — claude/opus-4.7, 2026-05-17",
  },
];
