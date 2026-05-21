#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_AGENTS, SUPPORTED_COMMS } from './build-plugin-artifacts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export async function validateReleaseTag({ tag }) {
  if (!tag) {
    throw new Error('A release tag is required, e.g. --tag v2.0.0');
  }

  const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  if (tag !== `v${packageJson.version}`) {
    throw new Error(`Tag ${tag} does not match package.json version v${packageJson.version}`);
  }

  const status = git(['status', '--short']);
  if (status !== '') {
    throw new Error('Git worktree is not clean. Commit source changes and generated plugin artifacts before tagging.');
  }

  for (const agent of SUPPORTED_AGENTS) {
    for (const comm of SUPPORTED_COMMS) {
      const pluginRoot = path.join(repoRoot, 'plugins', agent, comm);
      const required = [
        path.join(pluginRoot, 'daemon.bundle.js'),
        path.join(pluginRoot, `${comm}.adapter.bundle.js`),
        path.join(pluginRoot, 'skills', `${comm}.md`),
      ];
      if (agent === 'claude') {
        required.push(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
      } else {
        required.push(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
        required.push(path.join(pluginRoot, '.mcp.json'));
      }
      for (const candidate of required) {
        if (!(await pathExists(candidate))) {
          throw new Error(`Missing generated release artifact: ${candidate}`);
        }
      }
    }
  }

  const tagLookup = git(['tag', '--list', tag]);
  if (tagLookup !== '') {
    throw new Error(`Git tag ${tag} already exists. Choose a new version or delete the stale tag.`);
  }

  return {
    tag,
    version: packageJson.version,
    head: git(['rev-parse', 'HEAD']),
  };
}

async function main() {
  const tag = argValue('--tag');
  const result = await validateReleaseTag({ tag });
  console.log(`[check-release-tag] ok tag=${result.tag} version=${result.version} head=${result.head}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
