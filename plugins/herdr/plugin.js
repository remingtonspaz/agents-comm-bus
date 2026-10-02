#!/usr/bin/env node
import { execFile } from 'node:child_process';

import {
  SUPPORTED_AGENTS,
  CENTRAL_CLI,
  appendPluginLog,
  agentKindFromGetResult,
  agentKindFromListEntry,
  buildSyncIdentity,
  cwdFromAgentGetResult,
  execFileAsync,
  extractAgentKind,
  parsePluginEventJson,
  resolveCliEntry,
  resolveProjectForPane,
  wakeStrictForProject,
} from './plugin-lib.js';

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

async function releaseIdentity(identity, projectCwd) {
  const { entry, source } = projectCwd
    ? resolveCliEntry(projectCwd)
    : { entry: CENTRAL_CLI, source: 'central' };
  await execFileAsync(execFile, process.execPath, [
    entry,
    'herdr-pane-release',
    '--identity-json',
    JSON.stringify(identity),
  ], {
    cwd: projectCwd ?? undefined,
    env: process.env,
    windowsHide: true,
    timeout: 30_000,
  });
  logAction('release', { agent: identity.agent, cli: entry, cli_source: source, pane_id: identity.pane_id });
}

async function syncFromPane(agent, paneId, project, listOrEventEntry) {
  const identity = buildSyncIdentity(agent, paneId, process.env, listOrEventEntry ?? {});
  if (!identity) {
    logAction('sync_skip', { reason: 'missing_socket_path', agent, pane_id: paneId });
    return;
  }
  const wakeStrict = wakeStrictForProject(project);
  await syncAgent(agent, project, identity, wakeStrict);
}

async function handleStartup() {
  const bin = process.env.HERDR_BIN_PATH;
  const agentGet = (paneId) => runHerdrAgentGet(bin, paneId);
  const agents = await runHerdrAgentList(bin);
  for (const entry of agents) {
    const kind = agentKindFromListEntry(entry);
    if (!kind || !SUPPORTED_AGENTS.includes(kind)) continue;
    const paneId = entry.pane_id ?? entry.paneId;
    if (!paneId) continue;

    const project = await resolveProjectForPane({ listEntry: entry, paneId, agentGet });
    if (!project) {
      logAction('startup_skip', { reason: 'missing_project_cwd', agent: kind, pane_id: paneId });
      continue;
    }

    try {
      await syncFromPane(kind, paneId, project, entry);
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

  const bin = process.env.HERDR_BIN_PATH;
  const agentGet = (id) => runHerdrAgentGet(bin, id);

  let agent =
    extractAgentKind(event?.agent) ??
    extractAgentKind(event?.pane?.agent) ??
    extractAgentKind(event?.agent_kind);

  if (!agent) {
    try {
      const got = await agentGet(paneId);
      agent = agentKindFromGetResult(got);
    } catch (error) {
      logAction('agent_detected_skip', { reason: 'agent_get_failed', message: error.message });
      return;
    }
  }

  if (!agent || !SUPPORTED_AGENTS.includes(agent)) {
    logAction('agent_detected_skip', { reason: 'unsupported_agent', agent });
    return;
  }

  const project = await resolveProjectForPane({ event, paneId, agentGet });
  if (!project) {
    logAction('agent_detected_skip', { reason: 'missing_project_cwd', agent, pane_id: paneId });
    return;
  }

  try {
    await syncFromPane(agent, paneId, project, event?.pane ?? event ?? {});
  } catch (error) {
    logAction('sync_error', { agent, pane_id: paneId, message: error.message });
  }
}

async function handlePaneClosed() {
  const event = parsePluginEventJson(process.env.HERDR_PLUGIN_EVENT_JSON);
  const paneId =
    event?.pane_id ??
    event?.paneId ??
    process.env.HERDR_PANE_ID;
  if (!paneId || typeof process.env.HERDR_SOCKET_PATH !== 'string') {
    logAction('pane_closed_skip', { reason: 'missing_identity_fields' });
    return;
  }
  const releaseProject = await resolveProjectForPane({
    event,
    paneId,
    agentGet: (id) => runHerdrAgentGet(process.env.HERDR_BIN_PATH, id),
  });
  for (const agent of SUPPORTED_AGENTS) {
    const identity = buildSyncIdentity(agent, paneId, process.env, {});
    if (!identity) continue;
    try {
      await releaseIdentity(identity, releaseProject);
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
