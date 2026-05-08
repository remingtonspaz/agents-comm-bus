#!/usr/bin/env node
/**
 * PermissionRequest Hook - Forwards permission requests to Telegram
 *
 * Detects different prompt types and formats them appropriately:
 * - AskUserQuestion: Shows the question with numbered options
 * - ExitPlanMode: Shows plan approval prompt
 * - EnterPlanMode: Shows plan mode entry prompt
 * - Regular tools: Shows permission request with y/n/a
 *
 * The user can then reply on Telegram, which triggers the watcher
 * to send the appropriate keystroke.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Generate session-specific directory based on project path
function getSessionDir(cwd) {
    const basename = path.basename(cwd).replace(/[^a-zA-Z0-9-_]/g, '_');
    const hash = crypto.createHash('md5').update(cwd).digest('hex').substring(0, 6);
    return path.join(os.homedir(), '.claude-telegram', `${basename}-${hash}`);
}

const SESSION_DIR = getSessionDir(process.cwd());
const PENDING_PERMISSION_PATH = path.join(SESSION_DIR, 'pending-permission.json');
const LAST_CHAT_PATH = path.join(SESSION_DIR, 'last-chat.json');

// Normalize a userId field to an array of strings. Accepts a scalar
// (string/number, the legacy form) or an array of either.
function normalizeUserIds(raw) {
    if (raw == null) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr
        .map(v => (v == null ? '' : v.toString().trim()))
        .filter(v => v.length > 0);
}

// Read Telegram credentials from multiple sources. Returns
// { botToken, userIds: string[] } — userIds is the allowlist; first
// entry doubles as the proactive-send default.
function getCredentials() {
    // 1. Try project-specific config first
    try {
        const configPath = path.join(process.cwd(), '.claude', 'telegram.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const userIds = normalizeUserIds(config.userId);
            if (config.botToken && userIds.length > 0) {
                return { botToken: config.botToken, userIds };
            }
        }
    } catch (err) {}

    // 2. Try environment variables (TELEGRAM_USER_ID may be comma-separated)
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const envIds = (process.env.TELEGRAM_USER_ID || '').split(',').map(s => s.trim()).filter(Boolean);
    if (botToken && envIds.length > 0) return { botToken, userIds: envIds };

    // 3. Fallback: .mcp.json
    try {
        const projectDir = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..');
        const mcpConfigPath = path.join(projectDir, '.mcp.json');
        const config = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
        const mcpToken = config.mcpServers?.telegram?.env?.TELEGRAM_BOT_TOKEN;
        const mcpIds = normalizeUserIds(config.mcpServers?.telegram?.env?.TELEGRAM_USER_ID);
        if (mcpToken && mcpIds.length > 0) {
            return { botToken: mcpToken, userIds: mcpIds };
        }
    } catch (err) {}
    return null;
}

// Read the most recent inbound chat the bot saw, if any. The MCP server
// writes this on every accepted message so hooks can route prompts back
// to the same chat (DM, group, or supergroup topic) instead of always
// dropping into the configured user's DM.
function readLastChat() {
    try {
        if (!fs.existsSync(LAST_CHAT_PATH)) return null;
        return JSON.parse(fs.readFileSync(LAST_CHAT_PATH, 'utf8'));
    } catch {
        return null;
    }
}

// Send message via Telegram Bot API. message_thread_id is omitted when
// null/undefined so non-supergroup chats aren't confused.
function sendTelegram(botToken, chatId, message, messageThreadId) {
    return new Promise((resolve, reject) => {
        const payload = {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        };
        if (messageThreadId != null) payload.message_thread_id = messageThreadId;
        const data = JSON.stringify(payload);

        const options = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${botToken}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body));
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// Escape HTML special characters for Telegram
function escapeHtml(text) {
    if (typeof text !== 'string') return String(text);
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Format AskUserQuestion prompt
function formatAskUserQuestion(toolInput) {
    const questions = toolInput?.questions || [];
    if (questions.length === 0) return null;

    let message = `\u2753 <b>Claude has a question</b>\n`;

    for (const q of questions) {
        message += `\n<b>${escapeHtml(q.question)}</b>\n`;

        const options = q.options || [];
        for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            message += `\n<b>${i + 1}.</b> ${escapeHtml(opt.label)}`;
            if (opt.description) {
                message += `\n    <i>${escapeHtml(opt.description)}</i>`;
            }
        }
        // "Other" is always available
        message += `\n<b>${options.length + 1}.</b> Other (custom text)`;

        if (q.multiSelect) {
            message += `\n\n<i>(Multi-select: reply with comma-separated numbers)</i>`;
        }
    }

    message += `\n\nReply with <b>number</b> to select, or <b>y</b> to approve`;
    return message;
}

// Format ExitPlanMode prompt
function formatExitPlanMode(toolInput) {
    let message = `\u{1F4CB} <b>Plan Ready for Review</b>\n`;
    message += `\nClaude has finished planning and wants your approval to proceed.`;
    message += `\n\nReply: <b>y</b> (approve) / <b>n</b> (reject)`;
    return message;
}

// Format EnterPlanMode prompt
function formatEnterPlanMode(toolInput) {
    let message = `\u{1F4DD} <b>Enter Plan Mode?</b>\n`;
    message += `\nClaude wants to switch to planning mode to design an approach before implementing.`;
    message += `\n\nReply: <b>y</b> (approve) / <b>n</b> (reject)`;
    return message;
}

// Format regular tool permission request
function formatToolPermission(toolName, toolInput) {
    let details = '';

    if (toolName === 'Bash' && toolInput?.command) {
        details = `<code>${escapeHtml(toolInput.command)}</code>`;
    } else if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && toolInput?.file_path) {
        details = `File: <code>${escapeHtml(toolInput.file_path)}</code>`;
    } else if (toolInput) {
        const keys = Object.keys(toolInput).slice(0, 3);
        details = keys.map(k => `${escapeHtml(k)}: ${escapeHtml(JSON.stringify(toolInput[k]).slice(0, 80))}`).join('\n');
    }

    let message = `\u{1F510} <b>Permission Request</b>\n`;
    message += `\n<b>Tool:</b> ${escapeHtml(toolName)}`;
    if (details) message += `\n${details}`;
    message += `\n\nReply: <b>y</b> (yes) / <b>n</b> (no) / <b>a</b> (always)`;
    return message;
}

// Detect prompt type and format message accordingly
function formatMessage(toolName, toolInput) {
    switch (toolName) {
        case 'AskUserQuestion':
            return formatAskUserQuestion(toolInput) || formatToolPermission(toolName, toolInput);
        case 'ExitPlanMode':
            return formatExitPlanMode(toolInput);
        case 'EnterPlanMode':
            return formatEnterPlanMode(toolInput);
        default:
            return formatToolPermission(toolName, toolInput);
    }
}

async function main() {
    let input = '';
    for await (const chunk of process.stdin) {
        input += chunk;
    }

    let hookInput;
    try {
        hookInput = JSON.parse(input);
    } catch (err) {
        console.log(JSON.stringify({ decision: { behavior: 'ask' } }));
        return;
    }

    const { tool_name, tool_input } = hookInput;

    const creds = getCredentials();
    if (!creds || !creds.botToken || creds.userIds.length === 0) {
        console.log(JSON.stringify({ decision: { behavior: 'ask' } }));
        return;
    }

    if (!fs.existsSync(SESSION_DIR)) {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
    }

    // Resolve where to send the prompt: most recent inbound chat if we
    // know one, else the first allowlisted userId as a DM.
    const lastChat = readLastChat();
    const targetChatId = lastChat?.chat_id ?? creds.userIds[0];
    const targetThreadId = lastChat?.message_thread_id ?? null;

    // Write pending info — include chat context so the MCP server's
    // y/n/a-handler can ack in the same chat the prompt landed in.
    const pendingInfo = {
        timestamp: new Date().toISOString(),
        tool_name,
        tool_input,
        prompt_type: tool_name === 'AskUserQuestion' ? 'question'
            : tool_name === 'ExitPlanMode' ? 'plan_approval'
            : tool_name === 'EnterPlanMode' ? 'plan_entry'
            : 'permission',
        chat_id: targetChatId,
        message_thread_id: targetThreadId,
    };
    fs.writeFileSync(PENDING_PERMISSION_PATH, JSON.stringify(pendingInfo, null, 2));

    const message = formatMessage(tool_name, tool_input);

    try {
        await sendTelegram(creds.botToken, targetChatId, message, targetThreadId);
    } catch (err) {
        // Failed to send, don't block
    }

    // Auto-approve AskUserQuestion so the question UI appears immediately
    // The user will select their option via Telegram (watcher sends number key)
    if (tool_name === 'AskUserQuestion') {
        console.log(JSON.stringify({ decision: { behavior: 'allow' } }));
    } else {
        console.log(JSON.stringify({ decision: { behavior: 'ask' } }));
    }
}

main().catch(() => {
    console.log(JSON.stringify({ decision: { behavior: 'ask' } }));
});
