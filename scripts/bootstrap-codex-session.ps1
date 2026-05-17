param(
    [string]$ProjectDir = (Get-Location).Path,
    [int]$Port = 0,
    [int]$MinPort = 4500,
    [int]$MaxPort = 4600,
    [int]$KillPid = 0,
    [string]$ThreadId = $env:CODEX_THREAD_ID,
    [ValidateSet("powershell", "pwsh", "cmd")]
    [string]$AppServerTerminal = "powershell",
    [string]$CodexCommand = "codex",
    [switch]$Exec,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

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

function Stop-CodexPid {
    param([int]$ProcessId)
    if ($ProcessId -le 0) {
        return
    }

    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        return
    }

    $commandLine = [string]$process.CommandLine
    if ($commandLine -notmatch "(?i)\bcodex(\.exe|\.js|\.cmd)?\b") {
        throw "Refusing to stop PID $ProcessId because it does not look like a Codex process: $commandLine"
    }

    Stop-Process -Id $ProcessId -Force
    Start-Sleep -Seconds 3
}

function ConvertTo-SingleQuotedPowerShellLiteral {
    param([string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
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

function New-AppServerWrapper {
    param(
        [string]$Project,
        [string]$Url,
        [string]$Session,
        [string]$Command,
        [string]$PidFile
    )

    $scriptPath = Join-Path ([System.IO.Path]::GetTempPath()) ("agents-comm-bus-codex-app-server-{0}.ps1" -f ([guid]::NewGuid().ToString("N")))
    $projectLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Project
    $urlLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Url
    $sessionLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Session
    $commandLiteral = ConvertTo-SingleQuotedPowerShellLiteral $Command
    $pidFileLiteral = ConvertTo-SingleQuotedPowerShellLiteral $PidFile

    $content = @"
`$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $projectLiteral
`$env:CODEX_APP_SERVER_URL = $urlLiteral
`$env:AGENTS_COMM_BUS_AGENT = "codex"
`$env:AGENTS_COMM_BUS_SESSION_ID = $sessionLiteral
if (-not [string]::IsNullOrWhiteSpace('$ThreadId')) {
    `$env:CODEX_THREAD_ID = '$ThreadId'
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

$resolvedProject = (Resolve-Path -LiteralPath $ProjectDir).Path
Stop-CodexPid -ProcessId $KillPid

$resolvedPort = Resolve-Port
$appServerUrl = "ws://127.0.0.1:$resolvedPort"
$sessionId = Get-StableCodexSessionId -Project $resolvedProject -Url $appServerUrl -Thread $ThreadId

$pidFile = Join-Path ([System.IO.Path]::GetTempPath()) ("agents-comm-bus-codex-app-server-{0}.pid" -f ([guid]::NewGuid().ToString("N")))
$wrapper = New-AppServerWrapper -Project $resolvedProject -Url $appServerUrl -Session $sessionId -Command $CodexCommand -PidFile $pidFile
$terminalProcess = Start-AppServerTerminal -Terminal $AppServerTerminal -WrapperPath $wrapper
$appServerPid = Wait-AppServerPid -PidFile $pidFile
if ($null -eq $appServerPid) {
    throw "Codex app-server did not report a PID within 5 seconds. Check the $AppServerTerminal app-server window."
}
if (-not (Wait-PortListening -ListenPort $resolvedPort)) {
    throw "Codex app-server PID $appServerPid did not start listening on $appServerUrl within 15 seconds."
}
$codexCommandLine = Format-CodexCommand -Command $CodexCommand -Url $appServerUrl -Thread $ThreadId

$result = [ordered]@{
    appServerUrl = $appServerUrl
    appServerPid = $appServerPid
    appServerTerminalPid = $terminalProcess.Id
    appServerTerminal = $AppServerTerminal
    sessionId = $sessionId
    projectDir = $resolvedProject
    threadId = if ([string]::IsNullOrWhiteSpace($ThreadId)) { $null } else { $ThreadId }
    codexCommand = $codexCommandLine
}

if ($Json) {
    $result | ConvertTo-Json -Depth 3
} else {
    Write-Host "Codex app-server:"
    Write-Host "  url: $appServerUrl"
    Write-Host "  pid: $(if ($null -eq $appServerPid) { 'unknown' } else { $appServerPid })"
    Write-Host "  terminal pid: $($terminalProcess.Id)"
    Write-Host "  session id: $sessionId"
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
    & $CodexCommand @codexArgs
}
