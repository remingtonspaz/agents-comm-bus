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

const CLIENT_VERSION = 'claude-hook-phase2';
const DEFAULT_TTL_SECONDS = 10 * 60;

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

function stringifyValue(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function questionOptions(toolInput) {
  const firstQuestion = toolInput?.questions?.[0];
  if (!firstQuestion) return undefined;
  return (firstQuestion.options || []).map((option) => {
    const description = option.description ? ` - ${option.description}` : '';
    return `${option.label}${description}`;
  });
}

function promptText(toolName, toolInput) {
  if (toolName === 'AskUserQuestion') {
    const questions = toolInput?.questions || [];
    return questions.map((question) => {
      const options = (question.options || [])
        .map((option, index) => `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ''}`)
        .join('\n');
      return `${question.question}${options ? `\n${options}` : ''}`;
    }).join('\n\n');
  }
  if (toolName === 'ExitPlanMode') {
    return 'Claude has finished planning and is requesting approval to proceed.';
  }
  if (toolName === 'EnterPlanMode') {
    return 'Claude is requesting approval to enter plan mode.';
  }
  return `Claude requests permission for ${toolName || 'a tool'}.\n${stringifyValue(toolInput || {})}`;
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
  const metadata = {
    shimName: 'hooks/claude/permission-request.js',
    agent: 'claude',
    project: process.cwd(),
    hookEventName: 'PermissionRequest',
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
      hook: 'PermissionRequest',
      claude: hookInput,
    });
    const result = await ipc.request('claude_open_query', {
      agent: 'claude',
      session,
      project: process.cwd(),
      cwd: process.cwd(),
      ttl_seconds: DEFAULT_TTL_SECONDS,
      query: {
        kind: queryKind(toolName),
        prompt_text: promptText(toolName, toolInput),
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
