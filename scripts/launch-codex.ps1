# launch-codex.ps1
#
# One-shot launcher for the Telegram-capable Codex workflow.
#
# What it does:
#   1. Resolves the project directory (default: current directory) and
#      sanity-checks that a .codex/telegram.json exists there.
#   2. Kills any leftover codex MCP server processes from a prior session
#      (the most common cause of polling 409 conflicts on restart).
#   3. Spawns `codex app-server --listen ws://127.0.0.1:4500` in a new
#      window, with the project dir as cwd (so spawned MCP servers
#      inherit it and find per-project credentials).
#   4. Launches `codex --remote ws://127.0.0.1:4500` in the current
#      terminal.
#
# Usage:
#   ./scripts/launch-codex.ps1                          # uses cwd as project
#   ./scripts/launch-codex.ps1 D:\Documents\web\stonks  # explicit project
#   ./scripts/launch-codex.ps1 -AppServerUrl ws://127.0.0.1:4501
#
# Notes:
#   - The app-server window stays open after this script exits — Ctrl-C
#     the TUI doesn't tear it down. Useful if you want to reattach without
#     a full restart. Close it yourself when you're done with the session.
#   - Only one app-server can bind a given port. If you run this with the
#     same port for two projects, the second one's app-server will refuse
#     to start. Pass -AppServerUrl with a different port to overlap.

param(
    [string]$ProjectDir = (Get-Location).Path,
    [string]$AppServerUrl = "ws://127.0.0.1:4500"
)

$ErrorActionPreference = "Stop"

# Resolve and validate the project directory.
$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
$credsPath = Join-Path $ProjectDir ".codex/telegram.json"
if (-not (Test-Path -LiteralPath $credsPath)) {
    Write-Error "Missing $credsPath. Set up the project first (see README -- per-new-project setup)."
}

# Kill any stale codex MCP server processes from prior sessions. Without
# this, the new spawn races the orphan for the bot's polling slot and
# both keep stealing it from each other (Telegram returns 409 Conflict).
$staleMcp = Get-CimInstance Win32_Process -Filter "name='node.exe'" |
    Where-Object { $_.CommandLine -like '*claude-code-telegram-codex*' }
if ($staleMcp) {
    Write-Host "Killing stale codex MCP server(s): $($staleMcp.ProcessId -join ', ')" -ForegroundColor Yellow
    $staleMcp | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
}

# Start the app-server in a new window with the project dir as cwd.
Write-Host "Starting app-server in $ProjectDir (listen=$AppServerUrl)" -ForegroundColor Cyan
$appServerProc = Start-Process -FilePath "codex" `
    -ArgumentList @("app-server", "--listen", $AppServerUrl) `
    -WorkingDirectory $ProjectDir `
    -PassThru
Write-Host "  app-server PID: $($appServerProc.Id)" -ForegroundColor Cyan

# Give the app-server a moment to bind the port before the TUI tries to
# connect. 1.5s is generous on a warm machine; the TUI's connect retries
# would also handle a slower start, but a brief wait keeps the logs tidy.
Start-Sleep -Seconds 2

# Launch the TUI in this terminal, attached to the same app-server.
Write-Host "Launching TUI (codex --remote $AppServerUrl)" -ForegroundColor Cyan
Set-Location -LiteralPath $ProjectDir
& codex --remote $AppServerUrl
