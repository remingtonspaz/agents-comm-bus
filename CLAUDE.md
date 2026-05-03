# Claude Code Telegram Plugin

## Current Status: FULLY OPERATIONAL
- Bidirectional Telegram messaging: WORKING
- Auto-enter (no manual Enter needed): WORKING
- Multi-session support (focus-independent input via PostMessage WM_CHAR): WORKING
- Session-specific PID/window targeting: WORKING
- Watcher auto-spawn: WORKING
- Permission control via Telegram (`y`/`n`/`a`): WORKING
- AskUserQuestion / ExitPlanMode / EnterPlanMode (auto-approve + numbered option selection): WORKING
- Slash command forwarding (`;cmd` → `/cmd`): WORKING
- Plugin structure: CONVERTED

---

## SESSION SUMMARY (2026-01-13 - Session 4)

### Watcher Auto-Spawn & Keystroke Delivery Fixes
Major debugging session to fix watcher auto-spawn and reliable keystroke delivery.

#### Problems Solved

1. **SessionStart hook not firing** (Claude Code bug)
   - Moved watcher spawn logic into `UserPromptSubmit` hook as workaround
   - Watcher now spawns on first prompt instead of session start

2. **Watcher process dying immediately**
   - Node.js `spawn()` with `detached: true` unreliable on Windows
   - Fixed by using PowerShell `Start-Process` for proper background process

3. **isWatcherRunning() false positive**
   - `tasklist` doesn't throw error when no process matches
   - Fixed to check output for "INFO:" message

4. **Process tree walking failures**
   - PowerShell script syntax errors when newlines replaced with spaces
   - Fixed by using incremental WMIC calls (same as session-start.js)

5. **Focus/keystroke delivery failing** (later superseded — see Session 5)
   - `SetForegroundWindow` blocked by Windows focus-stealing prevention
   - Initially fixed by using `AppActivate` as primary method
   - **This approach was later replaced** by PostMessage WM_CHAR because AppActivate steals focus and breaks multi-session use.

6. **Multiple Claude windows targeting wrong window**
   - Search mode would find first matching window
   - Fixed by walking process tree from hook to find correct cmd.exe ancestor

#### Key Technical Changes

- `telegram-context.js`: Added `findCmdAncestor()` using WMIC to reliably find parent cmd.exe
- `telegram-context.js`: Use `Start-Process` via PowerShell for watcher spawn
- `enter-watcher.ps1`: Prioritize `AppActivate` over `SetForegroundWindow`
- `enter-watcher.ps1`: Fall back to search mode if PID invalid (handles race conditions)
- `enter-watcher.ps1`: Added `AttachThreadInput` as secondary focus method

#### New Debug Files

| File | Purpose |
|------|---------|
| `~/.claude-telegram/session-info.json` | Debug: hookPid, cmdPid, windowHandle |
| `~/.claude-telegram/watcher.pid` | Tracks spawned watcher process |
| `~/.claude-telegram/debug.log` | Error logging |

---

## SESSION SUMMARY (2026-02-14 - Session 5)

### PostMessage WM_CHAR + AskUserQuestion Support

#### Problems Solved

1. **AppActivate steals focus, breaks multi-session**
   - Replaced with `PostMessage(hwnd, WM_CHAR, charCode, 1)`
   - Focus-independent: target window does not need to be foregrounded
   - Each watcher targets its own `hwnd` via `session-info.json`, so concurrent sessions don't fight over focus

2. **`findCmdAncestor` returning the wrong cmd.exe**
   - Old implementation returned the first cmd.exe encountered in the process tree
   - That was the *transient* cmd.exe (child of claude.exe), which dies when the hook exits → watcher targeted a dead PID
   - Fixed to walk the full tree and return the *persistent* cmd.exe (parent of claude.exe), which owns the visible console window

3. **AskUserQuestion / ExitPlanMode / EnterPlanMode UX**
   - Permission hook now auto-approves these (`{ decision: { behavior: 'allow' } }`) so the question UI renders immediately
   - Without auto-approve, the `y`+Enter from permission approval carried over and selected option 1
   - Numbered options surface in Telegram; replying with the number sends just the digit via WM_CHAR

#### Key Technical Discoveries

- `lParam` MUST be `1` in PostMessage WM_CHAR (the repeat-count field). `lParam=0` triggers **65536 repeats** because the 16-bit repeat count wraps.
- 20ms delay between characters prevents dropped chars on the receiving console.
- `WM_KEYDOWN` does **not** work for console windows via PostMessage — only `WM_CHAR` reaches them.
- VT escape sequences (e.g. `ESC [ B` for arrow keys) sent via WM_CHAR do **not** combine — the console processes each character individually. Use number-key selection instead.

---

## Previous Sessions

### Session 3 (2026-01-09)
Plugin conversion - converted from standalone to plugin format.

### Session 2 (2026-01-09)
Built permission control via Telegram (y/n/a responses).

### Session 1 (2026-01-09)
Initial watcher auto-spawn and debug logging.

---

## Plugin Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Code Session                          │
│  ┌──────────────────┐       ┌─────────────────────────────┐     │
│  │ Hooks            │       │ MCP Tools                   │     │
│  │ - UserPromptSubmit│       │ - telegram_send             │     │
│  │ - PermissionRequest│      │ - telegram_send_image       │     │
│  │ - SessionStart   │       │ - telegram_check_messages   │     │
│  └────────┬─────────┘       └─────────────┬───────────────┘     │
└───────────┼───────────────────────────────┼─────────────────────┘
            │                               │
            ▼                               ▼
     ┌──────────────┐              ┌──────────────────┐
     │ Queue File   │◄────writes───│ Telegram MCP     │
     │ queue.json   │              │ Server           │
     └──────────────┘              │ (bot listener)   │
                                   └────────┬─────────┘
                                            │
                                            ▼
                                   ┌──────────────────┐
                                   │    Telegram      │
                                   └──────────────────┘
```

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| Plugin Metadata | `.claude-plugin/plugin.json` | Plugin configuration |
| MCP Server (source) | `mcp-server/server.js` | Telegram bot, MCP tools |
| MCP Server (bundle) | `mcp-server/dist/server.js` | Bundled server (what `.mcp.json` points to) |
| Context Hook | `hooks/telegram-context.js` | Injects messages + spawns watcher |
| Permission Hook | `hooks/permission-telegram.cjs` | Permission notifications + auto-approve AskUserQuestion/plan-mode prompts |
| Session Hook | `hooks/session-start.js` | (Unused - SessionStart hook bug; spawn moved to UserPromptSubmit) |
| Watcher Script | `scripts/enter-watcher.ps1` | Keystroke automation via PostMessage WM_CHAR |
| Skill | `skills/telegram/SKILL.md` | Claude instructions |

---

## Implementation Details

### Keystroke delivery: PostMessage WM_CHAR

The watcher delivers keystrokes to the Claude Code console window using:

```
PostMessage(hwnd, WM_CHAR, charCode, /* lParam */ 1)
```

This is **focus-independent** — the target window does not need to be foregrounded. This is what enables multi-session: each session's watcher targets its own `hwnd` (read from `session-info.json`) and concurrent sessions don't fight over focus.

**Critical quirks:**
- `lParam` MUST be `1` (repeat count). `lParam=0` triggers **65536 repeats** (16-bit wrap).
- 20ms delay between characters prevents drops.
- `WM_KEYDOWN` does **not** work for console windows via PostMessage — only `WM_CHAR`.
- VT escape sequences via WM_CHAR don't combine — chars processed individually. Use number-key selection.
- Earlier `WriteConsoleInputW` experiments reported success but didn't reach Claude Code (ConPTY bypasses the console input buffer). Preserved on the `dev` branch.

### Process tree topology

```
explorer.exe
  └─ cmd.exe (persistent — has the console window)
       └─ claude.exe
            └─ cmd.exe (transient — exists only while a hook runs)
                 └─ node.exe (the hook process itself)
```

The hook needs the **persistent** cmd.exe (parent of claude.exe) — that's the one with the visible console window. The transient cmd.exe child of claude.exe dies as soon as the hook exits.

`findCmdAncestor()` in `hooks/telegram-context.js` walks the full tree via WMIC and returns the cmd.exe whose **child** is claude.exe. Returning the first cmd.exe found (the transient one) results in a dead-PID target by the time the watcher runs.

### Hook process has no console

The hook is invoked headlessly, so `GetConsoleWindow()` from inside the hook always returns `0`. The window handle has to come from walking the process tree, not from the hook's own console.

### MCP server bundling (esbuild)

The MCP server is bundled to a single file via esbuild (no `node_modules` needed at runtime). Because the source is ESM but some deps (`node-telegram-bot-api`) are CJS, the build needs the CJS-interop banner:

```
--banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
```

Required for Node.js v24+. Without it, the bundle fails at runtime when CJS deps try to use `require`.

---

## Features

### Auto-Enter
Telegram messages automatically trigger Claude - no manual Enter needed.

1. User sends message on Telegram
2. MCP server queues message, creates trigger file
3. Watcher detects trigger, sends `.` + Enter to Claude window
4. Claude processes with Telegram context injected

### Permission Control
Control Claude's permission prompts remotely via Telegram.

1. Claude requests permission → notification sent to Telegram
2. Reply: `y` (yes), `n` (no), or `a` (always)
3. Watcher sends keystroke → Claude continues

### AskUserQuestion / Plan Mode
Numbered options surface in Telegram for `AskUserQuestion`, `ExitPlanMode`, and `EnterPlanMode` prompts.

1. Claude reaches one of these prompts
2. Permission hook auto-approves it (so the question UI renders immediately, without a `y`+Enter that would carry over and select option 1)
3. Numbered options are sent to Telegram with descriptions
4. Reply with the number (`1`, `2`, ...) → watcher sends just that digit via WM_CHAR

### Slash Command Forwarding
Send Claude Code slash commands from Telegram using `;` as the prefix (since Telegram reserves `/` for bot commands).

1. Send `;commit` on Telegram
2. MCP server detects the `;word` pattern, writes `slash-command.json`
3. Watcher reads the command file, types `/commit` + Enter into the terminal
4. Claude Code executes the slash command

**Rules:**
- Only single-word commands are recognized: `;commit`, `;help`, `;mcp`
- Multi-word messages like `;foo bar` are treated as regular messages
- Commands older than 60 seconds are discarded as stale

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `telegram_send` | Send text message |
| `telegram_send_image` | Send image file |
| `telegram_check_messages` | Check pending messages |

---

## Installation

### As Plugin (Recommended)
```bash
/plugin install telegram
```

### Manual
```bash
cd mcp-server && npm install && npm run build
cp .mcp.json.template .mcp.json
# Edit .mcp.json with your credentials
```

---

## Configuration Files

### Credentials (choose one)

| Method | Location | Purpose |
|--------|----------|---------|
| Per-project | `<project>/.claude/telegram.json` | Project-specific credentials (priority) |
| Global | `.mcp.json` env vars | Default credentials for all projects |

**Per-project config** (`<project>/.claude/telegram.json`):
```json
{
  "botToken": "YOUR_BOT_TOKEN",
  "userId": "YOUR_USER_ID"
}
```

The server checks for `.claude/telegram.json` first, then falls back to environment variables from `.mcp.json`.

### MCP Server Registration

Two paths register the MCP server, depending on how the plugin is loaded:

| Mode | Source of MCP config | Path used |
|------|----------------------|-----------|
| Installed plugin (via marketplace) | `.claude-plugin/plugin.json` → `mcpServers` block | `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.js` (substituted at load time) |
| In-tree development (`cd` into repo and run Claude) | `.mcp.json` at repo root (gitignored) | absolute path on your machine |

The canonical config is in `plugin.json` — that's what end users get when they `/plugin install`. `.mcp.json` is a local-dev override that lets you run the plugin directly from the source repo without installing it. **`.mcp.json` is gitignored** so per-machine paths don't leak into commits and don't override the plugin install.

To bootstrap dev mode after a fresh clone: copy `.mcp.json.template` to `.mcp.json` and replace `ABSOLUTE_REPO_PATH` with the absolute path to your clone.

### Other Files

| File | Purpose |
|------|---------|
| `.mcp.json` | Local-dev MCP config (gitignored). Not used by plugin install. |
| `.mcp.json.template` | Seed for local `.mcp.json` after cloning. |
| `.claude-plugin/plugin.json` | Plugin metadata + canonical `mcpServers` block for plugin install. |

### Session-Specific Files

Each Claude Code session has its own folder: `~/.claude-telegram/<project>-<hash>/`

Example: `D:\Projects\my-app` → `~/.claude-telegram/my-app-a1b2c3/`

| File | Purpose |
|------|---------|
| `queue.json` | Message queue |
| `trigger-enter` | Trigger file for watcher |
| `pending-permission.json` | Pending permission |
| `permission-response.json` | Permission response |
| `slash-command.json` | Pending slash command |
| `watcher.pid` | Watcher process ID |
| `session-info.json` | Debug: session/window info |
| `debug.log` | Error logging |

---

## Development Workflow

The MCP server is bundled into a single file using esbuild. This eliminates the need for `npm install` at runtime — all dependencies are baked into `mcp-server/dist/server.js`.

### After editing `mcp-server/server.js`:
```bash
cd mcp-server && npm run build
```
Then restart the MCP server in Claude Code (`/mcp` → restart telegram).

### Why bundling?
- `.mcp.json` points to `dist/server.js`, not `server.js`
- No `node_modules` needed at runtime (3 MB bundle vs 46 MB node_modules)
- `npm install` is only needed for development (adding/updating dependencies)

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| MCP not connecting | Check `/mcp`, verify `.mcp.json` |
| Messages not appearing | Check queue file, verify hook config |
| Watcher not running | Check `watcher.pid`, verify process exists |
| Watcher dies immediately | Check `debug.log` for errors |
| Keystrokes to wrong window | Verify `session-info.json` has correct `cmdPid` (must be parent of claude.exe, not transient child) |
| Permission notifications broken | Check hook in settings.local.json |
| Characters dropped or repeated 65536× | Verify PostMessage call uses `lParam=1`, not `0` |
| AskUserQuestion selects option 1 immediately | Verify permission hook auto-approves the prompt instead of requiring `y`+Enter |

### Debug Commands

```powershell
# List all session folders
Get-ChildItem "$env:USERPROFILE\.claude-telegram" -Directory

# Check session info (replace <session-folder> with actual folder name)
Get-Content "$env:USERPROFILE\.claude-telegram\<session-folder>\session-info.json"

# Check watcher status
$pid = Get-Content "$env:USERPROFILE\.claude-telegram\<session-folder>\watcher.pid"
Get-Process -Id $pid -ErrorAction SilentlyContinue

# Check for errors
Get-Content "$env:USERPROFILE\.claude-telegram\<session-folder>\debug.log"

# List all cmd.exe windows (for multiple window debugging)
Get-Process -Name cmd | ForEach-Object {
    Write-Host "PID: $($_.Id) | Title: '$($_.MainWindowTitle)'"
}
```
