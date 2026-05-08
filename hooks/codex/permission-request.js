#!/usr/bin/env node
/**
 * Codex PermissionRequest Hook (BLOCKING)
 *
 * Replaces the watcher+keystroke approval flow used by the Claude Code
 * version. When Codex requests permission for a tool:
 *
 *   1. Format a message describing the request and send it to Telegram.
 *   2. Write `pending-permission.json` so the MCP server bot listener
 *      knows incoming `y`/`n`/`a` text is a response, not a prompt.
 *   3. Block waiting for `permission-response.json` to appear.
 *   4. Emit `{hookSpecificOutput:{hookEventName:"PermissionRequest",
 *      decision:{behavior:"allow"|"deny",message?:"..."}}}` per Codex's
 *      hook output schema.
 *
 * On timeout we fail closed (deny) — the safe default if the user is
 * unreachable. Codex's default hook timeout is 600s; we poll for ~9
 * minutes to leave headroom.
 *
 * CommonJS so we can use `require('https')` without an ESM banner.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function getSessionDir(cwd) {
  const basename = path.basename(cwd).replace(/[^a-zA-Z0-9-_]/g, '_');
  const hash = crypto.createHash('md5').update(cwd).digest('hex').substring(0, 6);
  return path.join(os.homedir(), '.codex-telegram', `${basename}-${hash}`);
}

const SESSION_DIR = getSessionDir(process.cwd());
const PENDING_PERMISSION_FILE = path.join(SESSION_DIR, 'pending-permission.json');
const PERMISSION_RESPONSE_FILE = path.join(SESSION_DIR, 'permission-response.json');
const LAST_CHAT_FILE = path.join(SESSION_DIR, 'last-chat.json');

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 9 * 60 * 1000;

// Normalize a userId field to an array of strings. Accepts a scalar
// (string/number, the legacy single-user form) or an array.
function normalizeUserIds(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((v) => (v == null ? '' : v.toString().trim()))
    .filter((v) => v.length > 0);
}

// Returns { botToken, userIds: string[] } — userIds is the allowlist;
// first entry doubles as the proactive-send default.
function getCredentials() {
  const home = os.homedir();
  const candidates = [
    path.join(process.cwd(), '.codex', 'telegram.json'),
    path.join(__dirname, '..', '..', '.codex', 'telegram.json'),
    path.join(home, '.codex', 'telegram.json'),
    path.join(process.cwd(), '.claude', 'telegram.json'),
    path.join(__dirname, '..', '..', '.claude', 'telegram.json'),
    path.join(home, '.claude', 'telegram.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const userIds = normalizeUserIds(cfg.userId);
        if (cfg.botToken && userIds.length > 0) {
          return { botToken: cfg.botToken, userIds };
        }
      }
    } catch {}
  }
  const envIds = (process.env.TELEGRAM_USER_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env.TELEGRAM_BOT_TOKEN && envIds.length > 0) {
    return { botToken: process.env.TELEGRAM_BOT_TOKEN, userIds: envIds };
  }
  return null;
}

// Last inbound chat (DM, group, supergroup topic) the bot saw — written
// by the MCP server on every accepted message. Used to route the
// permission prompt back to the same chat instead of always DM'ing the
// configured user.
function readLastChat() {
  try {
    if (!fs.existsSync(LAST_CHAT_FILE)) return null;
    return JSON.parse(fs.readFileSync(LAST_CHAT_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function sendTelegram(botToken, chatId, message, messageThreadId) {
  return new Promise((resolve, reject) => {
    const payload = {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    };
    if (messageThreadId != null) payload.message_thread_id = messageThreadId;
    const data = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function escapeHtml(text) {
  if (typeof text !== 'string') text = String(text);
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatToolPermission(toolName, toolInput) {
  let details = '';
  if (toolName === 'Bash' && toolInput?.command) {
    details = `<code>${escapeHtml(toolInput.command)}</code>`;
  } else if (
    (toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') &&
    toolInput?.file_path
  ) {
    details = `File: <code>${escapeHtml(toolInput.file_path)}</code>`;
  } else if (toolInput && typeof toolInput === 'object') {
    const keys = Object.keys(toolInput).slice(0, 3);
    details = keys
      .map(
        (k) =>
          `${escapeHtml(k)}: ${escapeHtml(JSON.stringify(toolInput[k]).slice(0, 80))}`
      )
      .join('\n');
  }
  let m = `\u{1F510} <b>Permission Request</b>\n\n<b>Tool:</b> ${escapeHtml(toolName)}`;
  if (details) m += `\n${details}`;
  m += `\n\nReply: <b>y</b> (yes) / <b>n</b> (no) / <b>a</b> (always)`;
  return m;
}

async function pollForResponse(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(PERMISSION_RESPONSE_FILE)) {
        const raw = fs.readFileSync(PERMISSION_RESPONSE_FILE, 'utf-8');
        try {
          fs.unlinkSync(PERMISSION_RESPONSE_FILE);
        } catch {}
        return JSON.parse(raw);
      }
    } catch {}
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

function emitDecision(behavior, message) {
  const decision = { behavior };
  if (message) decision.message = message;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision,
      },
    })
  );
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let hookInput;
  try {
    hookInput = JSON.parse(input);
  } catch {
    // Can't parse — let Codex fall back to its default approval flow.
    process.exit(0);
  }

  const { tool_name, tool_input } = hookInput;
  const creds = getCredentials();
  if (!creds) {
    process.exit(0);
  }

  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

  // Drop any stale response from a prior call so the poll can't pick one up.
  try {
    fs.unlinkSync(PERMISSION_RESPONSE_FILE);
  } catch {}

  // Resolve where to send the prompt: most recent inbound chat if we
  // know one (DM, group, or supergroup topic), else the first
  // allowlisted userId as a DM.
  const lastChat = readLastChat();
  const targetChatId = lastChat?.chat_id ?? creds.userIds[0];
  const targetThreadId = lastChat?.message_thread_id ?? null;

  // Pending state — chat_id/message_thread_id let the MCP server's
  // y/n/a-handler ack in the same chat the prompt landed in.
  fs.writeFileSync(
    PENDING_PERMISSION_FILE,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        tool_name,
        tool_input,
        prompt_type: 'permission',
        chat_id: targetChatId,
        message_thread_id: targetThreadId,
      },
      null,
      2
    )
  );

  const message = formatToolPermission(tool_name, tool_input);
  try {
    await sendTelegram(creds.botToken, targetChatId, message, targetThreadId);
  } catch {}

  const response = await pollForResponse(POLL_TIMEOUT_MS);

  try {
    fs.unlinkSync(PENDING_PERMISSION_FILE);
  } catch {}

  if (!response) {
    emitDecision('deny', 'Telegram approval timed out');
    return;
  }

  // Codex's hook output only supports allow/deny — no native "always" semantic.
  // Map y/yes/a/always → allow; treat everything else as deny.
  const r = (response.response || '').trim().toLowerCase();
  if (r === 'y' || r === 'yes' || r === 'a' || r === 'always') {
    emitDecision('allow');
  } else {
    emitDecision('deny', `Denied via Telegram (${r})`);
  }
}

main().catch((err) => {
  emitDecision('deny', `Hook error: ${err.message}`);
});
