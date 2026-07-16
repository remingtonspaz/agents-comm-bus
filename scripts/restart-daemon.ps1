<#
.SYNOPSIS
  Reap stale agents-comm-bus daemons for THIS repo and clear discovery files.

.DESCRIPTION
  Finds ALL node processes running this repo's core-daemon/serve.js -- not just the
  PID recorded in ~/.agents-comm-bus/daemon.pid -- and kills them, then clears the
  daemon.pid + port discovery files. This closes the orphan-accumulation hole in
  the old ad-hoc restart (Stop-Process on daemon.pid only): a daemon that wasn't
  the recorded PID (from a spawn-race or a prior restart that didn't write the pid
  file) survived every restart and kept polling the same Telegram bots, producing
  409 getUpdates conflicts and intermittent message loss.

  This is the operational, explicit-developer-restart sibling to the runtime
  self-retirement watchdog (Linear AGE-12). The watchdog auto-retires a superseded
  daemon using the narrow "daemon.pid names a different live PID" rule; this script
  is the broad hammer: kill EVERY serve.js daemon for this repo path. The two are
  complementary and intentionally use different detection predicates.

  Matching is scoped to this repo's serve.js absolute path, so daemons for other
  projects/checkouts are never touched. The daemon is per-user and bootstraps
  lazily, so by default this does NOT respawn -- the next hook/MCP call spawns a
  fresh single daemon. Pass -Respawn to start one immediately. -Respawn requires a valid
  .agents-comm-bus-dev.json in the repo root (resolved via the canonical
  dev-config resolver) and injects AGENTS_COMM_BUS_BIN plus optional
  AGENTS_COMM_BUS_DISCOVERY_ROOT / AGENTS_COMM_BUS_ROOT /
  AGENTS_COMM_BUS_ADAPTERS_DIR into the respawned process. Missing or
  rejected dev markers fail loud; there is no production fallback.

  SAFETY: default is a DRY RUN. Pass -Exec to actually kill + clear.

.EXAMPLE
  powershell scripts/restart-daemon.ps1
  # Preview: list every serve.js daemon for this repo that WOULD be reaped.

.EXAMPLE
  powershell scripts/restart-daemon.ps1 -Exec
  # Reap all this-repo serve.js daemons and clear daemon.pid + port.

.EXAMPLE
  powershell scripts/restart-daemon.ps1 -Exec -Respawn
  # ...and immediately start one fresh daemon.

.EXAMPLE
  powershell scripts/restart-daemon.ps1 -Json
  # Machine-readable plan (combine with -Exec for a machine-readable result).
#>
param(
    [string]$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$StateRoot = (Join-Path $env:USERPROFILE ".agents-comm-bus"),
    [switch]$Exec,
    [switch]$Respawn,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

$servePath = Join-Path $RepoDir "agents-comm-bus\dist\core-daemon\serve.js"
# Command lines may use either slash direction; match both forms of this repo's
# serve.js so we only ever reap daemons belonging to THIS checkout.
$needleBack = $servePath
$needleFwd = $servePath -replace '\\', '/'

$daemons = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and ($_.CommandLine -like '*serve.js*') -and
    (($_.CommandLine -like "*$needleBack*") -or ($_.CommandLine -like "*$needleFwd*"))
}

$found = @($daemons | Sort-Object CreationDate | ForEach-Object {
        [PSCustomObject]@{
            Pid         = $_.ProcessId
            Started     = $_.CreationDate
            CommandLine = $_.CommandLine
        }
    })

$pidFile = Join-Path $StateRoot "daemon.pid"
$portFile = Join-Path $StateRoot "port"
$recordedPid = if (Test-Path $pidFile) { (Get-Content $pidFile -Raw).Trim() } else { $null }

$result = [ordered]@{
    repoDir          = $RepoDir
    stateRoot        = $StateRoot
    servePath        = $servePath
    recordedPid      = $recordedPid
    found            = $found
    killed           = @()
    clearedDiscovery = $false
    respawnedPid     = $null
    respawnEnv       = $null
    dryRun           = (-not $Exec)
}

function Get-NodeExecutable {
    return (Get-Command node -ErrorAction Stop).Source
}

function Get-DevDaemonRespawnPlan {
    param([string]$ProjectRoot)

    $helperPath = Join-Path $PSScriptRoot "resolve-dev-daemon-env.mjs"
    $nodeExe = Get-NodeExecutable
    $resolveLines = & $nodeExe $helperPath $ProjectRoot 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "-Respawn dev-config resolution failed (exit $LASTEXITCODE): $resolveLines"
    }

    $parsed = ($resolveLines | Out-String).Trim() | ConvertFrom-Json
    if ($parsed.status -ne "applied") {
        $reasons = @($parsed.reasons) -join "; "
        throw "-Respawn requires applied dev config (status=$($parsed.status)): $reasons"
    }
    if (-not $parsed.env.AGENTS_COMM_BUS_BIN) {
        throw "-Respawn dev-config resolution missing AGENTS_COMM_BUS_BIN"
    }

    return $parsed
}

function Start-DevDaemonRespawn {
    param(
        [string]$DaemonBin,
        [hashtable]$RespawnEnv
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Get-NodeExecutable
    $psi.Arguments = "`"$DaemonBin`" serve"
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

    foreach ($key in [System.Environment]::GetEnvironmentVariables("Process").Keys) {
        $psi.EnvironmentVariables[$key] = [System.Environment]::GetEnvironmentVariable($key, "Process")
    }
    foreach ($entry in $RespawnEnv.GetEnumerator()) {
        $psi.EnvironmentVariables[$entry.Key] = $entry.Value
    }

    return [System.Diagnostics.Process]::Start($psi)
}

if (-not $Exec) {
    if ($Json) {
        $result | ConvertTo-Json -Depth 5
    }
    else {
        Write-Output "DRY RUN (pass -Exec to reap). serve.js = $servePath"
        Write-Output "Recorded daemon.pid = $recordedPid"
        if ($found.Count -eq 0) {
            Write-Output "No matching daemons running."
        }
        else {
            Write-Output "Would kill $($found.Count) daemon(s):"
            $found | ForEach-Object { Write-Output ("  PID {0}  started {1}{2}" -f $_.Pid, $_.Started, ($(if ("$($_.Pid)" -eq "$recordedPid") { '  <- recorded' } else { '' }))) }
        }
    }
    return
}

# --- Exec: reap every matching daemon ---
$killed = @()
foreach ($d in $found) {
    try {
        Stop-Process -Id $d.Pid -Force -ErrorAction Stop
        $killed += $d.Pid
        Write-Output ("Killed daemon PID {0} (started {1})" -f $d.Pid, $d.Started)
    }
    catch {
        Write-Warning "failed to kill PID $($d.Pid): $_"
    }
}
$result.killed = $killed

# Clear discovery only after the kills -- all of this repo's daemons are now dead,
# so removing the files cannot strand a live canonical daemon's discovery.
Remove-Item $pidFile -ErrorAction SilentlyContinue
Remove-Item $portFile -ErrorAction SilentlyContinue
$result.clearedDiscovery = $true

if ($Respawn) {
    $devPlan = Get-DevDaemonRespawnPlan -ProjectRoot $RepoDir
    $respawnEnv = @{}
    foreach ($prop in $devPlan.env.PSObject.Properties) {
        $respawnEnv[$prop.Name] = [string]$prop.Value
    }
    $result.respawnEnv = $respawnEnv

    $proc = Start-DevDaemonRespawn -DaemonBin $respawnEnv.AGENTS_COMM_BUS_BIN -RespawnEnv $respawnEnv
    $result.respawnedPid = $proc.Id
}

if ($Json) {
    $result | ConvertTo-Json -Depth 5
}
else {
    Write-Output ("Reaped {0} daemon(s): {1}" -f $killed.Count, ($(if ($killed.Count) { $killed -join ', ' } else { 'none' })))
    Write-Output "Cleared daemon.pid + port."
    if ($Respawn) {
        $envKeys = @($result.respawnEnv.Keys | Sort-Object) -join ", "
        Write-Output "Respawned fresh daemon PID $($result.respawnedPid) (env: $envKeys)"
    }
    else {
        Write-Output "No respawn -- the daemon will bootstrap lazily on the next hook/MCP call."
    }
}
