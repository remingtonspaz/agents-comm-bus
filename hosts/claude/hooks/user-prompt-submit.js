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
import { entryEnsures } from '../../common/install/entry-ensures.js';
import { connectIpc } from '../../../agents-comm-bus/dist/core-daemon/ipc/client.js';
import {
  ensureClaudeWakeWatcher,
  findCmdAncestor,
  resolveClaudeWakeDir,
  resolveProjectPath,
} from './wake-support.js';

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
  const daemon = await entryEnsures({
    fromDir: import.meta.dirname,
    agent: 'claude',
    env: process.env,
    ensureDaemonOptions: { clientVersion: CLIENT_VERSION, metadata },
  });
  return connectIpc({
    port: daemon.port,
    clientVersion: CLIENT_VERSION,
    metadata,
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatAttachmentLine(attachment) {
  const parts = [];
  const mime = attachment.mime && attachment.mime !== 'application/octet-stream' ? attachment.mime : null;
  if (mime) parts.push(mime);
  if (attachment.filename) parts.push(attachment.filename);
  const size = formatBytes(attachment.size);
  if (size) parts.push(size);
  const header = parts.length > 0 ? parts.join(' · ') : 'attachment';

  const meta = attachment.platform_metadata || {};
  if (meta.retrieval_error) {
    return `  📎 ${header} — retrieval failed: ${meta.retrieval_error}`;
  }
  if (attachment.local_path) {
    return `  📎 ${header} → ${attachment.local_path} (use the Read tool to view)`;
  }
  if (attachment.blob_hash) {
    return `  📎 ${header} → blob ${attachment.blob_hash}`;
  }
  if (meta.file_id) {
    return `  📎 ${header} → telegram file_id ${meta.file_id} (not downloaded)`;
  }
  return `  📎 ${header} (no local copy)`;
}

function messageText(message) {
  const text = message?.text ? String(message.text).trim() : '';
  return text || '(no text)';
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
  const blocks = items.map((item) => {
    const { message, conversation, chat } = normalizeInboundItem(item);
    const sender = message?.sender || {};
    const senderName = sender.display_name || sender.id || 'unknown sender';
    const envelope = {
      comm: chat.comm || conversation.comm,
      // `account` is the concrete bot_user_id — the routing key to echo back on
      // sends (AGE-15). Do NOT fall back to account_label here: the label is
      // human metadata, ambiguous across agents, and rejected as a send target.
      account: chat.account,
      account_label: conversation.account_label,
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
    const header = `[${formatTimestamp(message?.received_at)}] ${senderName} (${envelopeText}): ${messageText(message)}`;
    const attachmentLines = (message?.attachments || []).map(formatAttachmentLine);
    return [header, ...attachmentLines].join('\n');
  });

  return `[Daemon Inbound Messages]\n${blocks.join('\n')}\n[End Daemon Inbound Messages]`;
}

async function main() {
  const hookInput = await readStdinJson();
  const session = stableSessionId(hookInput);
  const project = resolveProjectPath();
  const wakeDir = resolveClaudeWakeDir(project);
  ensureClaudeWakeWatcher({
    projectPath: project,
    wakeDir,
    log: (message) => process.stderr.write(`[claude-user-prompt-submit] ${message}\n`),
  });
  // Discover the persistent claude.exe PID via the same process-tree walk the
  // watcher uses. This becomes the session's `owner_process_pid` so the
  // daemon can release the lease (or report ownership) when claude.exe dies
  // — analogous to Codex's MCP-shim-provided pid.
  const cmdInfo = findCmdAncestor();
  const claudePid = cmdInfo?.claudePid;
  const metadata = {
    shimName: 'hosts/claude/hooks/user-prompt-submit.js',
    agent: 'claude',
    project,
    hookEventName: 'UserPromptSubmit',
    session,
  };

  let ipc;
  try {
    ipc = await openDaemonConnection(metadata);
    await ipc.request('claude_register_session', {
      agent: 'claude',
      session,
      project,
      cwd: project,
      wake_dir: wakeDir,
      hook: 'UserPromptSubmit',
      claude: hookInput,
      owner_process_pid: claudePid,
      owner_process_label: 'claude',
    });
    const result = await ipc.request('claude_drain_inbound', {
      agent: 'claude',
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
    process.stderr.write(`Claude UserPromptSubmit daemon hook skipped: ${error.message}\n`);
  } finally {
    ipc?.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Claude UserPromptSubmit hook error: ${error.message}\n`);
  process.exitCode = 1;
});
