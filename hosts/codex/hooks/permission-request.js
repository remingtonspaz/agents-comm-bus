#!/usr/bin/env node
/**
 * Codex PermissionRequest hook.
 *
 * Thin Codex adapter shim: bootstrap agents-comm-bus, register this Codex
 * session, open a daemon-backed approval Query, and emit Codex hook JSON after
 * the daemon resolves it. This hook intentionally does not write legacy
 * pending-permission or permission-response files.
 */

import crypto from 'node:crypto';
import { AGENTS_COMM_BUS_DEGRADED_MESSAGE } from '../../common/hook-degraded.js';
import { entryEnsures } from '../../common/install/entry-ensures.js';
import { connectIpc } from '../../../agents-comm-bus/dist/core-daemon/ipc/client.js';
import { normalizeProjectPath } from '../../../agents-comm-bus/dist/core-daemon/project-path.js';

const CLIENT_VERSION = 'codex-hook-phase3';
const DEFAULT_TTL_SECONDS = 9 * 60;

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
  if (!input.trim()) return null;
  return JSON.parse(input);
}

async function openDaemonConnection(metadata) {
  const daemon = await entryEnsures({
    fromDir: import.meta.dirname,
    agent: 'codex',
    env: process.env,
    ensureDaemonOptions: { clientVersion: CLIENT_VERSION, metadata },
  });
  return connectIpc({
    port: daemon.port,
    clientVersion: CLIENT_VERSION,
    metadata,
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
  } else if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && toolInput?.file_path) {
    details = `File: <code>${escapeHtml(toolInput.file_path)}</code>`;
  } else if (toolInput && typeof toolInput === 'object') {
    const keys = Object.keys(toolInput).slice(0, 3);
    details = keys
      .map((key) => `${escapeHtml(key)}: ${escapeHtml(JSON.stringify(toolInput[key]).slice(0, 80))}`)
      .join('\n');
  }
  let message = `\u{1F510} <b>Codex Permission Request</b>\n`;
  message += `\n<b>Tool:</b> ${escapeHtml(toolName)}`;
  if (details) message += `\n${details}`;
  message += `\n\nReply: <b>y</b> (yes) / <b>n</b> (no) / <b>a</b> (allow once in Codex)`;
  return message;
}

function failClosed(message) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message,
      },
    },
  };
}

function extractHookJson(result) {
  if (result?.nativeHookJson) return result.nativeHookJson;
  if (result?.hookJson) return result.hookJson;
  if (result?.hook_response) return result.hook_response;
  return result;
}

async function main() {
  let hookInput;
  try {
    hookInput = await readStdinJson();
  } catch {
    console.log(JSON.stringify(failClosed('Could not parse Codex permission hook input')));
    return;
  }

  if (!hookInput) {
    console.log(JSON.stringify(failClosed('Missing Codex permission hook input')));
    return;
  }

  const toolName = hookInput.tool_name || hookInput.toolName || 'PermissionRequest';
  const toolInput = hookInput.tool_input || hookInput.toolInput || {};
  const session = stableSessionId(hookInput);
  const project = normalizeProjectPath(process.cwd());
  const metadata = {
    shimName: 'hosts/codex/hooks/permission-request.js',
    agent: 'codex',
    project,
    hookEventName: 'PermissionRequest',
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
      hook: 'PermissionRequest',
      codex: hookInput,
    });
    if (!registered?.ok) {
      throw new Error(registered?.reason || 'codex session registration failed');
    }
    const result = await ipc.request('codex_open_query', {
      agent: 'codex',
      session,
      project,
      cwd: project,
      ttl_seconds: DEFAULT_TTL_SECONDS,
      query: {
        kind: 'approval',
        prompt_text: formatToolPermission(toolName, toolInput),
        prompt_format: 'html',
      },
      codex: {
        tool_name: toolName,
        tool_input: toolInput,
        hook_input: hookInput,
      },
    });
    console.log(JSON.stringify(extractHookJson(result)));
  } catch (error) {
    process.stderr.write(`Codex PermissionRequest daemon hook failed closed: ${error.message}\n`);
    console.log(JSON.stringify({
      systemMessage: AGENTS_COMM_BUS_DEGRADED_MESSAGE,
      ...failClosed(error.message),
    }));
  } finally {
    ipc?.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Codex PermissionRequest hook error: ${error.message}\n`);
  console.log(JSON.stringify(failClosed(error.message)));
});
