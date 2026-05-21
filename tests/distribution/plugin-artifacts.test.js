import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COMM_IMPLEMENTATION_STATUS,
  SUPPORTED_AGENTS,
  SUPPORTED_COMMS,
} from '../../scripts/build-plugin-artifacts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

async function assertExists(relativePath) {
  await access(path.join(repoRoot, relativePath));
}

test('plugin artifact matrix contains required files for every agent/comm pair', async () => {
  for (const agent of SUPPORTED_AGENTS) {
    for (const comm of SUPPORTED_COMMS) {
      const base = `plugins/${agent}/${comm}`;
      await assertExists(`${base}/daemon.bundle.js`);
      await assertExists(`${base}/${comm}.adapter.bundle.js`);
      await assertExists(`${base}/skills/${comm}.md`);
      await assertExists(`${base}/storage/schema/001_initial.sql`);
      await assertExists(`${base}/storage/schema/004_session_owner_process.sql`);
      await assertExists(`${base}/hooks/session-start.js`);

      if (agent === 'claude') {
        await assertExists(`${base}/.claude-plugin/plugin.json`);
        const manifest = JSON.parse(await readFile(path.join(repoRoot, `${base}/.claude-plugin/plugin.json`), 'utf8'));
        assert.equal(manifest.name, `agents-comm-bus-${comm}`);
        assert.equal(manifest.version.length > 0, true);
      } else {
        await assertExists(`${base}/.codex-plugin/plugin.json`);
        await assertExists(`${base}/.mcp.json`);
        const manifest = JSON.parse(await readFile(path.join(repoRoot, `${base}/.codex-plugin/plugin.json`), 'utf8'));
        assert.equal(manifest.name, `agents-comm-bus-${comm}`);
        assert.match(manifest.description, /agents-comm-bus/);
      }
    }
  }
});

test('scaffold comms advertise scaffold status and telegram remains implemented', async () => {
  for (const comm of SUPPORTED_COMMS) {
    const skill = await readFile(path.join(repoRoot, `plugins/claude/${comm}/skills/${comm}.md`), 'utf8');
    if (COMM_IMPLEMENTATION_STATUS[comm] === 'implemented') {
      assert.match(skill, /Status: implemented/);
    } else {
      assert.match(skill, /Status: scaffold-only/);
    }
  }
});
