#!/usr/bin/env node
/**
 * Codex UserPromptSubmit hook.
 *
 * Thin Codex adapter shim: bootstrap agents-comm-bus, register this Codex
 * session, drain daemon-delivered inbound messages, and inject them as prompt
 * context. This hook intentionally does not read legacy per-session queue
 * files.
 */

import crypto from 'node:crypto';
import { ensureDaemon } from '../../agents-comm-bus/dist/bootstrap/ensure-daemon.js';
import { connectIpc } from '../../agents-comm-bus/dist/ipc/client.js';

const CLIENT_VERSION = 'codex-hook-phase3';

function stableSessionId(hookInput) {
  if (process.env.AGENTS_COMM_BUS_SESSION_ID) {
    return process.env.AGENTS_COMM_BUS_SESSION_ID;
  }
  const raw =
    hookInput?.session_id ||
    hookInput?.sessionId ||
    process.env.CODEX_SESSION_ID ||
    process.env.CODEX_THREAD_ID ||
    `${process.cwd()}:${process.env.CODEX_APP_SERVER_URL || ''}`;
  return `codex_${crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 24)}`;
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
  const project = process.cwd();
  const metadata = {
    shimName: 'hooks/codex/user-prompt-submit.js',
    agent: 'codex',
    project,
    hookEventName: 'UserPromptSubmit',
    session,
  };

  let ipc;
  try {
    ipc = await openDaemonConnection(metadata);
    const registered = await ipc.request('codex_register_session', {
      agent: 'codex',
      session,
      project,
      cwd: project,
      app_server_url: process.env.CODEX_APP_SERVER_URL,
      hook: 'UserPromptSubmit',
      codex: hookInput,
    });
    if (!registered?.ok) {
      throw new Error(registered?.reason || 'codex session registration failed');
    }
    const result = await ipc.request('codex_drain_inbound', {
      agent: 'codex',
      session,
      project,
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
    process.stderr.write(`Codex UserPromptSubmit daemon hook skipped: ${error.message}\n`);
  } finally {
    ipc?.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Codex UserPromptSubmit hook error: ${error.message}\n`);
  process.exitCode = 1;
});
