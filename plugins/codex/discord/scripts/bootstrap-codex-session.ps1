param(
    [string]$ProjectDir = (Get-Location).Path,
    [int]$Port = 0,
    [int]$MinPort = 4500,
    [int]$MaxPort = 4600,
    [int]$KillPid = 0,
    [string]$ThreadId = $env:CODEX_THREAD_ID,
    [ValidateSet("powershell", "pwsh", "cmd")]
    [string]$AppServerTerminal = "powershell",
    [ValidateSet("auto", "cmd", "powershell", "pwsh", "bash")]
    [string]$HostShell = "auto",
    [string]$CodexCommand = "codex",
    [switch]$Exec,
    [switch]$Json,
    [switch]$RestartCurrent,
    [switch]$SameTerminal,
    [switch]$StopPreviousAppServer,
    [switch]$PlanOnly,
    [int]$RestartDelaySeconds = 2,
    [switch]$RestartBaton,
    [int]$RestartTargetPid = 0,
    [int]$RestartTerminalPid = 0,
    [string]$RestartCommandPath = ""
)

$ErrorActionPreference = "Stop"

function ConvertTo-SingleQuotedPowerShellLiteral {
    param([AllowNull()][string]$Value)
    if ($null -eq $Value) {
        return "''"
    }
    return "'" + ($Value -replace "'", "''") + "'"
}

function ConvertTo-DoubleQuotedCmdLiteral {
    param([string]$Value)
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Test-PortAvailable {
    param([int]$CandidatePort)
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $CandidatePort)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $listener) {
            $listener.Stop()
        }
    }
}

function Resolve-Port {
    if ($Port -gt 0) {
        if (-not (Test-PortAvailable -CandidatePort $Port)) {
            throw "Port $Port is not available."
        }
        return $Port
    }

    foreach ($candidate in $MinPort..$MaxPort) {
        if (Test-PortAvailable -CandidatePort $candidate) {
            return $candidate
        }
    }

    throw "No free port found in range $MinPort-$MaxPort."
}

function Get-ChildProcessIds {
    param([int]$ParentPid)

    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentPid" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
        [int]$child.ProcessId
        Get-ChildProcessIds -ParentPid ([int]$child.ProcessId)
    }
}

function Get-AncestorProcessIds {
    param([int]$ProcessId)

    $ancestors = @()
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    while ($null -ne $current -and [int]$current.ParentProcessId -gt 0) {
        $parentId = [int]$current.ParentProcessId
        $ancestors += $parentId
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
    }
    return $ancestors
}

function Test-CodexLikeProcess {
    param([int]$ProcessId)

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $false
    }

    $commandLine = [string]$process.CommandLine
    $name = [string]$process.Name
    return ($name -match "(?i)^codex(\.exe)?$" -or $commandLine -match "(?i)\bcodex(\.exe|\.js|\.cmd|\.ps1)?\b")
}

function Stop-CodexTree {
    param(
        [int]$ProcessId,
        [int[]]$ProtectedPids = @()
    )
    if ($ProcessId -le 0) {
        return
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return
    }

    if (-not (Test-CodexLikeProcess -ProcessId $ProcessId)) {
        throw "Refusing to stop PID $ProcessId because it does not look like a Codex process: $($process.CommandLine)"
    }

    $descendants = @(Get-ChildProcessIds -ParentPid $ProcessId)
    [Array]::Reverse($descendants)
    $protected = @{}
    foreach ($protectedPid in $ProtectedPids) {
        if ($protectedPid -gt 0) {
            $protected[$protectedPid] = $true
        }
    }
    foreach ($descendantPid in $descendants) {
        if ($protected.ContainsKey($descendantPid)) {
            continue
        }
        Stop-Process -Id $descendantPid -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

function Stop-CodexPid {
    param([int]$ProcessId)
    Stop-CodexTree -ProcessId $ProcessId
}

function Get-StableCodexSessionId {
    param(
        [string]$Project,
        [string]$Url,
        [string]$Thread
    )

    $raw = if (-not [string]::IsNullOrWhiteSpace($Thread)) {
        $Thread
    } else {
        "${Project}:${Url}"
    }

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($raw)
        $hash = $sha.ComputeHash($bytes)
        $hex = -join ($hash | ForEach-Object { $_.ToString("x2") })
        return "codex_" + $hex.Substring(0, 24)
    } finally {
        $sha.Dispose()
    }
}

function Get-StateRoot {
    $root = Join-Path $env:USERPROFILE ".agents-comm-bus\codex-bootstrapper"
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    return $root
}

function Get-SessionStatePath {
    param([string]$SessionId)
    $sessions = Join-Path (Get-StateRoot) "sessions"
    New-Item -ItemType Directory -Force -Path $sessions | Out-Null
    return Join-Path $sessions "$SessionId.json"
}

function Read-SessionState {
    param([string]$SessionId)
    $path = Get-SessionStatePath -SessionId $SessionId
    if (-not (Test-Path -LiteralPath $path)) {
        return $null
    }
    try {
        return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Write-SessionState {
    param([hashtable]$State)
    $path = Get-SessionStatePath -SessionId $State.sessionId
    $State | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding utf8
}

function Test-AppServerProcess {
    param(
        [int]$ProcessId,
        [AllowNull()][string]$Url
    )

    if ($ProcessId -le 0) {
        return $false
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $false
    }

    $commandLine = [string]$process.CommandLine
    if ($commandLine -notmatch "(?i)\bapp-server\b" -or $commandLine -notmatch "(?i)--listen") {
        return $false
    }

    if (-not [string]::IsNullOrWhiteSpace($Url) -and $commandLine -notlike "*$Url*") {
        return $false
    }

    return $true
}

function Test-AppServerTerminalProcess {
    param(
        [int]$ProcessId,
        [AllowNull()][string]$WrapperPath
    )

    if ($ProcessId -le 0) {
        return $false
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return $false
    }

    $commandLine = [string]$process.CommandLine
    if ($commandLine -notmatch "(?i)(powershell|pwsh|cmd)") {
        return $false
    }

    if (-not [string]::IsNullOrWhiteSpace($WrapperPath) -and $commandLine -notlike "*$WrapperPath*") {
        return $false
    }

    return $true
}

function Stop-TrackedAppServer {
    param([string]$SessionId)

    $state = Read-SessionState -SessionId $SessionId
    if ($null -eq $state) {
        return $null
    }

    $stopped = [ordered]@{
        appServerPid = $null
        appServerTerminalPid = $null
    }

    $appServerPid = 0
    if ($null -ne $state.appServerPid) {
        $appServerPid = [int]$state.appServerPid
    }
    $appServerUrl = ""
    if ($null -ne $state.appServerUrl) {
        $appServerUrl = [string]$state.appServerUrl
    }
    if (Test-AppServerProcess -ProcessId $appServerPid -Url $appServerUrl) {
        Stop-CodexTree -ProcessId $appServerPid
        $stopped.appServerPid = $appServerPid
    }

    Start-Sleep -Milliseconds 500

    $terminalPid = 0
    if ($null -ne $state.appServerTerminalPid) {
        $terminalPid = [int]$state.appServerTerminalPid
    }
    $wrapperPath = ""
    if ($null -ne $state.wrapperPath) {
        $wrapperPath = [string]$state.wrapperPath
    }
    if (Test-AppServerTerminalProcess -ProcessId $terminalPid -WrapperPath $wrapperPath) {
        Stop-Process -Id $terminalPid -Force -ErrorAction SilentlyContinue
        $stopped.appServerTerminalPid = $terminalPid
    }

    return $stopped
}

function New-AppServerWrapper {
    param(
        [string]$Project,
        [string]$Url,
        [string]$Session,
        [string]$Command,
        [string]$PidFile,
        [string]$Thread
    )

    $scriptPath = Join-Path ([System.IO.Path]::GetTempPath()) ("agents-comm-bus-codex-app-server-{0}.ps1" -f ([guid]::NewGuid().ToString("N")))
    $projectLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Project
    $urlLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Url
    $sessionLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Session
    $commandLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Command
    $pidFileLiteral = ConvertTo-SingleQuotedPowerShellLiteral $PidFile
    $threadLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Thread

    $content = @"
`$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $projectLiteral
`$env:CODEX_APP_SERVER_URL = $urlLiteral
`$env:AGENTS_COMM_BUS_AGENT = "codex"
`$env:AGENTS_COMM_BUS_SESSION_ID = $sessionLiteral
if (-not [string]::IsNullOrWhiteSpace($threadLiteral)) {
    `$env:CODEX_THREAD_ID = $threadLiteral
}
Write-Host "Starting Codex app-server on $Url"
`$commandInfo = Get-Command $commandLiteral -ErrorAction Stop | Select-Object -First 1
`$commandPath = if (`$commandInfo.Source) { `$commandInfo.Source } else { `$commandInfo.Definition }
if (`$commandPath -like "*.ps1") {
    `$filePath = "powershell.exe"
    `$argumentList = @("-ExecutionPolicy", "Bypass", "-File", `$commandPath, "app-server", "--listen", $urlLiteral)
} else {
    `$filePath = `$commandPath
    `$argumentList = @("app-server", "--listen", $urlLiteral)
}
`$p = Start-Process -FilePath `$filePath -ArgumentList `$argumentList -NoNewWindow -PassThru
Set-Content -LiteralPath $pidFileLiteral -Value `$p.Id -Encoding ascii
Write-Host "Codex app-server PID: `$(`$p.Id)"
Wait-Process -Id `$p.Id
"@

    Set-Content -LiteralPath $scriptPath -Value $content -Encoding utf8
    return $scriptPath
}

function Start-AppServerTerminal {
    param(
        [string]$Terminal,
        [string]$WrapperPath
    )

    switch ($Terminal) {
        "powershell" {
            return Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-ExecutionPolicy", "Bypass", "-File", $WrapperPath) -PassThru
        }
        "pwsh" {
            return Start-Process -FilePath "pwsh.exe" -ArgumentList @("-NoExit", "-File", $WrapperPath) -PassThru
        }
        "cmd" {
            $cmd = 'powershell.exe -NoExit -ExecutionPolicy Bypass -File "{0}"' -f ($WrapperPath -replace '"', '\"')
            return Start-Process -FilePath "cmd.exe" -ArgumentList @("/k", $cmd) -PassThru
        }
    }
}

function Wait-AppServerPid {
    param(
        [string]$PidFile,
        [int]$TimeoutMs = 5000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-Path -LiteralPath $PidFile) {
            $raw = (Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
            $parsed = 0
            if ([int]::TryParse([string]$raw, [ref]$parsed)) {
                return $parsed
            }
        }
        Start-Sleep -Milliseconds 100
    }
    return $null
}

function Wait-PortListening {
    param(
        [int]$ListenPort,
        [int]$TimeoutMs = 15000
    )

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $client = $null
        try {
            $client = [System.Net.Sockets.TcpClient]::new()
            $connect = $client.BeginConnect("127.0.0.1", $ListenPort, $null, $null)
            if ($connect.AsyncWaitHandle.WaitOne(250)) {
                $client.EndConnect($connect)
                return $true
            }
        } catch {
        } finally {
            if ($null -ne $client) {
                $client.Close()
            }
        }
        Start-Sleep -Milliseconds 150
    }
    return $false
}

function Format-CodexCommand {
    param(
        [string]$Command,
        [string]$Url,
        [string]$Thread
    )

    if (-not [string]::IsNullOrWhiteSpace($Thread)) {
        return "$Command resume $Thread --remote $Url"
    }
    return "$Command --remote $Url"
}

function Get-ProcessInfo {
    param([int]$ProcessId)
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Find-CurrentCodexProcess {
    $current = Get-ProcessInfo -ProcessId $PID
    $candidate = $null
    while ($null -ne $current -and [int]$current.ParentProcessId -gt 0) {
        $parent = Get-ProcessInfo -ProcessId ([int]$current.ParentProcessId)
        if ($null -eq $parent) {
            break
        }

        $name = [string]$parent.Name
        $commandLine = [string]$parent.CommandLine
        if ($name -match "(?i)^codex(\.exe)?$" -or $commandLine -match "(?i)\bcodex(\.exe|\.js|\.cmd|\.ps1)?\b") {
            $candidate = $parent
        }

        $current = $parent
    }
    return $candidate
}

function Find-TerminalForProcess {
    param([int]$ProcessId)

    $current = Get-ProcessInfo -ProcessId $ProcessId
    $fallback = $null
    while ($null -ne $current -and [int]$current.ParentProcessId -gt 0) {
        $parent = Get-ProcessInfo -ProcessId ([int]$current.ParentProcessId)
        if ($null -eq $parent) {
            break
        }

        $name = [string]$parent.Name
        if ($name -match "(?i)^(cmd|powershell|pwsh|bash|sh|zsh|fish|mintty|wezterm-gui|WindowsTerminal)\.exe$") {
            if ($null -eq $fallback) {
                $fallback = $parent
            }
            $process = Get-Process -Id ([int]$parent.ProcessId) -ErrorAction SilentlyContinue
            if ($null -ne $process -and $process.MainWindowHandle -ne 0) {
                return $parent
            }
        }

        $current = $parent
    }
    return $fallback
}

function Resolve-HostShell {
    param(
        [string]$RequestedShell,
        [object]$Terminal
    )

    if ($RequestedShell -ne "auto") {
        return $RequestedShell
    }

    $name = if ($null -ne $Terminal) { [string]$Terminal.Name } else { "" }
    if ($name -match "(?i)^cmd\.exe$") {
        return "cmd"
    }
    if ($name -match "(?i)^pwsh\.exe$") {
        return "pwsh"
    }
    if ($name -match "(?i)^powershell\.exe$") {
        return "powershell"
    }
    if ($name -match "(?i)^(bash|sh|zsh|fish|mintty)\.exe$") {
        return "bash"
    }
    return "cmd"
}

function New-RelayScripts {
    param(
        [string]$BootstrapperPath,
        [string]$Project,
        [int]$ChosenPort,
        [int]$Min,
        [int]$Max,
        [string]$Thread,
        [string]$Terminal,
        [string]$Command,
        [bool]$RunExec,
        [bool]$RunJson,
        [bool]$StopPrevious
    )

    $id = [guid]::NewGuid().ToString("N")
    $ps1Path = Join-Path ([System.IO.Path]::GetTempPath()) "agents-comm-bus-codex-restart-$id.ps1"
    $cmdPath = Join-Path ([System.IO.Path]::GetTempPath()) "agents-comm-bus-codex-restart-$id.cmd"

    $scriptLiteral = ConvertTo-SingleQuotedPowerShellLiteral $BootstrapperPath
    $projectLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Project
    $terminalLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Terminal
    $commandLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Command
    $threadLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Thread

    $lines = @(
        '$ErrorActionPreference = "Stop"',
        "Set-Location -LiteralPath $projectLiteral",
        '$paramsForBootstrapper = @{}',
        ('$paramsForBootstrapper.ProjectDir = {0}' -f $projectLiteral),
        ('$paramsForBootstrapper.MinPort = {0}' -f $Min),
        ('$paramsForBootstrapper.MaxPort = {0}' -f $Max),
        ('$paramsForBootstrapper.AppServerTerminal = {0}' -f $terminalLiteral),
        ('$paramsForBootstrapper.CodexCommand = {0}' -f $commandLiteral)
    )
    if ($ChosenPort -gt 0) {
        $lines += ('$paramsForBootstrapper.Port = {0}' -f $ChosenPort)
    }
    if (-not [string]::IsNullOrWhiteSpace($Thread)) {
        $lines += ('$paramsForBootstrapper.ThreadId = {0}' -f $threadLiteral)
    }
    if ($RunExec) {
        $lines += '$paramsForBootstrapper.Exec = $true'
    }
    if ($RunJson) {
        $lines += '$paramsForBootstrapper.Json = $true'
    }
    if ($StopPrevious) {
        $lines += '$paramsForBootstrapper.StopPreviousAppServer = $true'
    }
    $lines += "& $scriptLiteral @paramsForBootstrapper"
    Set-Content -LiteralPath $ps1Path -Value ($lines -join [Environment]::NewLine) -Encoding utf8

    $cmdScript = "@echo off`r`npowershell.exe -NoExit -ExecutionPolicy Bypass -File $(ConvertTo-DoubleQuotedCmdLiteral $ps1Path)`r`n"
    Set-Content -LiteralPath $cmdPath -Value $cmdScript -Encoding ascii

    return [ordered]@{
        ps1 = $ps1Path
        cmd = $cmdPath
    }
}

function New-RestartBaton {
    param(
        [int]$TargetPid,
        [int]$TerminalPid,
        [string]$CommandPath,
        [string]$Shell,
        [int]$DelaySeconds
    )

    $batonPath = Join-Path ([System.IO.Path]::GetTempPath()) ("agents-comm-bus-codex-restart-baton-{0}.ps1" -f ([guid]::NewGuid().ToString("N")))
    $logPath = Join-Path (Get-StateRoot) "restart-baton.log"
    $commandLiteral = ConvertTo-SingleQuotedPowerShellLiteral $CommandPath
    $shellLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Shell
    $logLiteral = ConvertTo-SingleQuotedPowerShellLiteral $logPath

    $content = @"
param()
`$ErrorActionPreference = "Stop"
try {
    "[$([DateTime]::UtcNow.ToString("o"))] scheduled target=$TargetPid terminal=$TerminalPid command=$CommandPath shell=$Shell" | Add-Content -LiteralPath $logLiteral
    Start-Sleep -Seconds $DelaySeconds
    & $(ConvertTo-SingleQuotedPowerShellLiteral $PSCommandPath) -RestartBaton -RestartTargetPid $TargetPid -RestartTerminalPid $TerminalPid -RestartCommandPath $commandLiteral -HostShell $shellLiteral
    "[$([DateTime]::UtcNow.ToString("o"))] completed target=$TargetPid" | Add-Content -LiteralPath $logLiteral
} catch {
    "[$([DateTime]::UtcNow.ToString("o"))] failed target=$TargetPid error=`$(`$_.Exception.Message)" | Add-Content -LiteralPath $logLiteral
    throw
}
"@

    Set-Content -LiteralPath $batonPath -Value $content -Encoding utf8
    return $batonPath
}

function Send-CommandToTerminal {
    param(
        [int]$TerminalPid,
        [string]$Command,
        [int]$TimeoutMs = 10000
    )

    $source = @"
using System;
using System.Runtime.InteropServices;
public static class ConsolePostMessage {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@
    Add-Type -TypeDefinition $source -ErrorAction SilentlyContinue
    $wmChar = 0x0102
    $enter = 13
    $repeatOne = [IntPtr]1

    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    $handle = [IntPtr]::Zero
    while ([DateTime]::UtcNow -lt $deadline) {
        $process = Get-Process -Id $TerminalPid -ErrorAction SilentlyContinue
        if ($null -ne $process -and $process.MainWindowHandle -ne 0) {
            $handle = [IntPtr]$process.MainWindowHandle
            break
        }
        Start-Sleep -Milliseconds 150
    }

    if ($handle -eq [IntPtr]::Zero) {
        throw "Could not find a window handle for terminal PID $TerminalPid."
    }

    foreach ($char in $Command.ToCharArray()) {
        [ConsolePostMessage]::PostMessage($handle, $wmChar, [IntPtr][int][char]$char, $repeatOne) | Out-Null
        Start-Sleep -Milliseconds 8
    }
    [ConsolePostMessage]::PostMessage($handle, $wmChar, [IntPtr]$enter, $repeatOne) | Out-Null
}

function Invoke-RestartBaton {
    param(
        [int]$TargetPid,
        [int]$TerminalPid,
        [string]$CommandPath,
        [string]$Shell
    )

    $protectedPids = @([int]$PID) + @(Get-AncestorProcessIds -ProcessId $PID)
    Stop-CodexTree -ProcessId $TargetPid -ProtectedPids $protectedPids
    Start-Sleep -Seconds 2

    $typedCommand = switch ($Shell) {
        "cmd" { ConvertTo-DoubleQuotedCmdLiteral $CommandPath }
        "powershell" { "& " + (ConvertTo-SingleQuotedPowerShellLiteral $CommandPath) }
        "pwsh" { "& " + (ConvertTo-SingleQuotedPowerShellLiteral $CommandPath) }
        "bash" { "powershell.exe -NoExit -ExecutionPolicy Bypass -File " + (ConvertTo-DoubleQuotedCmdLiteral $CommandPath) }
        default { ConvertTo-DoubleQuotedCmdLiteral $CommandPath }
    }

    Send-CommandToTerminal -TerminalPid $TerminalPid -Command $typedCommand
}

function Start-SameTerminalRestart {
    param(
        [string]$ResolvedProject
    )

    $target = if ($KillPid -gt 0) {
        Get-ProcessInfo -ProcessId $KillPid
    } else {
        Find-CurrentCodexProcess
    }

    if ($null -eq $target) {
        throw "Could not discover the current Codex process. Pass -KillPid explicitly."
    }

    $terminal = Find-TerminalForProcess -ProcessId ([int]$target.ProcessId)
    if ($null -eq $terminal) {
        throw "Could not discover the terminal hosting Codex PID $($target.ProcessId)."
    }

    $resolvedShell = Resolve-HostShell -RequestedShell $HostShell -Terminal $terminal
    $bootstrapperPath = $PSCommandPath
    $relays = New-RelayScripts `
        -BootstrapperPath $bootstrapperPath `
        -Project $ResolvedProject `
        -ChosenPort $Port `
        -Min $MinPort `
        -Max $MaxPort `
        -Thread $ThreadId `
        -Terminal $AppServerTerminal `
        -Command $CodexCommand `
        -RunExec ([bool]$Exec) `
        -RunJson ([bool]$Json) `
        -StopPrevious $true

    $commandPath = if ($resolvedShell -eq "cmd") { $relays.cmd } else { $relays.ps1 }
    $batonPath = $null
    $baton = $null
    if (-not $PlanOnly) {
        $batonPath = New-RestartBaton `
            -TargetPid ([int]$target.ProcessId) `
            -TerminalPid ([int]$terminal.ProcessId) `
            -CommandPath $commandPath `
            -Shell $resolvedShell `
            -DelaySeconds $RestartDelaySeconds

        $baton = Start-Process -FilePath "powershell.exe" `
            -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $batonPath) `
            -WindowStyle Hidden `
            -PassThru
    }

    $result = [ordered]@{
        restartScheduled = -not [bool]$PlanOnly
        restartMode = "same-terminal"
        codexPid = [int]$target.ProcessId
        terminalPid = [int]$terminal.ProcessId
        hostShell = $resolvedShell
        relayPath = $commandPath
        batonPid = if ($null -eq $baton) { $null } else { $baton.Id }
        batonPath = $batonPath
    }

    if ($Json) {
        $result | ConvertTo-Json -Depth 4
    } else {
        if ($PlanOnly) {
            Write-Host "Planned same-terminal Codex restart:"
        } else {
            Write-Host "Scheduled same-terminal Codex restart:"
        }
        Write-Host "  codex pid: $($target.ProcessId)"
        Write-Host "  terminal pid: $($terminal.ProcessId)"
        Write-Host "  host shell: $resolvedShell"
        Write-Host "  relay: $commandPath"
        if ($null -ne $baton) {
            Write-Host "  baton pid: $($baton.Id)"
        }
    }
}

if ($RestartBaton) {
    Invoke-RestartBaton -TargetPid $RestartTargetPid -TerminalPid $RestartTerminalPid -CommandPath $RestartCommandPath -Shell $HostShell
    exit 0
}

$resolvedProject = (Resolve-Path -LiteralPath $ProjectDir).Path

if ($RestartCurrent -and $SameTerminal) {
    Start-SameTerminalRestart -ResolvedProject $resolvedProject
    exit 0
}

Stop-CodexPid -ProcessId $KillPid

if ($StopPreviousAppServer -and -not [string]::IsNullOrWhiteSpace($ThreadId)) {
    $previousSessionId = Get-StableCodexSessionId -Project $resolvedProject -Url "" -Thread $ThreadId
    Stop-TrackedAppServer -SessionId $previousSessionId | Out-Null
}

$resolvedPort = Resolve-Port
$appServerUrl = "ws://127.0.0.1:$resolvedPort"
$sessionId = Get-StableCodexSessionId -Project $resolvedProject -Url $appServerUrl -Thread $ThreadId

if ($StopPreviousAppServer -and [string]::IsNullOrWhiteSpace($ThreadId)) {
    Stop-TrackedAppServer -SessionId $sessionId | Out-Null
}

$pidFile = Join-Path ([System.IO.Path]::GetTempPath()) ("agents-comm-bus-codex-app-server-{0}.pid" -f ([guid]::NewGuid().ToString("N")))
$wrapper = New-AppServerWrapper -Project $resolvedProject -Url $appServerUrl -Session $sessionId -Command $CodexCommand -PidFile $pidFile -Thread $ThreadId
$terminalProcess = Start-AppServerTerminal -Terminal $AppServerTerminal -WrapperPath $wrapper
$appServerPid = Wait-AppServerPid -PidFile $pidFile
if ($null -eq $appServerPid) {
    throw "Codex app-server did not report a PID within 5 seconds. Check the $AppServerTerminal app-server window."
}
if (-not (Wait-PortListening -ListenPort $resolvedPort)) {
    throw "Codex app-server PID $appServerPid did not start listening on $appServerUrl within 15 seconds."
}
$codexCommandLine = Format-CodexCommand -Command $CodexCommand -Url $appServerUrl -Thread $ThreadId

$state = @{
    appServerUrl = $appServerUrl
    appServerPid = $appServerPid
    appServerTerminalPid = $terminalProcess.Id
    appServerTerminal = $AppServerTerminal
    sessionId = $sessionId
    projectDir = $resolvedProject
    threadId = if ([string]::IsNullOrWhiteSpace($ThreadId)) { $null } else { $ThreadId }
    wrapperPath = $wrapper
    pidFile = $pidFile
    startedAt = [DateTime]::UtcNow.ToString("o")
    bootstrapperPid = $PID
}
Write-SessionState -State $state

$result = [ordered]@{
    appServerUrl = $appServerUrl
    appServerPid = $appServerPid
    appServerTerminalPid = $terminalProcess.Id
    appServerTerminal = $AppServerTerminal
    sessionId = $sessionId
    projectDir = $resolvedProject
    threadId = if ([string]::IsNullOrWhiteSpace($ThreadId)) { $null } else { $ThreadId }
    codexCommand = $codexCommandLine
    statePath = Get-SessionStatePath -SessionId $sessionId
}

if ($Json) {
    $result | ConvertTo-Json -Depth 3
} else {
    Write-Host "Codex app-server:"
    Write-Host "  url: $appServerUrl"
    Write-Host "  pid: $(if ($null -eq $appServerPid) { 'unknown' } else { $appServerPid })"
    Write-Host "  terminal pid: $($terminalProcess.Id)"
    Write-Host "  session id: $sessionId"
    Write-Host "  state: $(Get-SessionStatePath -SessionId $sessionId)"
    Write-Host ""
    Write-Host "Codex command:"
    Write-Host "  `$env:CODEX_APP_SERVER_URL = '$appServerUrl'"
    Write-Host "  `$env:AGENTS_COMM_BUS_AGENT = 'codex'"
    Write-Host "  `$env:AGENTS_COMM_BUS_SESSION_ID = '$sessionId'"
    Write-Host "  $codexCommandLine"
}

if ($Exec) {
    $env:CODEX_APP_SERVER_URL = $appServerUrl
    $env:AGENTS_COMM_BUS_AGENT = "codex"
    $env:AGENTS_COMM_BUS_SESSION_ID = $sessionId
    if (-not [string]::IsNullOrWhiteSpace($ThreadId)) {
        $env:CODEX_THREAD_ID = $ThreadId
    }
    Set-Location -LiteralPath $resolvedProject
    $codexArgs = @()
    if (-not [string]::IsNullOrWhiteSpace($ThreadId)) {
        $codexArgs += @("resume", $ThreadId)
    }
    $codexArgs += @("--remote", $appServerUrl)
    $codexExitCode = 0
    try {
        & $CodexCommand @codexArgs
        if ($null -ne $LASTEXITCODE) {
            $codexExitCode = [int]$LASTEXITCODE
        }
    } finally {
        Stop-TrackedAppServer -SessionId $sessionId | Out-Null
    }
    exit $codexExitCode
}
