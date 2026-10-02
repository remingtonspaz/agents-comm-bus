import { normalizeProjectPath } from '../../agents-comm-bus/dist/core-daemon/project-path.js';
import { claudeWakeDirForProject } from '../../agents-comm-bus/dist/core-daemon/bridges/claude/wake.js';
import { accountLabelScopeFromEnvSafe } from './comm-labels.js';
import { herdrSessionIdFromEnv, herdrWakeFieldsForRegister } from './herdr-env.js';
import { findClaudeOwnerPid } from '../claude/hooks/wake-support.js';
import {
  DAEMON_VERSION,
  ensureMcpRuntime,
  log,
  resolveMcpShimProject,
} from './mcp-shim-shared.js';
import { connectIpc } from '../../agents-comm-bus/dist/core-daemon/ipc/client.js';

let lastWakeStrategy = null;

export function claudeMcpSessionInUse() {
  const herdr = herdrSessionIdFromEnv('claude');
  if (herdr) return herdr;
  if (process.env.AGENTS_COMM_BUS_SESSION_ID) return process.env.AGENTS_COMM_BUS_SESSION_ID;
  return process.env.CLAUDE_SESSION_ID ?? 'mcp';
}

export function claudeMcpLastWakeStrategy() {
  return lastWakeStrategy;
}

export async function registerClaudeMcpSession(options = {}) {
  const project = normalizeProjectPath(options.resolveProject?.() ?? resolveMcpShimProject());
  const session = options.sessionInUse?.() ?? claudeMcpSessionInUse();
  const wakeDir = claudeWakeDirForProject(project, undefined, accountLabelScopeFromEnvSafe());
  const metadata = {
    shimName: options.shimName ?? 'agents-comm-claude-mcp-shim/session-registration',
    agent: 'claude',
    project,
    session,
  };

  const runtime = await ensureMcpRuntime({
    agentInUse: () => 'claude',
    shimName: metadata.shimName,
    fromDir: options.fromDir,
    env: options.env,
  });

  const connection = await connectIpc({
    port: runtime.ensured.port,
    clientVersion: DAEMON_VERSION,
    metadata,
  });

  try {
    const registerResult = await connection.request('claude_register_session', {
      agent: 'claude',
      session,
      project,
      cwd: project,
      wake_dir: wakeDir,
      source: 'mcp-server',
      owner_process_pid: findClaudeOwnerPid(log),
      owner_process_label: 'claude',
      account_label_scope: accountLabelScopeFromEnvSafe(options.env),
      ...herdrWakeFieldsForRegister('claude', project, options.env),
    });
    lastWakeStrategy = registerResult?.wake_strategy ?? null;
    return registerResult;
  } finally {
    connection.close();
  }
}
