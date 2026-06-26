# agents-comm-bus Plugin Installer
# https://raw.githubusercontent.com/remingtonspaz/agents-comm-bus/main/scripts/install.ps1
#
# Usage:
#   irm https://raw.githubusercontent.com/remingtonspaz/agents-comm-bus/main/scripts/install.ps1 | iex
#
# Or download + run with parameters:
#   irm https://raw.githubusercontent.com/remingtonspaz/agents-comm-bus/main/scripts/install.ps1 -OutFile install-acb.ps1
#   .\install-acb.ps1 -Agents claude,codex -Comms telegram,discord
#
# This script is a PURE PLUGIN INSTALLER. It does NOT handle:
# - Bot token prompting or account-add
# - Allowlist setup
# - Daemon CLI PATH configuration
# - Any account/token/daemon-CLI operations
#
# Account registration is a separate manual step via the daemon CLI after install.

param(
    [string[]]$Agents,
    [string[]]$Comms,
    [switch]$Update
)

$ErrorActionPreference = "Stop"

# Run a native command, returning $true on exit code 0. Switches to Continue
# locally so a native tool writing to stderr doesn't throw under the script's
# Stop preference (PowerShell wraps native stderr as errors when
# ErrorActionPreference=Stop). Native non-zero exits do NOT throw, so success
# must be checked via $LASTEXITCODE, not try/catch.
function Invoke-Native {
    param([Parameter(Mandatory)][string]$Exe, [string[]]$CmdArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Exe @CmdArgs 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $prev
    }
}

# --- Agent definitions ---
$AgentDefs = @{
    "claude" = @{
        Name = "Claude Code"
        ProbeCommand = "claude"
        VersionArg = "--version"
        Marketplaces = @{
            "telegram" = @{ Url = "https://github.com/remingtonspaz/agents-comm-bus-claude"; Plugin = "agents-comm-bus-telegram" }
            "discord"  = @{ Url = "https://github.com/remingtonspaz/agents-comm-bus-claude"; Plugin = "agents-comm-bus-discord" }
            "matrix"   = @{ Url = "https://github.com/remingtonspaz/agents-comm-bus-claude"; Plugin = "agents-comm-bus-matrix" }
            "curl"     = @{ Url = "https://github.com/remingtonspaz/agents-comm-bus-claude"; Plugin = "agents-comm-bus-curl" }
        }
        MarketplaceName = "agents-comm-bus-claude"
    }
    "codex" = @{
        Name = "Codex"
        ProbeCommand = "codex"
        VersionArg = "--version"
        Marketplaces = @{
            "telegram" = @{ Url = "https://github.com/remingtonspaz/agents-comm-bus-codex"; Plugin = "telegram" }
            "discord"  = @{ Url = "https://github.com/remingtonspaz/agents-comm-bus-codex"; Plugin = "discord" }
            "matrix"   = @{ Url = "https://github.com/remingtonspaz/agents-comm-bus-codex"; Plugin = "matrix" }
            "curl"     = @{ Url = "https://github.com/remingtonspaz/agents-comm-bus-codex"; Plugin = "curl" }
        }
        MarketplaceName = "agents-comm-bus-codex"
    }
    "pi" = @{
        Name = "Pi"
        ProbeCommand = "pi"
        VersionArg = "--version"
        Marketplaces = @{
            "telegram" = @{ Url = "git:github.com/remingtonspaz/agents-comm-bus-pi-telegram"; Plugin = $null }
            "discord"  = @{ Url = "git:github.com/remingtonspaz/agents-comm-bus-pi-discord"; Plugin = $null }
            "matrix"   = @{ Url = "git:github.com/remingtonspaz/agents-comm-bus-pi-matrix"; Plugin = $null }
            "curl"     = @{ Url = "git:github.com/remingtonspaz/agents-comm-bus-pi-curl"; Plugin = $null }
        }
        MarketplaceName = $null
    }
}

$CommDescriptions = @{
    "telegram" = "Telegram messaging (bidirectional)"
    "discord"  = "Discord messaging (bidirectional)"
    "matrix"   = "Matrix messaging (bidirectional)"
    "curl"     = "Local HTTP ingress (inbound-only)"
}

$AllAgents = @("claude", "codex", "pi")
$AllComms = @("telegram", "discord", "matrix", "curl")

# --- Step 1: Detect installed agents ---
function Test-AgentInstalled($probeCmd) {
    try {
        $null = Get-Command $probeCmd -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

Write-Host ""
Write-Host "agents-comm-bus Plugin Installer" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

$DetectedAgents = @()
foreach ($agent in $AllAgents) {
    $def = $AgentDefs[$agent]
    $installed = Test-AgentInstalled $def.ProbeCommand
    if ($installed) {
        $version = try { & $def.ProbeCommand $def.VersionArg 2>&1 | Select-Object -First 1 } catch { "(version unavailable)" }
        Write-Host "  [detected] $($def.Name): $version" -ForegroundColor Green
        $DetectedAgents += $agent
    } else {
        Write-Host "  [not found] $($def.Name)" -ForegroundColor Gray
    }
}

if ($DetectedAgents.Count -eq 0) {
    Write-Host ""
    Write-Host "No supported coding agents detected on PATH." -ForegroundColor Yellow
    Write-Host "Install Claude Code, Codex, or Pi first, then re-run this script." -ForegroundColor Yellow
    exit 1
}

# --- Step 2: Agent selection ---
if ($Agents) {
    $SelectedAgents = $Agents | Where-Object { $DetectedAgents -contains $_ }
    if ($SelectedAgents.Count -eq 0) {
        Write-Host "None of the specified agents (-Agents $Agents) were detected." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host ""
    Write-Host "Select agents to install agents-comm-bus for:" -ForegroundColor Cyan
    $SelectedAgents = @()
    for ($i = 0; $i -lt $DetectedAgents.Count; $i++) {
        $agent = $DetectedAgents[$i]
        $name = $AgentDefs[$agent].Name
        $choice = Read-Host "  Install for ${name}? (y/n, default y)"
        if ($choice -ne "n") {
            $SelectedAgents += $agent
        }
    }
    if ($SelectedAgents.Count -eq 0) {
        Write-Host "No agents selected. Exiting." -ForegroundColor Yellow
        exit 0
    }
}

# --- Step 3: Comm selection ---
if ($Comms) {
    $SelectedComms = $Comms | Where-Object { $AllComms -contains $_ }
} else {
    Write-Host ""
    Write-Host "Select comm adapters to install:" -ForegroundColor Cyan
    $SelectedComms = @()
    foreach ($comm in $AllComms) {
        $desc = $CommDescriptions[$comm]
        $choice = Read-Host "  $comm ($desc)? (y/n, default y)"
        if ($choice -ne "n") {
            $SelectedComms += $comm
        }
    }
    if ($SelectedComms.Count -eq 0) {
        Write-Host "No comms selected. Exiting." -ForegroundColor Yellow
        exit 0
    }
}

Write-Host ""
Write-Host "Installing:" -ForegroundColor Cyan
Write-Host "  Agents: $($SelectedAgents -join ', ')"
Write-Host "  Comms:  $($SelectedComms -join ', ')"
Write-Host ""

# --- Step 4: Run plugin install/update commands ---
foreach ($agent in $SelectedAgents) {
    $def = $AgentDefs[$agent]
    $name = $def.Name
    Write-Host "[$name]" -ForegroundColor Cyan

    # Add marketplace (Claude/Codex; Pi uses direct git install). Both CLIs take
    # a single <source> arg (URL/repo) — the marketplace NAME is read from the
    # repo's marketplace.json, so pass ONLY the URL (not name + url).
    if ($def.MarketplaceName) {
        $marketplaceUrl = $def.Marketplaces[$SelectedComms[0]].Url
        Write-Host "  Adding marketplace $($def.MarketplaceName)..." -NoNewline
        if (Invoke-Native $def.ProbeCommand @("plugin", "marketplace", "add", $marketplaceUrl)) {
            Write-Host " done" -ForegroundColor Green
        } else {
            # Non-zero typically means it's already configured; the plugin
            # install below is the real gate, so don't hard-fail here.
            Write-Host " already present or skipped (ok)" -ForegroundColor Gray
        }
    }

    foreach ($comm in $SelectedComms) {
        $mp = $def.Marketplaces[$comm]
        if ($agent -eq "pi") {
            # Pi: direct git install
            Write-Host "  Installing pi-$comm..." -NoNewline
            if (Invoke-Native "pi" @("install", $mp.Url)) {
                Write-Host " done" -ForegroundColor Green
            } else {
                Write-Host " failed (exit $LASTEXITCODE)" -ForegroundColor Red
            }
        } elseif ($agent -eq "claude") {
            # Claude: plugin install <plugin>@<marketplace>
            Write-Host "  Installing $($mp.Plugin)..." -NoNewline
            if (Invoke-Native "claude" @("plugin", "install", "$($mp.Plugin)@$($def.MarketplaceName)", "--scope", "user")) {
                Write-Host " done" -ForegroundColor Green
            } else {
                Write-Host " failed (exit $LASTEXITCODE)" -ForegroundColor Red
            }
        } elseif ($agent -eq "codex") {
            # Codex: plugin add <plugin>@<marketplace> (marketplace added above)
            Write-Host "  Installing $($mp.Plugin)..." -NoNewline
            if (Invoke-Native "codex" @("plugin", "add", "$($mp.Plugin)@$($def.MarketplaceName)")) {
                Write-Host " done" -ForegroundColor Green
            } else {
                Write-Host " failed (exit $LASTEXITCODE)" -ForegroundColor Red
            }
        }
    }
    Write-Host ""
}

# --- Step 5: Summary + next steps ---
Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Restart your agent(s) so MCP servers and hooks load."
Write-Host "  2. Register a bot account via the daemon CLI:"
Write-Host '     agents-comm account-add --project "<path>" --agent <agent> --account-label main --comm <comm> --bot-token "<token>"'
Write-Host "  3. Allowlist the sender:"
Write-Host "     agents-comm allowlist add --comm <comm> --user <your_id> --bot-id <bot_id>"
Write-Host ""
Write-Host "See the README Installation section for details:" -ForegroundColor Gray
Write-Host "  https://github.com/remingtonspaz/agents-comm-bus#installation" -ForegroundColor Gray
Write-Host ""
