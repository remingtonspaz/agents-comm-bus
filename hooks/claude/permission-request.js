#!/usr/bin/env node
/**
 * Claude Code PermissionRequest hook.
 *
 * Thin Claude adapter shim: bootstrap agents-comm-bus, register this Claude
 * session, open a daemon-backed Query, and translate the resolved decision
 * back into Claude hook JSON. This hook intentionally does not write legacy
 * pending permission files.
 */

import crypto from 'node:crypto';
import { ensureDaemon } from '../../agents-comm-bus/dist/bootstrap/ensure-daemon.js';
import { connectIpc } from '../../agents-comm-bus/dist/ipc/client.js';
import {
  ensureClaudeWakeWatcher,
  resolveClaudeWakeDir,
  resolveProjectPath,
} from './wake-support.js';

const CLIENT_VERSION = 'claude-hook-phase2';
const DEFAULT_TTL_SECONDS = 60 * 60;

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
  if (!input.trim()) return null;
  return JSON.parse(input);
}

async function openDaemonConnection(metadata) {
  const daemon = await ensureDaemon({ clientVersion: CLIENT_VERSION, metadata });
  return connectIpc({
    port: daemon.port,
    clientVersion: CLIENT_VERSION,
    metadata,
  });
}

function escapeHtml(text) {
  if (typeof text !== 'string') return String(text);
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function questionOptions(toolInput) {
  const firstQuestion = toolInput?.questions?.[0];
  if (!firstQuestion) return undefined;
  return (firstQuestion.options || []).map((option) => {
    const description = option.description ? ` - ${option.description}` : '';
    return `${option.label}${description}`;
  });
}

function formatAskUserQuestion(toolInput) {
  const questions = toolInput?.questions || [];
  if (questions.length === 0) return null;

  let message = `❓ <b>Claude has a question</b>\n`;
  for (const q of questions) {
    message += `\n<b>${escapeHtml(q.question)}</b>\n`;
    const options = q.options || [];
    for (let i = 0; i < options.length; i += 1) {
      const opt = options[i];
      message += `\n<b>${i + 1}.</b> ${escapeHtml(opt.label)}`;
      if (opt.description) {
        message += `\n    <i>${escapeHtml(opt.description)}</i>`;
      }
    }
    message += `\n<b>${options.length + 1}.</b> Other (custom text)`;
    if (q.multiSelect) {
      message += `\n\n<i>(Multi-select: reply with comma-separated numbers)</i>`;
    }
  }
  message += `\n\nReply with <b>number</b> to select, or <b>y</b> to approve`;
  return message;
}

function formatExitPlanMode() {
  let message = `\u{1F4CB} <b>Plan Ready for Review</b>\n`;
  message += `\nClaude has finished planning and wants your approval to proceed.`;
  message += `\n\nReply: <b>y</b> (approve) / <b>n</b> (reject)`;
  return message;
}

function formatEnterPlanMode() {
  let message = `\u{1F4DD} <b>Enter Plan Mode?</b>\n`;
  message += `\nClaude wants to switch to planning mode to design an approach before implementing.`;
  message += `\n\nReply: <b>y</b> (approve) / <b>n</b> (reject)`;
  return message;
}

function formatToolPermission(toolName, toolInput) {
  let details = '';

  if (toolName === 'Bash' && toolInput?.command) {
    details = `<code>${escapeHtml(toolInput.command)}</code>`;
  } else if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && toolInput?.file_path) {
    details = `File: <code>${escapeHtml(toolInput.file_path)}</code>`;
  } else if (toolInput) {
    const keys = Object.keys(toolInput).slice(0, 3);
    details = keys
      .map((k) => `${escapeHtml(k)}: ${escapeHtml(JSON.stringify(toolInput[k]).slice(0, 80))}`)
      .join('\n');
  }

  let message = `\u{1F510} <b>Permission Request</b>\n`;
  message += `\n<b>Tool:</b> ${escapeHtml(toolName)}`;
  if (details) message += `\n${details}`;
  message += `\n\nReply: <b>y</b> (yes) / <b>n</b> (no) / <b>a</b> (always)`;
  return message;
}

function promptText(toolName, toolInput) {
  if (toolName === 'AskUserQuestion') {
    return formatAskUserQuestion(toolInput) || formatToolPermission(toolName, toolInput);
  }
  if (toolName === 'ExitPlanMode') return formatExitPlanMode(toolInput);
  if (toolName === 'EnterPlanMode') return formatEnterPlanMode(toolInput);
  return formatToolPermission(toolName, toolInput);
}

function queryKind(toolName) {
  if (toolName === 'AskUserQuestion') return 'choice';
  return 'approval';
}

function promptType(toolName) {
  if (toolName === 'AskUserQuestion') return 'question';
  if (toolName === 'ExitPlanMode') return 'plan_approval';
  if (toolName === 'EnterPlanMode') return 'plan_entry';
  return 'permission';
}

function failClosed(toolName) {
  if (toolName === 'AskUserQuestion') return { decision: { behavior: 'deny' } };
  return { decision: { behavior: 'ask' } };
}

function extractResolution(result) {
  if (!result) return null;
  if (result.nativeHookJson) return { nativeHookJson: result.nativeHookJson };
  if (result.hookJson) return { nativeHookJson: result.hookJson };
  return result.resolution || result.decision || result;
}

function translateDecision(result, toolName) {
  const resolution = extractResolution(result);
  if (!resolution) return failClosed(toolName);
  if (resolution.nativeHookJson) return resolution.nativeHookJson;

  const decision = typeof resolution === 'string' ? resolution : resolution.decision || resolution.behavior;
  switch (decision) {
    case 'allow':
      return { decision: { behavior: 'allow' } };
    case 'always_allow':
      return { decision: { behavior: 'allow' } };
    case 'deny':
      return { decision: { behavior: 'deny' } };
    case 'select_option':
      return {
        decision: { behavior: 'allow' },
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          selectedOptionIndex: resolution.selected_option_index,
        },
      };
    case 'text':
      return {
        decision: { behavior: 'allow' },
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          text: resolution.text,
        },
      };
    default:
      return failClosed(toolName);
  }
}

async function main() {
  let hookInput;
  try {
    hookInput = await readStdinJson();
  } catch {
    console.log(JSON.stringify({ decision: { behavior: 'ask' } }));
    return;
  }

  if (!hookInput) {
    console.log(JSON.stringify({ decision: { behavior: 'ask' } }));
    return;
  }

  const toolName = hookInput.tool_name || hookInput.toolName || 'PermissionRequest';
  const toolInput = hookInput.tool_input || hookInput.toolInput || {};
  const session = stableSessionId(hookInput);
  const project = resolveProjectPath();
  const wakeDir = resolveClaudeWakeDir(project);
  ensureClaudeWakeWatcher({
    projectPath: project,
    wakeDir,
    log: (message) => process.stderr.write(`[claude-permission-request] ${message}\n`),
  });
  const metadata = {
    shimName: 'hooks/claude/permission-request.js',
    agent: 'claude',
    project,
    hookEventName: 'PermissionRequest',
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
      hook: 'PermissionRequest',
      claude: hookInput,
    });
    const result = await ipc.request('claude_open_query', {
      agent: 'claude',
      session,
      project,
      cwd: project,
      ttl_seconds: DEFAULT_TTL_SECONDS,
      query: {
        kind: queryKind(toolName),
        prompt_text: promptText(toolName, toolInput),
        prompt_format: 'html',
        options: questionOptions(toolInput),
        prompt_type: promptType(toolName),
      },
      claude: {
        tool_name: toolName,
        tool_input: toolInput,
        hook_input: hookInput,
      },
    });
    console.log(JSON.stringify(translateDecision(result, toolName)));
  } catch (error) {
    process.stderr.write(`Claude PermissionRequest daemon hook fell back: ${error.message}\n`);
    console.log(JSON.stringify(failClosed(toolName)));
  } finally {
    ipc?.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Claude PermissionRequest hook error: ${error.message}\n`);
  console.log(JSON.stringify({ decision: { behavior: 'ask' } }));
});
