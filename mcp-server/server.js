#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { wakeMostRecentThread } from './codex-app-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Startup debug log — written before anything that can crash the process,
// so we can diagnose Codex Remote-TUI spawning (which cwd does the
// app-server pass us? does the per-project config's cwd field apply?
// is there a workspace/project env var we can use?).
// Path is fixed so it's findable without knowing the session dir yet.
try {
  const debugDir = path.join(os.homedir(), '.codex-telegram');
  fs.mkdirSync(debugDir, { recursive: true });
  // Capture env vars that might point at the project dir.
  const envSubset = {};
  for (const k of Object.keys(process.env)) {
    if (/^(CODEX|WORKSPACE|PROJECT|PWD|OLDPWD|INIT_CWD|MCP|TELEGRAM)/i.test(k)) {
      envSubset[k] = process.env[k];
    }
  }
  fs.appendFileSync(
    path.join(debugDir, 'startup.log'),
    `[${new Date().toISOString()}] pid=${process.pid} cwd=${process.cwd()} argv=${JSON.stringify(process.argv.slice(1))} env=${JSON.stringify(envSubset)}\n`
  );
} catch {}

// debugLog writes a line to ~/.codex-telegram/startup.log. Used for
// events we want visible regardless of whether stderr reaches Codex's
// session log. Cheap, fire-and-forget.
function debugLog(line) {
  try {
    fs.appendFileSync(
      path.join(os.homedir(), '.codex-telegram', 'startup.log'),
      `[${new Date().toISOString()}] pid=${process.pid} ${line}\n`
    );
  } catch {}
}

// Last-ditch error logging so unhandled exceptions don't disappear into
// "connection closed: initialize response" with no clue why.
process.on('uncaughtException', (err) => {
  try {
    fs.appendFileSync(
      path.join(os.homedir(), '.codex-telegram', 'startup.log'),
      `[${new Date().toISOString()}] pid=${process.pid} uncaughtException: ${err.stack || err.message || err}\n`
    );
  } catch {}
  console.error(`[telegram-mcp] uncaughtException: ${err.stack || err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  try {
    fs.appendFileSync(
      path.join(os.homedir(), '.codex-telegram', 'startup.log'),
      `[${new Date().toISOString()}] pid=${process.pid} unhandledRejection: ${err?.stack || err?.message || err}\n`
    );
  } catch {}
  console.error(`[telegram-mcp] unhandledRejection: ${err?.stack || err?.message}`);
});

// Detect which agent is hosting this MCP server. Codex installs pass
// `--agent=codex` in the args block; Claude Code installs don't pass
// anything, so the default keeps existing setups working.
//
// The agent identity drives two things:
//   1. Session directory: ~/.codex-telegram/ vs ~/.claude-telegram/
//      (so a Claude session and a Codex session in the same project
//      don't race on shared state files)
//   2. Credential lookup priority: codex → check .codex/telegram.json
//      first, claude → check .claude/telegram.json first
function detectAgent() {
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--agent=(\w+)$/);
    if (m) return m[1].toLowerCase();
  }
  if (process.env.TELEGRAM_AGENT) return process.env.TELEGRAM_AGENT.toLowerCase();
  return 'claude';
}

const AGENT = detectAgent();
const SESSION_DIR_PARENT = AGENT === 'codex' ? '.codex-telegram' : '.claude-telegram';

function getSessionDir(cwd) {
  const basename = path.basename(cwd).replace(/[^a-zA-Z0-9-_]/g, '_');
  const hash = crypto.createHash('md5').update(cwd).digest('hex').substring(0, 6);
  return path.join(os.homedir(), SESSION_DIR_PARENT, `${basename}-${hash}`);
}

// Normalize a userId field to an array of strings. Accepts a scalar
// (string or number) or an array — scalars wrap to a single-element
// array for backward compatibility with older telegram.json files.
function normalizeUserIds(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map((v) => (v == null ? '' : v.toString().trim()))
    .filter((v) => v.length > 0);
}

// Load credentials from project-specific config or environment variables.
// The candidate order depends on the active agent: each agent prefers
// its own config dir, with the other as a legacy fallback. The home-dir
// fallbacks (~/.codex/telegram.json, ~/.claude/telegram.json) catch the
// Codex Remote-TUI case where the MCP server is spawned by an
// app-server in a different cwd than the project.
//
// Returns: { botToken, userIds: string[] }  (userIds is the allowlist;
// first entry doubles as the proactive-send default).
function loadCredentials() {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const home = os.homedir();
  const codexCandidates = [
    path.join(process.cwd(), '.codex', 'telegram.json'),
    path.join(pluginRoot, '.codex', 'telegram.json'),
    path.join(home, '.codex', 'telegram.json'),
  ];
  const claudeCandidates = [
    path.join(process.cwd(), '.claude', 'telegram.json'),
    path.join(pluginRoot, '.claude', 'telegram.json'),
    path.join(home, '.claude', 'telegram.json'),
  ];
  const candidatePaths =
    AGENT === 'codex'
      ? [...codexCandidates, ...claudeCandidates]
      : [...claudeCandidates, ...codexCandidates];

  for (const configPath of candidatePaths) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const userIds = normalizeUserIds(config.userId);
      if (config.botToken && userIds.length > 0) {
        console.error(`[telegram-mcp] (agent=${AGENT}) Using credentials from ${configPath} (${userIds.length} allowed user${userIds.length === 1 ? '' : 's'})`);
        return { botToken: config.botToken, userIds };
      }
    } catch (e) {
      console.error(`[telegram-mcp] Error reading ${configPath}: ${e.message}`);
    }
  }

  // Fall back to environment variables. TELEGRAM_USER_ID may be a
  // single value or a comma-separated list.
  const envIds = (process.env.TELEGRAM_USER_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    userIds: envIds,
  };
}

const credentials = loadCredentials();
const TELEGRAM_BOT_TOKEN = credentials.botToken;
const ALLOWED_USER_IDS = credentials.userIds;
// First entry doubles as the proactive-send default when no incoming
// chat is known (i.e. agent calls telegram_send without a recent
// inbound message to reply to).
const DEFAULT_CHAT_ID = ALLOWED_USER_IDS[0];
const SESSION_DIR = getSessionDir(process.cwd());
const QUEUE_FILE = path.join(SESSION_DIR, 'queue.json');

// Validate configuration
function exitMissingCreds(which) {
  const msg = `${which} not found — searched per-project (.codex/.claude), pluginRoot, and home-dir locations. Set credentials via <project>/.codex/telegram.json, ~/.codex/telegram.json, or ${which} env var.`;
  console.error(`[telegram-mcp] ${msg}`);
  try {
    fs.appendFileSync(
      path.join(os.homedir(), '.codex-telegram', 'startup.log'),
      `[${new Date().toISOString()}] pid=${process.pid} agent=${AGENT} cwd=${process.cwd()} ${msg}\n`
    );
  } catch {}
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN) exitMissingCreds('TELEGRAM_BOT_TOKEN');
if (ALLOWED_USER_IDS.length === 0) exitMissingCreds('TELEGRAM_USER_ID');

// Ensure queue directory exists
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Initialize empty queue if file doesn't exist
if (!fs.existsSync(QUEUE_FILE)) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify({ messages: [] }, null, 2));
}

// Initialize Telegram bot with polling
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Log to stderr (stdout is reserved for MCP protocol)
function log(message) {
  console.error(`[telegram-mcp] ${message}`);
}

// Track processed message IDs to prevent duplicates (Telegram polling can deliver duplicates)
const processedMessageIds = new Set();
const MAX_PROCESSED_IDS = 1000; // Limit memory usage

// Add message ID to processed set with cleanup
function markMessageProcessed(messageId) {
  processedMessageIds.add(messageId);
  // Clean up old IDs if set gets too large
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const idsArray = Array.from(processedMessageIds);
    const toRemove = idsArray.slice(0, idsArray.length - MAX_PROCESSED_IDS / 2);
    toRemove.forEach(id => processedMessageIds.delete(id));
  }
}

// Check if message was already processed
function isMessageProcessed(messageId) {
  return processedMessageIds.has(messageId);
}

// Check if a message is a permission response (y/n/a)
function isPermissionResponse(text) {
  const normalized = (text || '').trim().toLowerCase();
  return ['y', 'n', 'a', 'yes', 'no', 'always'].includes(normalized);
}

// Check if a message is a numeric response (for AskUserQuestion)
function isNumericResponse(text) {
  const normalized = (text || '').trim();
  return /^\d+$/.test(normalized);
}

// Normalize permission response to single character
function normalizePermissionResponse(text) {
  const normalized = (text || '').trim().toLowerCase();
  if (normalized === 'yes' || normalized === 'y') return 'y';
  if (normalized === 'no' || normalized === 'n') return 'n';
  if (normalized === 'always' || normalized === 'a') return 'a';
  return null;
}

// Read pending permission info
function getPendingPermission() {
  try {
    if (!fs.existsSync(PENDING_PERMISSION_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(PENDING_PERMISSION_FILE, 'utf-8'));
    // Consider pending if created within last 5 minutes
    const age = Date.now() - new Date(data.timestamp).getTime();
    if (age >= 5 * 60 * 1000) return null;
    return data;
  } catch (e) {
    return null;
  }
}

// Check for pending permission request
function hasPendingPermission() {
  return getPendingPermission() !== null;
}

// Clear pending permission
function clearPendingPermission() {
  try {
    if (fs.existsSync(PENDING_PERMISSION_FILE)) {
      fs.unlinkSync(PENDING_PERMISSION_FILE);
    }
  } catch (e) {
    log(`Error clearing pending permission: ${e.message}`);
  }
}

// Write permission response for watcher to pick up
function writePermissionResponse(response, promptType) {
  const responseData = {
    timestamp: new Date().toISOString(),
    response: response,
    prompt_type: promptType || 'permission'
  };
  fs.writeFileSync(PERMISSION_RESPONSE_FILE, JSON.stringify(responseData, null, 2));
  log(`Wrote permission response: ${response} (type: ${promptType || 'permission'})`);
}

// Persist the chat the most recent inbound message came from. Hooks and
// the telegram_send tools use this to route replies back to the same
// chat (DM, group, or supergroup topic) instead of always defaulting to
// the configured user's DM.
function writeLastChat(msg) {
  try {
    const data = {
      chat_id: msg.chat.id,
      message_thread_id: msg.message_thread_id ?? null,
      from_user_id: msg.from?.id?.toString() ?? null,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(LAST_CHAT_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log(`Failed to write last-chat: ${e.message}`);
  }
}

function readLastChat() {
  try {
    if (!fs.existsSync(LAST_CHAT_FILE)) return null;
    return JSON.parse(fs.readFileSync(LAST_CHAT_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

// If a send to last-chat returns 403 (bot kicked, blocked, etc.), the
// stored chat is unreachable — clear it so the next reply doesn't keep
// blindly retrying. Only clears when the failed chat_id matches what's
// in last-chat, so caller-supplied overrides don't poison shared state.
function isForbidden(error) {
  if (!error) return false;
  const msg = error.message || '';
  return /403\b|Forbidden|kicked|blocked|deactivated/i.test(msg) ||
    error?.response?.statusCode === 403 ||
    error?.response?.body?.error_code === 403;
}

function clearLastChatIfMatches(chatId) {
  try {
    const last = readLastChat();
    if (last && String(last.chat_id) === String(chatId)) {
      fs.unlinkSync(LAST_CHAT_FILE);
      log(`Cleared stale last-chat (chat_id=${chatId} returned 403)`);
    }
  } catch (e) {
    log(`Failed to clear last-chat: ${e.message}`);
  }
}

// Resolve the target {chat_id, message_thread_id} for an outbound
// message. Caller may pass explicit overrides; otherwise uses the most
// recent inbound chat; otherwise falls back to the configured default
// (first allowlisted userId, treated as a DM target).
function resolveReplyTarget(overrides = {}) {
  if (overrides.chat_id != null) {
    return {
      chat_id: overrides.chat_id,
      message_thread_id: overrides.message_thread_id ?? null,
      source: 'override',
    };
  }
  const last = readLastChat();
  if (last && last.chat_id != null) {
    return {
      chat_id: last.chat_id,
      message_thread_id: last.message_thread_id ?? null,
      source: 'last-chat',
    };
  }
  return {
    chat_id: DEFAULT_CHAT_ID,
    message_thread_id: null,
    source: 'default',
  };
}

// Telegram-API send-options for a target. message_thread_id is omitted
// when null/undefined so non-supergroup chats aren't confused.
function sendOpts(target, extra = {}) {
  const opts = { ...extra };
  if (target.message_thread_id != null) {
    opts.message_thread_id = target.message_thread_id;
  }
  return opts;
}

// Queue incoming messages from Telegram
bot.on('message', async (msg) => {
  debugLog(`message received from=${msg.from?.id} text=${(msg.text || '').slice(0, 60)}`);
  // Only accept messages from allowlisted users
  const fromId = msg.from?.id?.toString();
  if (!fromId || !ALLOWED_USER_IDS.includes(fromId)) {
    log(`Ignored message from unauthorized user: ${fromId}`);
    return;
  }

  // Deduplicate messages (Telegram polling can deliver duplicates)
  if (isMessageProcessed(msg.message_id)) {
    log(`Ignoring duplicate message: ${msg.message_id}`);
    return;
  }
  markMessageProcessed(msg.message_id);

  // Remember this chat for future outbound replies (telegram_send tools
  // and permission/question acks default here when no override given).
  writeLastChat(msg);

  // Per-message reply target — used for acks below so a response in a
  // group chat doesn't get answered in the user's DM.
  const replyTarget = {
    chat_id: msg.chat.id,
    message_thread_id: msg.message_thread_id ?? null,
  };

  const text = msg.text || msg.caption || '';

  // Check if this is a response to a pending prompt
  if (msg.text && hasPendingPermission()) {
    const pending = getPendingPermission();
    const promptType = pending?.prompt_type || 'permission';
    // Reply in the same chat the prompt was sent to, when we know it.
    const ackTarget = pending?.chat_id != null
      ? { chat_id: pending.chat_id, message_thread_id: pending.message_thread_id ?? null }
      : replyTarget;

    // Handle numeric responses for AskUserQuestion
    if (promptType === 'question' && isNumericResponse(text)) {
      const optionNum = parseInt(text.trim(), 10);
      log(`Received question response: option ${optionNum} (type: ${promptType})`);

      // Find option label for confirmation
      const questions = pending?.tool_input?.questions || [];
      const options = questions[0]?.options || [];
      let confirmText;
      if (optionNum > 0 && optionNum <= options.length) {
        confirmText = options[optionNum - 1].label;
      } else if (optionNum === options.length + 1) {
        confirmText = 'Other (custom text)';
      } else {
        confirmText = `Option ${optionNum}`;
      }
      bot.sendMessage(ackTarget.chat_id, `✅ Selected: ${confirmText}`, sendOpts(ackTarget)).catch(() => {});

      writePermissionResponse(optionNum.toString(), 'question');
      clearPendingPermission();
      triggerEnterKey();
      return;
    }

    // Handle standard permission responses (y/n/a)
    if (isPermissionResponse(text)) {
      const response = normalizePermissionResponse(text);
      log(`Received permission response: ${text} -> ${response}`);

      const responseText = response === 'y' ? 'Yes (allow once)' :
                           response === 'n' ? 'No (deny)' :
                           response === 'a' ? 'Always (allow permanently)' : text;
      bot.sendMessage(ackTarget.chat_id, `✅ Permission: ${responseText}`, sendOpts(ackTarget)).catch(() => {});

      writePermissionResponse(response, promptType);
      clearPendingPermission();
      triggerEnterKey();
      return;
    }
  }

  // Check if this is a slash command (;word → /word)
  if (msg.text) {
    const slashMatch = msg.text.trim().match(/^;(\w+)$/);
    if (slashMatch) {
      const command = slashMatch[1];
      log(`Slash command detected: ;${command} → /${command}`);
      fs.writeFileSync(SLASH_COMMAND_FILE, JSON.stringify({
        timestamp: new Date().toISOString(),
        command: command
      }, null, 2));
      bot.sendMessage(replyTarget.chat_id, `Forwarding /${command} to Claude Code...`, sendOpts(replyTarget)).catch(() => {});
      triggerEnterKey();
      return;
    }
  }

  // Skip messages with no text and no photo (stickers, voice, etc.)
  if (!msg.text && !msg.caption && !msg.photo) {
    log(`Ignoring unsupported message type from ${msg.from.first_name || 'User'}`);
    return;
  }

  // Download photo if present
  let imagePath = null;
  if (msg.photo && msg.photo.length > 0) {
    try {
      // Pick highest resolution (last element in the array)
      const photo = msg.photo[msg.photo.length - 1];
      const imagesDir = path.join(SESSION_DIR, 'images');
      if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
      }
      imagePath = await bot.downloadFile(photo.file_id, imagesDir);
      log(`Downloaded image: ${imagePath}`);
    } catch (e) {
      log(`Failed to download image: ${e.message}`);
    }
  }

  // Regular message - queue it
  const messageData = {
    id: msg.message_id,
    timestamp: Date.now(),
    text: text,
    from: msg.from.first_name || msg.from.username || 'User',
    chatId: msg.chat.id,
  };

  if (imagePath) {
    messageData.imagePath = imagePath;
  }

  // Read current queue
  let queue = { messages: [] };
  try {
    const data = fs.readFileSync(QUEUE_FILE, 'utf-8');
    queue = JSON.parse(data);
  } catch (e) {
    // Start fresh if file is corrupted
  }

  // Add message to queue
  queue.messages.push(messageData);

  // Keep only last 50 messages
  if (queue.messages.length > 50) {
    queue.messages = queue.messages.slice(-50);
  }

  // Write updated queue
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  const logText = imagePath ? `[image] ${text.substring(0, 50)}` : text.substring(0, 50);
  log(`Queued message from ${messageData.from}: ${logText}...`);

  // Trigger Enter keystroke to wake up Claude Code
  triggerEnterKey();
});

// Handle polling errors
bot.on('polling_error', (error) => {
  log(`Polling error: ${error.message}`);
  // Surface to startup.log too — Telegram 409s (another consumer polling
  // the same token) are silent in normal use but completely break message
  // reception. Worth seeing this without digging into Codex's logs.
  debugLog(`polling_error: ${error.message}`);
});

log(`Telegram bot listener started`);
log(`Session directory: ${SESSION_DIR}`);
debugLog(`bot listener started session_dir=${SESSION_DIR}`);

// Trigger file for the watcher script
const TRIGGER_FILE = path.join(SESSION_DIR, 'trigger-enter');
const PENDING_PERMISSION_FILE = path.join(SESSION_DIR, 'pending-permission.json');
const PERMISSION_RESPONSE_FILE = path.join(SESSION_DIR, 'permission-response.json');
const SLASH_COMMAND_FILE = path.join(SESSION_DIR, 'slash-command.json');
const LAST_CHAT_FILE = path.join(SESSION_DIR, 'last-chat.json');

// Wake the host agent so it picks up the freshly queued message.
//
// Claude Code: drop a trigger file for the PowerShell watcher, which
// PostMessages WM_CHAR `.` + Enter into the cmd.exe console.
//
// Codex: call turn/start on the local app-server's control socket. The
// placeholder input fires Codex's UserPromptSubmit hook, which injects
// the queued messages as additionalContext. No watcher, no keystrokes.
function triggerEnterKey() {
  // Small delay to ensure the queue write is visible before waking.
  setTimeout(() => {
    if (AGENT === 'codex') {
      debugLog(`wake: starting (agent=codex, url=${process.argv.slice(1).find(a => a.startsWith('--app-server-url=')) || 'default'})`);
      wakeMostRecentThread('.')
        .then((res) => {
          if (res?.ok) {
            log(`Started Codex turn via app-server JSON-RPC (thread=${res.threadId})`);
            debugLog(`wake: success threadId=${res.threadId}`);
          } else {
            log(`Codex wake skipped: ${res?.reason || 'unknown'}`);
            debugLog(`wake: skipped ${JSON.stringify(res)}`);
          }
        })
        .catch((e) => {
          log(`Codex wake error: ${e.message}`);
          debugLog(`wake: error: ${e.stack || e.message}`);
        });
      return;
    }
    try {
      fs.writeFileSync(TRIGGER_FILE, Date.now().toString());
      log('Wrote trigger file for Enter keystroke');
    } catch (e) {
      log(`Failed to write trigger file: ${e.message}`);
    }
  }, 500);
}

// Create MCP server
const server = new Server(
  {
    name: 'telegram-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'telegram_send',
        description: 'Send a text message via Telegram. By default replies to the chat the most recent inbound message came from (DM, group, or supergroup topic). Supply chat_id to override.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message text to send',
            },
            chat_id: {
              type: ['string', 'number'],
              description: 'Optional. Telegram chat id to send to. Defaults to the chat of the most recent inbound message (or, if none, the first allowlisted user as a DM).',
            },
            message_thread_id: {
              type: 'number',
              description: 'Optional. Forum/topic thread id within a supergroup. Only meaningful when chat_id refers to a forum-enabled supergroup.',
            },
          },
          required: ['message'],
        },
      },
      {
        name: 'telegram_send_image',
        description: 'Send an image file via Telegram. Same default-reply-target behavior as telegram_send.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute path to the image file',
            },
            caption: {
              type: 'string',
              description: 'Optional caption for the image',
            },
            chat_id: {
              type: ['string', 'number'],
              description: 'Optional. Telegram chat id to send to. See telegram_send for default behavior.',
            },
            message_thread_id: {
              type: 'number',
              description: 'Optional. Forum/topic thread id within a supergroup.',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'telegram_check_messages',
        description: 'Check for pending messages from Telegram and clear the queue',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'telegram_send': {
      const { message, chat_id, message_thread_id } = args;
      if (!message) {
        return {
          content: [{ type: 'text', text: 'Error: message is required' }],
          isError: true,
        };
      }
      const target = resolveReplyTarget({ chat_id, message_thread_id });
      const targetDesc = `${target.chat_id}${target.message_thread_id != null ? `:${target.message_thread_id}` : ''} (${target.source})`;

      try {
        await bot.sendMessage(target.chat_id, message, sendOpts(target, { parse_mode: 'Markdown' }));
        return {
          content: [{ type: 'text', text: `Message sent to Telegram chat ${targetDesc}` }],
        };
      } catch (error) {
        // Try without markdown if it fails (Markdown can fail on unbalanced characters)
        try {
          await bot.sendMessage(target.chat_id, message, sendOpts(target));
          return {
            content: [{ type: 'text', text: `Message sent to Telegram chat ${targetDesc} (plain text)` }],
          };
        } catch (retryError) {
          if (isForbidden(retryError)) clearLastChatIfMatches(target.chat_id);
          return {
            content: [{ type: 'text', text: `Error sending message to ${targetDesc}: ${retryError.message}` }],
            isError: true,
          };
        }
      }
    }

    case 'telegram_send_image': {
      const { path: imagePath, caption, chat_id, message_thread_id } = args;
      if (!imagePath) {
        return {
          content: [{ type: 'text', text: 'Error: path is required' }],
          isError: true,
        };
      }

      if (!fs.existsSync(imagePath)) {
        return {
          content: [{ type: 'text', text: `Error: File not found: ${imagePath}` }],
          isError: true,
        };
      }

      const target = resolveReplyTarget({ chat_id, message_thread_id });
      const targetDesc = `${target.chat_id}${target.message_thread_id != null ? `:${target.message_thread_id}` : ''} (${target.source})`;

      try {
        await bot.sendPhoto(target.chat_id, imagePath, sendOpts(target, { caption: caption || '' }));
        return {
          content: [{ type: 'text', text: `Image sent to Telegram chat ${targetDesc}` }],
        };
      } catch (error) {
        if (isForbidden(error)) clearLastChatIfMatches(target.chat_id);
        return {
          content: [{ type: 'text', text: `Error sending image to ${targetDesc}: ${error.message}` }],
          isError: true,
        };
      }
    }

    case 'telegram_check_messages': {
      try {
        let queue = { messages: [] };
        if (fs.existsSync(QUEUE_FILE)) {
          const data = fs.readFileSync(QUEUE_FILE, 'utf-8');
          queue = JSON.parse(data);
        }

        const messages = queue.messages || [];

        // Clear the queue
        fs.writeFileSync(QUEUE_FILE, JSON.stringify({ messages: [] }, null, 2));

        if (messages.length === 0) {
          return {
            content: [{ type: 'text', text: 'No pending messages from Telegram' }],
          };
        }

        const formatted = messages
          .map((m) => {
            const time = new Date(m.timestamp).toLocaleTimeString();
            let content = '';
            if (m.imagePath) {
              content += `[Image: ${m.imagePath}]`;
              if (m.text) content += ` ${m.text}`;
            } else {
              content = m.text;
            }
            return `[${time}] ${m.from}: ${content}`;
          })
          .join('\n');

        return {
          content: [{ type: 'text', text: `${messages.length} message(s) from Telegram:\n\n${formatted}` }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error reading messages: ${error.message}` }],
          isError: true,
        };
      }
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server connected via stdio');
  // Note: Watcher is spawned by the UserPromptSubmit hook (telegram-context.js)
  // to ensure correct session directory and PID tracking
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
