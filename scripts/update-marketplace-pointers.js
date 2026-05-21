#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_COMMS } from './build-plugin-artifacts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

export const MARKETPLACE_PATHS = {
  claude: '.claude-plugin/marketplace.json',
  codex: '.agents/plugins/marketplace.json',
};

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

export function renderMarketplaceManifest(agent, { version, tag, monorepoUrl }) {
  if (!(agent in MARKETPLACE_PATHS)) {
    throw new Error(`Unsupported agent: ${agent}`);
  }
  const plugins = SUPPORTED_COMMS.map((comm) => ({
    name: `agents-comm-bus-${comm}`,
    version,
    description: `${capitalize(comm)} distribution pointer for ${agent}.`,
    source: {
      type: 'git-subdir',
      url: monorepoUrl,
      ref: tag,
      path: `plugins/${agent}/${comm}`,
    },
    tags: ['agents-comm-bus', agent, comm],
  }));

  return {
    schemaVersion: 1,
    agent,
    monorepo: monorepoUrl,
    pinnedTag: tag,
    plugins,
  };
}

export function validateSplitMarketplaceTargets(targets) {
  if (!targets.claude || !targets.codex) {
    throw new Error('Both claude and codex marketplace targets are required.');
  }
  if (path.resolve(targets.claude) === path.resolve(targets.codex)) {
    throw new Error('Claude and Codex marketplace repos must remain split; refusing to target the same directory for both agents.');
  }
}

export async function updateMarketplaceRepo({ agent, repoPath, version, tag, monorepoUrl }) {
  if (!(agent in MARKETPLACE_PATHS)) {
    throw new Error(`Unsupported agent: ${agent}`);
  }
  const manifestPath = path.join(repoPath, MARKETPLACE_PATHS[agent]);
  const oppositePath = path.join(repoPath, MARKETPLACE_PATHS[agent === 'claude' ? 'codex' : 'claude']);

  try {
    await stat(oppositePath);
    throw new Error(`Refusing to write ${agent} marketplace manifest into ${repoPath}: found opposite-agent manifest at ${oppositePath}. Keep marketplace repos split to avoid duplicate Codex listings.`);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  const manifest = renderMarketplaceManifest(agent, { version, tag, monorepoUrl });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function main() {
  const agent = argValue('--agent');
  const repoPath = argValue('--repo');
  const tag = argValue('--tag');
  const monorepoUrl = argValue('--monorepo-url') ?? 'https://github.com/remingtonspaz/claude-code-telegram.git';

  if (!agent || !repoPath || !tag) {
    throw new Error('Usage: node scripts/update-marketplace-pointers.js --agent <claude|codex> --repo <path> --tag <tag> [--monorepo-url <url>]');
  }

  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const manifestPath = await updateMarketplaceRepo({
    agent,
    repoPath: path.resolve(repoPath),
    version: packageJson.version,
    tag,
    monorepoUrl,
  });
  console.log(`[update-marketplace-pointers] wrote ${manifestPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
