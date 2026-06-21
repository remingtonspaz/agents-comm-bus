# Claude wake watcher.
#
# This script is intentionally scoped to Claude Code wake/keystroke delivery.
# It watches a Claude wake directory for trigger files and sends characters to
# the target Claude window with PostMessage WM_CHAR. It does not own Telegram,
# comm routing, conversation state, or durable query state; those belong to the
# agents-comm-bus daemon.
#
# A caller may pass -SessionDir for transition compatibility. New callers should
# prefer ~/.agents-comm-bus/claude-wake/sessions/<session-key>.
#
# Usage:
#   Manual:     powershell -ExecutionPolicy Bypass -File enter-watcher.ps1
#   With handle: powershell -ExecutionPolicy Bypass -File enter-watcher.ps1 -WindowHandle 12345
#   With PID:   powershell -ExecutionPolicy Bypass -File enter-watcher.ps1 -TargetPid 12345
#   With wake dir: powershell -ExecutionPolicy Bypass -File enter-watcher.ps1 -SessionDir <path>

param(
    [int]$TargetPid = 0,
    [string]$MatchTitle = "",
    [long]$WindowHandle = 0,
    [string]$SessionDir = "",
    [int]$ClaudePid = 0
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
    // AGE-65: PostMessageW (not the default ANSI PostMessageA) so WM_CHAR carries
    // full UTF-16 code units — Latin-1 (<=0xFF) survives PostMessageA but em-dash,
    // smart quotes, emoji, CJK, etc. get dropped/truncated without the W variant.
    [DllImport("user32.dll", EntryPoint="PostMessageW")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$WM_CHAR = 0x0102
$VK_RETURN = 0x0D
$LPARAM_REPEAT_1 = [IntPtr]1
$CHAR_DELAY_MS = 2   # AGE-65: validated reliable to ~2000 chars; ~1ms drops at length

# Determine Claude wake/session directory. -SessionDir is kept as-is so legacy
# hooks that still pass ~/.claude-telegram/<session> continue to work during the
# transition release.
if ($SessionDir -ne "") {
    $sessionPath = $SessionDir
} else {
    $sessionPath = Join-Path $env:USERPROFILE ".agents-comm-bus\claude-wake\sessions\default"
}

$triggerFile = Join-Path $sessionPath "trigger-enter"
# Transition bridge files. They only tell the watcher what to type into Claude;
# they are not durable comm/query ownership state.
$permissionResponseFile = Join-Path $sessionPath "permission-response.json"
$slashCommandFile = Join-Path $sessionPath "slash-command.json"
# AGE-65: verbatim wake seed — the inbound message text the daemon dropped for a
# normal inbound wake. Typed in place of "." so the auto-mode classifier sees real
# intent. Consumed (deleted) on read; the UserPromptSubmit hook's inbound block
# remains the authoritative full-content + routing channel.
$seedFile = Join-Path $sessionPath "wake-seed.txt"
$debugLog = Join-Path $sessionPath "debug.log"

# Ensure directory exists
if (-not (Test-Path $sessionPath)) {
    New-Item -ItemType Directory -Path $sessionPath -Force | Out-Null
}

# Clean up any existing trigger file
if (Test-Path $triggerFile) {
    Remove-Item $triggerFile -Force
}

function Log($msg) {
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$timestamp] $msg"
    Write-Host $line
    try { Add-Content -Path $debugLog -Value $line -ErrorAction SilentlyContinue } catch {}
}

# AGE-65: Start-Sleep's timer granularity is ~15.6ms, so it can't honor the 2ms
# per-char delay (a long verbatim seed would take ~15ms/char ≈ 30s for 2000).
# Use a Stopwatch busy-wait for sub-15ms precision (validated reliable at 2ms).
$STOPWATCH_FREQ = [System.Diagnostics.Stopwatch]::Frequency
function Wait-PreciseMs([double]$ms) {
    if ($ms -le 0) { return }
    $targetTicks = [long]($ms * $STOPWATCH_FREQ / 1000)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedTicks -lt $targetTicks) {
        # AGE-65: yield the core each spin so a mid-type inbound (the daemon
        # processing it + claude.exe reading TUI input) isn't CPU-starved by a
        # pure busy-spin -> that starvation dropped chars (notably spaces) from
        # the in-flight typing during the concurrency test. Sleep(0) keeps ~2ms
        # timing when idle but relinquishes the core when others are ready.
        [System.Threading.Thread]::Sleep(0)
    }
}

# Send characters to a window handle via PostMessage WM_CHAR (no focus required)
function Send-PostMessageChars($hwnd, [string]$text) {
    foreach ($char in $text.ToCharArray()) {
        if ($char -eq "`r") { continue }  # belt: never let a stray CR fire Enter
        if ($char -eq "`n") {
            # AGE-65: newline -> backslash + Enter inserts a real newline in the
            # Claude TUI (line continuation) WITHOUT submitting. Risk: a dropped
            # backslash lets the Enter submit early, fragmenting the message.
            [Win32]::PostMessage($hwnd, $WM_CHAR, [IntPtr][int][char]'\', $LPARAM_REPEAT_1) | Out-Null
            Wait-PreciseMs $CHAR_DELAY_MS
            [Win32]::PostMessage($hwnd, $WM_CHAR, [IntPtr]$VK_RETURN, $LPARAM_REPEAT_1) | Out-Null
            Wait-PreciseMs $CHAR_DELAY_MS
            continue
        }
        $result = [Win32]::PostMessage($hwnd, $WM_CHAR, [IntPtr][int][char]$char, $LPARAM_REPEAT_1)
        if (-not $result) {
            Log "  PostMessage failed for char '$char'"
            return $false
        }
        Wait-PreciseMs $CHAR_DELAY_MS
    }
    # Send Enter
    $result = [Win32]::PostMessage($hwnd, $WM_CHAR, [IntPtr]$VK_RETURN, $LPARAM_REPEAT_1)
    if (-not $result) {
        Log "  PostMessage failed for Enter"
        return $false
    }
    return $true
}

# Handle AskUserQuestion: send option number directly
# (Permission is auto-approved by the hook, so question UI is already showing)
function Send-QuestionResponse($hwnd, [int]$optionNum) {
    Log "  Sending option number $optionNum..."
    Send-PostMessageChars $hwnd "$optionNum" | Out-Null
    return $true
}

# Resolve window handle from parameters
function Resolve-WindowHandle {
    if ($WindowHandle -gt 0) {
        $h = [IntPtr]$WindowHandle
        if ([Win32]::IsWindow($h)) { return $h }
        Log "WARNING: Window handle $WindowHandle is invalid"
    }

    if ($TargetPid -gt 0) {
        $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
        if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
            return $proc.MainWindowHandle
        }
    }

    if ($MatchTitle -ne "") {
        $proc = Get-Process -Name cmd -ErrorAction SilentlyContinue | Where-Object {
            $_.MainWindowTitle -like "*$MatchTitle*"
        } | Select-Object -First 1
        if (-not $proc) {
            $proc = Get-Process -Name WindowsTerminal, powershell, pwsh -ErrorAction SilentlyContinue | Where-Object {
                $_.MainWindowTitle -like "*$MatchTitle*"
            } | Select-Object -First 1
        }
        if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
            return $proc.MainWindowHandle
        }
    }

    # Search mode fallback
    $proc = Get-Process -Name cmd -ErrorAction SilentlyContinue | Where-Object {
        $title = $_.MainWindowTitle
        ($title -match '^[^a-zA-Z]' -or $title -match 'claude') -and
        $title -notmatch 'npm' -and
        $title -notmatch 'powershell'
    } | Select-Object -First 1
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
        return $proc.MainWindowHandle
    }

    return [IntPtr]::Zero
}

# Startup logging
$hwnd = Resolve-WindowHandle
if ($hwnd -ne [IntPtr]::Zero) {
    $procId = [uint32]0
    [Win32]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    Log "Watcher started: WindowHandle=$hwnd ProcessName=$($proc.ProcessName) PID=$procId"
} else {
    Log "Watcher started: No valid window handle yet (will resolve on trigger)"
}
Log "  ClaudeWakeDir=$sessionPath"
Log "  TriggerFile=$triggerFile"
Log "  ClaudePid=$ClaudePid"
Log "  Method=PostMessage WM_CHAR (focus-independent)"

$claudeCheckCounter = 0
$CLAUDE_CHECK_INTERVAL = 25  # Check every 25 iterations (~5 seconds at 200ms poll)

while ($true) {
    # Periodically check if claude.exe is still alive — exit if session ended
    if ($ClaudePid -gt 0) {
        $claudeCheckCounter++
        if ($claudeCheckCounter -ge $CLAUDE_CHECK_INTERVAL) {
            $claudeCheckCounter = 0
            $claudeProc = Get-Process -Id $ClaudePid -ErrorAction SilentlyContinue
            if (-not $claudeProc) {
                Log "Claude.exe (PID $ClaudePid) is no longer running. Exiting watcher."
                exit 0
            }
        }
    }

    # Periodically validate window handle
    if ($hwnd -ne [IntPtr]::Zero -and -not [Win32]::IsWindow($hwnd)) {
        Log "Target window closed. Will re-resolve on next trigger."
        $hwnd = [IntPtr]::Zero
    }

    if (Test-Path $triggerFile) {
        # Remove trigger file first
        Remove-Item $triggerFile -Force

        # Determine what to send. Query wake suppression and normal turn wake
        # policy are daemon/adapter decisions; this watcher only types the
        # requested wake or response characters after a trigger exists.
        $charsToSend = "."
        $logMessage = "Period+Enter"
        $promptType = "message"

        if (Test-Path $permissionResponseFile) {
            try {
                $responseContent = Get-Content $permissionResponseFile -Raw | ConvertFrom-Json
                $response = $responseContent.response
                $promptType = if ($responseContent.prompt_type) { $responseContent.prompt_type } else { "permission" }

                if ($promptType -eq "question" -and $response -match '^\d+$') {
                    $logMessage = "Question response: option $response"
                } elseif ($promptType -eq "freetext" -and $response) {
                    # Normalize newlines so we don't accidentally submit mid-reply.
                    $charsToSend = ($response -replace "[\r\n]+", " ").Trim()
                    $logMessage = "Freetext response: $charsToSend"
                } elseif ($response -eq "y" -or $response -eq "n" -or $response -eq "a") {
                    $charsToSend = $response
                    $logMessage = "Permission response: $response"
                }
                Remove-Item $permissionResponseFile -Force
            } catch {
                Log "WARNING: Failed to parse permission response"
            }
        } elseif (Test-Path $slashCommandFile) {
            try {
                $cmdContent = Get-Content $slashCommandFile -Raw | ConvertFrom-Json
                $cmdAge = (Get-Date) - [DateTime]::Parse($cmdContent.timestamp)
                if ($cmdAge.TotalSeconds -lt 60) {
                    $command = $cmdContent.command
                    $charsToSend = "/$command"
                    $logMessage = "Slash command: /$command"
                } else {
                    Log "WARNING: Stale slash command (age=$($cmdAge.TotalSeconds)s), discarding"
                }
                Remove-Item $slashCommandFile -Force
            } catch {
                Log "WARNING: Failed to parse slash command file"
            }
        } elseif (Test-Path $seedFile) {
            try {
                # AGE-65: type the decorated inbound message verbatim (bounded) so
                # the auto-mode classifier sees real intent + attribution instead
                # of ".". Newlines are PRESERVED and typed as backslash+Enter by
                # Send-PostMessageChars. Stale guard mirrors slash; consume on read.
                $seedAge = (Get-Date) - (Get-Item $seedFile).LastWriteTime
                if ($seedAge.TotalSeconds -lt 30) {
                    $seedText = (Get-Content $seedFile -Raw -Encoding UTF8).Trim()
                    if ($seedText.Length -gt 2000) { $seedText = $seedText.Substring(0, 2000) }
                    if ($seedText) {
                        $charsToSend = $seedText
                        $logMessage = "Wake seed ($($seedText.Length) chars)"
                    }
                } else {
                    Log "WARNING: Stale wake seed (age=$($seedAge.TotalSeconds)s), using '.'"
                }
                Remove-Item $seedFile -Force
            } catch {
                Log "WARNING: Failed to read wake seed"
            }
        }

        Log "Trigger detected! Sending $logMessage..."

        # Re-resolve handle if needed
        if ($hwnd -eq [IntPtr]::Zero) {
            $hwnd = Resolve-WindowHandle
        }

        if ($hwnd -ne [IntPtr]::Zero -and [Win32]::IsWindow($hwnd)) {
            $sent = $false

            if ($promptType -eq "question" -and $responseContent.response -match '^\d+$') {
                # AskUserQuestion: send option number directly (hook auto-approved)
                $optionNum = [int]$responseContent.response
                $sent = Send-QuestionResponse $hwnd $optionNum
                if ($sent) {
                    Log "  Selected option $optionNum via PostMessage (handle=$hwnd)"
                }
            } else {
                # Regular message or permission response
                $sent = Send-PostMessageChars $hwnd $charsToSend
                if ($sent) {
                    Log "  Sent via PostMessage WM_CHAR (handle=$hwnd)"
                }
            }

            if (-not $sent) {
                Log "  PostMessage failed, re-resolving handle..."
                $hwnd = Resolve-WindowHandle
                if ($hwnd -ne [IntPtr]::Zero) {
                    $sent = Send-PostMessageChars $hwnd $charsToSend
                    Log "  Retry result: sent=$sent (handle=$hwnd)"
                } else {
                    Log "  WARNING: Could not resolve window handle"
                }
            }
        } else {
            Log "WARNING: No valid window handle, cannot send"
        }
    }

    Start-Sleep -Milliseconds 200
}
