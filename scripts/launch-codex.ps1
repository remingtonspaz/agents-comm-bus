# launch-codex.ps1
#
# One-shot launcher for the Telegram-capable Codex workflow.
#
# What it does:
#   1. Resolves the project directory (default: current directory) and
#      sanity-checks that a .codex/telegram.json exists there.
#   2. Picks an open TCP port in the 4500-4750 range so simultaneous
#      sessions on different projects don't collide.
#   3. Exports CODEX_APP_SERVER_URL=ws://127.0.0.1:<port> in this
#      shell's environment. The MCP server inherits it transitively
#      (launcher -> app-server -> spawned MCP server) and uses it for
#      its wake calls, overriding the default port baked into the
#      global mcp_servers config.
#   4. Kills any leftover codex MCP server processes from a prior
#      session (the most common cause of polling 409 conflicts).
#   5. Spawns `codex app-server --listen ws://127.0.0.1:<port>` in a
#      new window with the project dir as cwd (so spawned MCP servers
#      inherit it and find per-project credentials).
#   6. Launches `codex --remote ws://127.0.0.1:<port>` in this terminal.
#
# Usage:
#   ./scripts/launch-codex.ps1                           # cwd, auto port
#   ./scripts/launch-codex.ps1 D:\Documents\web\stonks   # explicit project
#   ./scripts/launch-codex.ps1 -Port 4555                # explicit port
#   ./scripts/launch-codex.ps1 -PortRangeStart 5000 -PortRangeEnd 5099
#
# Notes:
#   - The app-server window stays open after this script exits — Ctrl-C
#     the TUI doesn't tear it down. Useful for reattaching, but close it
#     yourself when you're done with the session.
#   - The same port goes to all three places (--listen, --remote, env
#     var). Don't try to mix.

param(
    [string]$ProjectDir = (Get-Location).Path,
    [int]$Port = 0,
    [int]$PortRangeStart = 4500,
    [int]$PortRangeEnd = 4750
)

$ErrorActionPreference = "Stop"

# Resolve and validate the project directory.
$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
$credsPath = Join-Path $ProjectDir ".codex/telegram.json"
if (-not (Test-Path -LiteralPath $credsPath)) {
    Write-Error "Missing $credsPath. Set up the project first (see README -- per-new-project setup)."
}

# Find an open loopback port. Try-bind-and-release; there's a tiny race
# window before the app-server claims it, but in practice no other
# process is grabbing ports in this range.
function Find-OpenPort {
    param([int]$Start, [int]$End)
    $loopback = [System.Net.IPAddress]::Loopback
    for ($p = $Start; $p -le $End; $p++) {
        $listener = $null
        try {
            $listener = [System.Net.Sockets.TcpListener]::new($loopback, $p)
            $listener.Start()
            return $p
        } catch {
            continue
        } finally {
            if ($listener) { try { $listener.Stop() } catch {} }
        }
    }
    throw "No open port found in range $Start-$End. Either close a stale app-server or pass -PortRangeStart/-PortRangeEnd."
}

if ($Port -le 0) {
    $Port = Find-OpenPort -Start $PortRangeStart -End $PortRangeEnd
    Write-Host "Selected port $Port (auto)" -ForegroundColor Cyan
} else {
    Write-Host "Using explicit port $Port" -ForegroundColor Cyan
}
$AppServerUrl = "ws://127.0.0.1:$Port"

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

# Export the URL so the MCP server (spawned transitively by app-server)
# picks up the right port from env. The MCP server's getAppServerUrl
# checks env BEFORE the --app-server-url argv flag, so this overrides
# the default port baked into the global mcp_servers config.
$env:CODEX_APP_SERVER_URL = $AppServerUrl
Write-Host "CODEX_APP_SERVER_URL=$AppServerUrl exported to this shell" -ForegroundColor Cyan

# Start the app-server in a new window with the project dir as cwd.
# Start-Process inherits the current process env, so the env var above
# propagates to the app-server and onward to spawned MCP servers.
Write-Host "Starting app-server in $ProjectDir (listen=$AppServerUrl)" -ForegroundColor Cyan
$appServerProc = Start-Process -FilePath "codex" `
    -ArgumentList @("app-server", "--listen", $AppServerUrl) `
    -WorkingDirectory $ProjectDir `
    -PassThru
Write-Host "  app-server PID: $($appServerProc.Id)" -ForegroundColor Cyan

# Give the app-server a moment to bind the port before the TUI tries to
# connect. The TUI's connect would retry on its own but a brief wait
# keeps the logs tidy.
Start-Sleep -Seconds 2

# Launch the TUI in this terminal, attached to the same app-server.
Write-Host "Launching TUI (codex --remote $AppServerUrl)" -ForegroundColor Cyan
Set-Location -LiteralPath $ProjectDir
& codex --remote $AppServerUrl
