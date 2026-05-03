# Test 6: PostMessage WM_CHAR to Claude Code with correct lParam (repeat count = 1)
# Fix for test 5: lParam=0 caused repeat count of 65536
#
# Run from a SEPARATE terminal:
#   powershell -ExecutionPolicy Bypass -File tests\test6-postmessage-claude-fixed.ps1

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PostMsg6 {
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
$LPARAM_REPEAT_1 = [IntPtr]1  # repeat count = 1 (bits 0-15 of lParam)
$CHAR_DELAY_MS = 20

# Find session directories
$baseDir = "$env:USERPROFILE\.claude-telegram"
$sessionDirs = Get-ChildItem $baseDir -Directory -ErrorAction SilentlyContinue

Write-Host "=== Test 6: PostMessage to Claude Code (fixed repeat count) ==="
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
    Write-Host "ERROR: No sessions found" -ForegroundColor Red
    exit 1
}

Write-Host ""
$choice = Read-Host "Select session number (or Enter for 0)"
if ($choice -eq "") { $choice = 0 }
$selected = $sessions[[int]$choice]
$info = $selected.Info

# Get window handle
$hwnd = [IntPtr]::Zero
if ($info.windowHandle -and $info.windowHandle -gt 0) {
    $hwnd = [IntPtr]$info.windowHandle
} else {
    $proc = Get-Process -Id $info.cmdPid -ErrorAction SilentlyContinue
    if ($proc) { $hwnd = $proc.MainWindowHandle }
}

if ($hwnd -eq [IntPtr]::Zero -or -not [PostMsg6]::IsWindow($hwnd)) {
    Write-Host "ERROR: Invalid window handle" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Target: $($selected.Dir.Name) | hwnd=$hwnd"
Write-Host ""

Write-Host "Sending '.' + Enter in 3 seconds..." -ForegroundColor Yellow
Write-Host "(Keep THIS window focused)" -ForegroundColor Yellow
for ($i = 3; $i -gt 0; $i--) {
    Write-Host "  $i..."
    Start-Sleep -Seconds 1
}

# Send "." with repeat count = 1
Write-Host "Sending '.' (lParam=1)..."
$r1 = [PostMsg6]::PostMessage($hwnd, $WM_CHAR, [IntPtr][int][char]'.', $LPARAM_REPEAT_1)
Write-Host "  Result: $r1"
Start-Sleep -Milliseconds $CHAR_DELAY_MS

# Send Enter with repeat count = 1
Write-Host "Sending Enter (lParam=1)..."
$r2 = [PostMsg6]::PostMessage($hwnd, $WM_CHAR, [IntPtr]$VK_RETURN, $LPARAM_REPEAT_1)
Write-Host "  Result: $r2"

Start-Sleep -Milliseconds 500

$fgAfter = [PostMsg6]::GetForegroundWindow()
$myHwnd = [PostMsg6]::GetConsoleWindow()
Write-Host ""
Write-Host "Focus preserved: $($fgAfter -eq $myHwnd)" -ForegroundColor $(if ($fgAfter -eq $myHwnd) { "Green" } else { "Red" })
Write-Host ""
Write-Host "Check Claude Code window:"
Write-Host "  - Should show exactly ONE '.' submitted as a prompt"
Write-Host "  - This window should have stayed focused"
