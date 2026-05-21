import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import {
  MARKETPLACE_PATHS,
  renderMarketplaceManifest,
  updateMarketplaceRepo,
  validateSplitMarketplaceTargets,
} from '../../scripts/update-marketplace-pointers.js';

const monorepoUrl = 'https://github.com/remingtonspaz/claude-code-telegram.git';

test('renderMarketplaceManifest points each agent at its own plugin subtree', () => {
  const claude = renderMarketplaceManifest('claude', {
    version: '2.0.0',
    tag: 'v2.0.0',
    monorepoUrl,
  });
  const codex = renderMarketplaceManifest('codex', {
    version: '2.0.0',
    tag: 'v2.0.0',
    monorepoUrl,
  });

  assert.equal(claude.plugins[0].source.path, 'plugins/claude/telegram');
  assert.equal(codex.plugins[0].source.path, 'plugins/codex/telegram');
  assert.equal(claude.pinnedTag, 'v2.0.0');
  assert.equal(codex.pinnedTag, 'v2.0.0');
});

test('validateSplitMarketplaceTargets rejects using the same repo for both agents', () => {
  assert.throws(
    () => validateSplitMarketplaceTargets({ claude: '/tmp/shared', codex: '/tmp/shared' }),
    /must remain split/,
  );
});

test('updateMarketplaceRepo refuses mixed-agent roots to avoid duplicate Codex listings', async () => {
  const repoPath = path.join(os.tmpdir(), `agents-comm-bus-marketplace-${Date.now()}`);
  await mkdir(path.join(repoPath, path.dirname(MARKETPLACE_PATHS.codex)), { recursive: true });
  await writeFile(path.join(repoPath, MARKETPLACE_PATHS.codex), '{"existing":true}\n', 'utf8');

  await assert.rejects(
    updateMarketplaceRepo({
      agent: 'claude',
      repoPath,
      version: '2.0.0',
      tag: 'v2.0.0',
      monorepoUrl,
    }),
    /Keep marketplace repos split/,
  );

  await rm(repoPath, { recursive: true, force: true });
});
