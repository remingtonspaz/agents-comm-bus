#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook.
 *
 * Thin Claude adapter shim: bootstrap agents-comm-bus, register this Claude
 * session, drain daemon-delivered inbound messages, and inject them as prompt
 * context. This hook intentionally does not read legacy per-session queue
 * files.
 */

import crypto from 'node:crypto';
import { ensureDaemon } from '../../agents-comm-bus/dist/bootstrap/ensure-daemon.js';
import { connectIpc } from '../../agents-comm-bus/dist/ipc/client.js';

const CLIENT_VERSION = 'claude-hook-phase2';

function stableSessionId(hookInput) {
  const raw =
    hookInput?.session_id ||
    hookInput?.sessionId ||
    process.env.CLAUDE_SESSION_ID ||
    `${process.cwd()}:${process.env.CLAUDE_PROJECT_DIR || ''}`;
  return `claude_${crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 24)}`;
}

async function readStdinJson() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

async function openDaemonConnection(metadata) {
  const daemon = await ensureDaemon({ clientVersion: CLIENT_VERSION, metadata });
  return connectIpc({
    port: daemon.port,
    clientVersion: CLIENT_VERSION,
    metadata,
  });
}

function messageText(message) {
  const parts = [];
  if (message?.text) parts.push(String(message.text));
  for (const attachment of message?.attachments || []) {
    const label = attachment.local_path || attachment.filename || attachment.blob_hash || 'attachment';
    parts.push(`[Attachment: ${label}]`);
  }
  return parts.join(' ').trim();
}

function formatTimestamp(value) {
  const date = new Date(typeof value === 'number' ? value : Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeInboundItem(item) {
  const message = item?.message || item;
  const conversation = item?.conversation || {};
  const chat = message?.chat || item?.chat || {};
  return { message, conversation, chat };
}

function formatInboundMessages(items) {
  const lines = items.map((item) => {
    const { message, conversation, chat } = normalizeInboundItem(item);
    const sender = message?.sender || {};
    const senderName = sender.display_name || sender.id || 'unknown sender';
    const envelope = {
      comm: chat.comm || conversation.comm,
      account: chat.account || conversation.account_label,
      chat_native_id: chat.chat_native_id || conversation.chat_native_id,
      thread_native_id: chat.thread_native_id || conversation.thread_native_id || undefined,
      conversation_id: conversation.conversation_id,
      platform_message_id: message?.platform_message_id,
      message_id: message?.message_id,
    };
    const envelopeText = Object.entries(envelope)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    return `[${formatTimestamp(message?.received_at)}] ${senderName} (${envelopeText}): ${messageText(message)}`;
  });

  return `[Daemon Inbound Messages]\n${lines.join('\n')}\n[End Daemon Inbound Messages]`;
}

async function main() {
  const hookInput = await readStdinJson();
  const session = stableSessionId(hookInput);
  const metadata = {
    shimName: 'hooks/claude/user-prompt-submit.js',
    agent: 'claude',
    project: process.cwd(),
    hookEventName: 'UserPromptSubmit',
    session,
  };

  let ipc;
  try {
    ipc = await openDaemonConnection(metadata);
    await ipc.request('claude_register_session', {
      agent: 'claude',
      session,
      project: process.cwd(),
      cwd: process.cwd(),
      hook: 'UserPromptSubmit',
      claude: hookInput,
    });
    const result = await ipc.request('claude_drain_inbound', {
      agent: 'claude',
      session,
      project: process.cwd(),
      limit: 100,
    });
    const messages = Array.isArray(result) ? result : Array.isArray(result?.messages) ? result.messages : [];
    if (messages.length > 0) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: formatInboundMessages(messages),
        },
      }));
    }
  } catch (error) {
    process.stderr.write(`Claude UserPromptSubmit daemon hook skipped: ${error.message}\n`);
  } finally {
    ipc?.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Claude UserPromptSubmit hook error: ${error.message}\n`);
  process.exitCode = 1;
});
