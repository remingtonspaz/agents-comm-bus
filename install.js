#!/usr/bin/env node
/**
 * Telegram MCP Integration Installer
 *
 * Usage:
 *   node install.js          - Full installation
 *   node install.js --status - Check installation status
 *   node install.js --help   - Show help
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_ROOT = path.join(os.homedir(), '.agents-comm-bus');
const CORE_DIR = path.join(__dirname, 'agents-comm-bus-core');
const DAEMON_DIR = path.join(__dirname, 'agents-comm-bus');
const MCP_SERVER_DIR = path.join(__dirname, 'mcp-server');
const HOOKS_DIR = path.join(__dirname, 'hooks');
const MCP_CONFIG = path.join(__dirname, '.mcp.json');
const SETTINGS_FILE = path.join(__dirname, '.claude', 'settings.local.json');

// Colors for console output
const colors = {
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  blue: (text) => `\x1b[34m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

function log(message, type = 'info') {
  const prefix = {
    info: colors.blue('[INFO]'),
    success: colors.green('[OK]'),
    error: colors.red('[ERROR]'),
    warn: colors.yellow('[WARN]'),
  };
  console.log(`${prefix[type] || prefix.info} ${message}`);
}

function checkNodeVersion() {
  const version = process.versions.node;
  const major = parseInt(version.split('.')[0], 10);
  if (major < 22) {
    log(`Node.js version ${version} is too old. Requires >= 22 for node:sqlite.`, 'error');
    return false;
  }
  log(`Node.js version ${version}`, 'success');
  return true;
}

function checkPackageBuilt(dir, entry) {
  return fs.existsSync(path.join(dir, entry));
}

function checkStateRoot() {
  return fs.existsSync(STATE_ROOT);
}

function checkMcpConfig() {
  return fs.existsSync(MCP_CONFIG);
}

function checkHookConfig() {
  if (!fs.existsSync(SETTINGS_FILE)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    return settings.hooks?.UserPromptSubmit?.length > 0;
  } catch {
    return false;
  }
}

function checkTelegramBot() {
  if (!fs.existsSync(MCP_CONFIG)) return { ok: false, reason: 'No .mcp.json' };
  try {
    const config = JSON.parse(fs.readFileSync(MCP_CONFIG, 'utf-8'));
    const token = config.mcpServers?.telegram?.env?.TELEGRAM_BOT_TOKEN;
    const userId = config.mcpServers?.telegram?.env?.TELEGRAM_USER_ID;
    if (!token) return { ok: false, reason: 'No bot token configured' };
    if (!userId) return { ok: false, reason: 'No user ID configured' };
    return { ok: true, token, userId };
  } catch (e) {
    return { ok: false, reason: `Config parse error: ${e.message}` };
  }
}

async function testTelegramConnection(token) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await response.json();
    if (data.ok) {
      return { ok: true, botName: data.result.username };
    }
    return { ok: false, reason: data.description };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function showStatus() {
  console.log(colors.bold('\n=== Telegram MCP Integration Status ===\n'));

  // Node.js version
  checkNodeVersion();

  if (checkPackageBuilt(CORE_DIR, 'dist/index.js')) {
    log('agents-comm-bus-core built', 'success');
  } else {
    log('agents-comm-bus-core not built', 'warn');
  }

  if (checkPackageBuilt(DAEMON_DIR, 'dist/daemon.js')) {
    log('agents-comm-bus daemon built', 'success');
  } else {
    log('agents-comm-bus daemon not built', 'warn');
  }

  if (checkPackageBuilt(MCP_SERVER_DIR, 'dist/server.js')) {
    log('MCP IPC shim built', 'success');
  } else {
    log('MCP IPC shim not built', 'warn');
  }

  if (checkStateRoot()) {
    log(`State root exists: ${STATE_ROOT}`, 'success');
  } else {
    log(`State root will be created lazily: ${STATE_ROOT}`, 'info');
  }

  // MCP config
  if (checkMcpConfig()) {
    log('.mcp.json configuration exists', 'success');
  } else {
    log('.mcp.json configuration missing', 'error');
  }

  // Hook config
  if (checkHookConfig()) {
    log('UserPromptSubmit hook configured', 'success');
  } else {
    log('UserPromptSubmit hook not configured', 'warn');
  }

  // Telegram bot
  const botCheck = checkTelegramBot();
  if (botCheck.ok) {
    log('Telegram credentials configured', 'success');

    // Test connection
    console.log('\nTesting Telegram connection...');
    const connTest = await testTelegramConnection(botCheck.token);
    if (connTest.ok) {
      log(`Connected to Telegram bot: @${connTest.botName}`, 'success');
    } else {
      log(`Telegram connection failed: ${connTest.reason}`, 'error');
    }
  } else {
    log(`Telegram config issue: ${botCheck.reason}`, 'error');
  }

  console.log('\n' + colors.bold('Next steps:'));
  console.log('  1. Register a Telegram account: node agents-comm-bus/dist/cli/index.js account-add --project <path> --agent claude --account-label main');
  console.log('  2. Restart Claude Code to load the MCP IPC shim');
  console.log('  3. Check /mcp to verify server is connected');
  console.log('  4. Test list_conversations or comm_send_message with an explicit nested target { chat_native_id, thread_native_id? }\n');
}

function installAndBuildPackage(label, dir, build = true) {
  log(`Installing ${label} dependencies...`);
  execSync('npm install --silent', { cwd: dir, stdio: 'inherit' });
  if (build) {
    log(`Building ${label}...`);
    execSync('npm run build', { cwd: dir, stdio: 'inherit' });
  }
  log(`${label} ready`, 'success');
}

async function install() {
  console.log(colors.bold('\n=== Installing Telegram MCP Integration ===\n'));

  // Check Node.js version
  if (!checkNodeVersion()) {
    process.exit(1);
  }

  if (!checkStateRoot()) {
    fs.mkdirSync(STATE_ROOT, { recursive: true });
    log(`Created daemon state root: ${STATE_ROOT}`, 'success');
  }

  try {
    installAndBuildPackage('agents-comm-bus-core', CORE_DIR);
    installAndBuildPackage('agents-comm-bus daemon', DAEMON_DIR);
    installAndBuildPackage('MCP IPC shim', MCP_SERVER_DIR);
  } catch (e) {
    log(`Failed to install/build packages: ${e.message}`, 'error');
    process.exit(1);
  }

  // Check MCP config (optional - credentials can be in project .mcp.json)
  if (!checkMcpConfig()) {
    log('No .mcp.json in plugin directory (this is OK for plugin installs)', 'info');
    console.log('\nAdd the MCP server to your PROJECT\'s .mcp.json:');
    console.log(JSON.stringify({
      mcpServers: {
        telegram: {
          command: 'node',
          args: [path.join(__dirname, 'mcp-server', 'server.js')],
          env: {
            TELEGRAM_BOT_TOKEN: 'YOUR_BOT_TOKEN',
            TELEGRAM_USER_ID: 'YOUR_USER_ID',
          },
        },
      },
    }, null, 2));
  } else {
    log('.mcp.json configuration found', 'success');
  }

  // Verify hook config
  if (!checkHookConfig()) {
    log('Hook not configured in settings.local.json', 'warn');
    log('Please ensure hooks are configured for UserPromptSubmit', 'warn');
  } else {
    log('Hook configuration found', 'success');
  }

  // Test Telegram connection
  const botCheck = checkTelegramBot();
  if (botCheck.ok) {
    console.log('\nTesting Telegram connection...');
    const connTest = await testTelegramConnection(botCheck.token);
    if (connTest.ok) {
      log(`Connected to Telegram bot: @${connTest.botName}`, 'success');
    } else {
      log(`Telegram connection test failed: ${connTest.reason}`, 'warn');
      log('The bot may still work - check your token if issues persist', 'warn');
    }
  }

  console.log(colors.bold('\n=== Installation Complete ===\n'));
  console.log('Next steps:');
  console.log('  1. Register the Telegram bot explicitly:');
  console.log('     TELEGRAM_BOT_TOKEN=... node agents-comm-bus/dist/cli/index.js account-add --project "<project>" --agent claude --account-label main');
  console.log('  2. Restart Claude Code to load the MCP IPC shim');
  console.log('  3. Check /mcp to verify "telegram" server is connected');
  console.log('  4. Use list_conversations or comm_send_message with an explicit nested target { chat_native_id, thread_native_id? }\n');
}

function showHelp() {
  console.log(`
${colors.bold('Telegram MCP Integration Installer')}

Usage:
  node install.js          Full installation
  node install.js --status Check installation status
  node install.js --force  Reinstall dependencies
  node install.js --help   Show this help

This installer:
  1. Creates the daemon state root (~/.agents-comm-bus/)
  2. Installs and builds core, daemon, and MCP IPC shim packages
  3. Verifies configuration files
  4. Tests Telegram bot connectivity when credentials are present
`);
}

// Main
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  showHelp();
} else if (args.includes('--status') || args.includes('-s')) {
  showStatus();
} else if (args.includes('--force') || args.includes('-f')) {
  // Force reinstall by removing node_modules first
  const nodeModules = path.join(MCP_SERVER_DIR, 'node_modules');
  if (fs.existsSync(nodeModules)) {
    log('Removing existing node_modules...');
    fs.rmSync(nodeModules, { recursive: true, force: true });
  }
  install();
} else {
  install();
}
