# Test 5: PostMessage WM_CHAR to a live Claude Code session (unfocused)
# Reads the cmd.exe PID and window handle from the session-info.json
# Sends "." + Enter — exactly what the watcher would do to trigger Claude.
#
# Run from a SEPARATE terminal:
#   powershell -ExecutionPolicy Bypass -File tests\test5-postmessage-claude.ps1

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PostMsg5 {
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
}
"@

$WM_CHAR = 0x0102
$VK_RETURN = 0x0D
$CHAR_DELAY_MS = 20

# Find session directories
$baseDir = "$env:USERPROFILE\.claude-telegram"
$sessionDirs = Get-ChildItem $baseDir -Directory -ErrorAction SilentlyContinue

if (-not $sessionDirs) {
    Write-Host "ERROR: No session directories found in $baseDir" -ForegroundColor Red
    exit 1
}

Write-Host "=== Test 5: PostMessage to Live Claude Code Session ==="
Write-Host ""
Write-Host "Available sessions:"
$sessions = @()
$index = 0
foreach ($dir in $sessionDirs) {
    $infoFile = Join-Path $dir.FullName "session-info.json"
    if (Test-Path $infoFile) {
        $info = Get-Content $infoFile -Raw | ConvertFrom-Json
        $cmdProc = Get-Process -Id $info.cmdPid -ErrorAction SilentlyContinue
        $alive = if ($cmdProc) { "ALIVE" } else { "DEAD" }
        Write-Host "  [$index] $($dir.Name) | cmdPid=$($info.cmdPid) ($alive) | hwnd=$($info.windowHandle)"
        $sessions += @{ Dir = $dir; Info = $info; Alive = ($null -ne $cmdProc) }
        $index++
    }
}

if ($sessions.Count -eq 0) {
    Write-Host "ERROR: No sessions with session-info.json found" -ForegroundColor Red
    exit 1
}

Write-Host ""
$choice = Read-Host "Select session number (or Enter for 0)"
if ($choice -eq "") { $choice = 0 }
$selected = $sessions[[int]$choice]
$info = $selected.Info

Write-Host ""
Write-Host "Selected: $($selected.Dir.Name)"
Write-Host "  cmdPid: $($info.cmdPid)"
Write-Host "  windowHandle: $($info.windowHandle)"

# Determine window handle
$hwnd = [IntPtr]::Zero
if ($info.windowHandle -and $info.windowHandle -gt 0) {
    $hwnd = [IntPtr]$info.windowHandle
    Write-Host "  Using window handle from session-info.json"
} else {
    $proc = Get-Process -Id $info.cmdPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
        $hwnd = $proc.MainWindowHandle
        Write-Host "  Using window handle from Get-Process"
    }
}

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Host "ERROR: Could not get window handle" -ForegroundColor Red
    exit 1
}

Write-Host "  Final handle: $hwnd"
Write-Host "  IsWindow: $([PostMsg5]::IsWindow($hwnd))"
Write-Host ""

$myHwnd = [PostMsg5]::GetConsoleWindow()
$fgBefore = [PostMsg5]::GetForegroundWindow()
Write-Host "My console:       $myHwnd"
Write-Host "Foreground before: $fgBefore (is me: $($fgBefore -eq $myHwnd))"
Write-Host ""

# Countdown
Write-Host ">>> Make sure THIS window is focused (not the Claude Code window) <<<" -ForegroundColor Yellow
Write-Host ">>> Sending '.' + Enter in 3 seconds... <<<" -ForegroundColor Yellow
for ($i = 3; $i -gt 0; $i--) {
    Write-Host "  $i..."
    Start-Sleep -Seconds 1
}

# Send "." + Enter
Write-Host "Sending '.' ..."
$r1 = [PostMsg5]::PostMessage($hwnd, $WM_CHAR, [IntPtr][int][char]'.', [IntPtr]::Zero)
Write-Host "  Result: $r1"
Start-Sleep -Milliseconds $CHAR_DELAY_MS

Write-Host "Sending Enter..."
$r2 = [PostMsg5]::PostMessage($hwnd, $WM_CHAR, [IntPtr]$VK_RETURN, [IntPtr]::Zero)
Write-Host "  Result: $r2"

Start-Sleep -Milliseconds 500

$fgAfter = [PostMsg5]::GetForegroundWindow()
Write-Host ""
Write-Host "Foreground after:  $fgAfter (is me: $($fgAfter -eq $myHwnd))"
Write-Host "Focus preserved:   $($fgAfter -eq $fgBefore)" -ForegroundColor $(if ($fgAfter -eq $fgBefore) { "Green" } else { "Red" })
Write-Host ""
Write-Host "Check the Claude Code window:"
Write-Host "  - Did '.' appear as input?"
Write-Host "  - Did Claude Code process it as a prompt?"
Write-Host "  - Did THIS window remain focused?"
