#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SUPPORTED_AGENTS,
  appendPluginLog,
  execFileAsync,
  identityFromPaneEnv,
  parsePluginEventJson,
  projectFromCwd,
  resolveCliEntry,
} from './plugin-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function logAction(kind, detail) {
  appendPluginLog(process.env.HERDR_PLUGIN_STATE_DIR, {
    ts: Date.now(),
    kind,
    ...detail,
  });
}

async function runHerdrAgentList(binPath) {
  const bin = binPath || process.env.HERDR_BIN_PATH || 'herdr';
  const { stdout } = await execFileAsync(execFile, bin, ['agent', 'list'], {
    env: process.env,
    windowsHide: true,
    timeout: 5000,
  });
  try {
    const parsed = JSON.parse(stdout);
    const agents = parsed?.result?.agents ?? parsed?.agents ?? [];
    return Array.isArray(agents) ? agents : [];
  } catch {
    return [];
  }
}

async function runHerdrAgentGet(binPath, paneId) {
  const bin = binPath || process.env.HERDR_BIN_PATH || 'herdr';
  const { stdout } = await execFileAsync(execFile, bin, ['agent', 'get', paneId], {
    env: process.env,
    windowsHide: true,
    timeout: 5000,
  });
  return JSON.parse(stdout);
}

function agentKindFromListEntry(entry) {
  const agent = entry?.agent ?? entry?.kind;
  return typeof agent === 'string' ? agent : null;
}

function agentKindFromGetResult(result) {
  const agent = result?.result?.agent?.agent ?? result?.agent?.agent;
  return typeof agent === 'string' ? agent : null;
}

function cwdFromEvent(event) {
  const cwd = event?.cwd ?? event?.pane?.cwd ?? event?.agent?.cwd;
  return typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd.trim()) : projectFromCwd(process.cwd());
}

async function syncAgent(agent, project, identity, wakeStrict) {
  const { entry, source } = resolveCliEntry(project);
  const args = [
    entry,
    'herdr-pane-sync',
    '--project',
    project,
    '--agent',
    agent,
    '--identity-json',
    JSON.stringify(identity),
  ];
  if (wakeStrict === 'herdr') {
    args.push('--wake-strict', 'herdr');
  }
  await execFileAsync(execFile, process.execPath, args, {
    cwd: project,
    env: process.env,
    windowsHide: true,
    timeout: 30_000,
  });
  logAction('sync', { agent, project, cli: entry, cli_source: source, pane_id: identity.pane_id });
}

async function releaseIdentity(identity) {
  const project = projectFromCwd(process.cwd());
  const { entry, source } = resolveCliEntry(project);
  await execFileAsync(execFile, process.execPath, [
    entry,
    'herdr-pane-release',
    '--identity-json',
    JSON.stringify(identity),
  ], {
    cwd: project,
    env: process.env,
    windowsHide: true,
    timeout: 30_000,
  });
  logAction('release', { agent: identity.agent, cli: entry, cli_source: source, pane_id: identity.pane_id });
}

async function syncFromPane(agent, paneId, project, binPath) {
  const identity = identityFromPaneEnv(agent);
  if (!identity) {
    const built = {
      type: 'herdr',
      agent,
      pane_id: paneId,
      socket_path: process.env.HERDR_SOCKET_PATH,
    };
    if (typeof process.env.HERDR_BIN_PATH === 'string') built.bin_path = process.env.HERDR_BIN_PATH;
    await syncAgent(agent, project, built, null);
    return;
  }
  await syncAgent(agent, project, identity, null);
}

async function handleStartup() {
  const bin = process.env.HERDR_BIN_PATH;
  const agents = await runHerdrAgentList(bin);
  for (const entry of agents) {
    const kind = agentKindFromListEntry(entry);
    if (!kind || !SUPPORTED_AGENTS.includes(kind)) continue;
    const paneId = entry.pane_id ?? entry.paneId;
    const cwd = entry.cwd ? path.resolve(entry.cwd) : projectFromCwd(process.cwd());
    if (!paneId) continue;
    try {
      await syncFromPane(kind, paneId, cwd, bin);
    } catch (error) {
      logAction('sync_error', { agent: kind, pane_id: paneId, message: error.message });
    }
  }
}

async function handleAgentDetected() {
  const event = parsePluginEventJson(process.env.HERDR_PLUGIN_EVENT_JSON);
  const paneId =
    event?.pane_id ??
    event?.paneId ??
    event?.pane?.pane_id ??
    process.env.HERDR_PANE_ID;
  if (!paneId) {
    logAction('agent_detected_skip', { reason: 'missing_pane_id' });
    return;
  }

  let agent =
    event?.agent ??
    event?.pane?.agent ??
    event?.agent_kind;
  let project = cwdFromEvent(event);

  if (!agent || !project) {
    try {
      const got = await runHerdrAgentGet(process.env.HERDR_BIN_PATH, paneId);
      agent = agent ?? agentKindFromGetResult(got);
      const cwd = got?.result?.agent?.cwd ?? got?.agent?.cwd;
      if (cwd) project = path.resolve(cwd);
    } catch (error) {
      logAction('agent_detected_skip', { reason: 'agent_get_failed', message: error.message });
      return;
    }
  }

  if (!agent || !SUPPORTED_AGENTS.includes(agent)) {
    logAction('agent_detected_skip', { reason: 'unsupported_agent', agent });
    return;
  }

  try {
    await syncFromPane(agent, paneId, project, process.env.HERDR_BIN_PATH);
  } catch (error) {
    logAction('sync_error', { agent, pane_id: paneId, message: error.message });
  }
}

async function handlePaneClosed() {
  const paneId =
    parsePluginEventJson(process.env.HERDR_PLUGIN_EVENT_JSON)?.pane_id ??
    process.env.HERDR_PANE_ID;
  if (!paneId || typeof process.env.HERDR_SOCKET_PATH !== 'string') {
    logAction('pane_closed_skip', { reason: 'missing_identity_fields' });
    return;
  }
  for (const agent of SUPPORTED_AGENTS) {
    const identity = {
      type: 'herdr',
      agent,
      pane_id: paneId,
      socket_path: process.env.HERDR_SOCKET_PATH,
    };
    try {
      await releaseIdentity(identity);
    } catch (error) {
      logAction('release_error', { agent, pane_id: paneId, message: error.message });
    }
  }
}

async function main() {
  const command = process.argv[2] || 'startup';
  try {
    if (command === 'startup') await handleStartup();
    else if (command === 'agent-detected') await handleAgentDetected();
    else if (command === 'pane-closed') await handlePaneClosed();
    else logAction('unknown_command', { command });
  } catch (error) {
    logAction('fatal', { command, message: error.message });
  }
  process.exit(0);
}

main();
