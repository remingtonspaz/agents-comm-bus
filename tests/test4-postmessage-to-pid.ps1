# Test 4: PostMessage WM_CHAR to a specific PID's window (simulates watcher targeting)
# Pass a PID as argument, and this script sends "." + Enter to it.
# This simulates exactly what the watcher would do.
#
# Run: powershell -ExecutionPolicy Bypass -File tests\test4-postmessage-to-pid.ps1 -TargetPid <PID>
#
# To find your Claude Code cmd.exe PID:
#   Get-Process -Name cmd | ForEach-Object { Write-Host "PID: $($_.Id) | Title: '$($_.MainWindowTitle)'" }

param(
    [Parameter(Mandatory=$true)]
    [int]$TargetPid
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PostMsg4 {
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
"@

$WM_CHAR = 0x0102
$VK_RETURN = 0x0D

Write-Host "=== Test 4: PostMessage to specific PID ==="
Write-Host ""

$proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "ERROR: Process $TargetPid not found" -ForegroundColor Red
    exit 1
}

Write-Host "Target: $($proc.ProcessName) (PID $TargetPid)"
Write-Host "Title:  '$($proc.MainWindowTitle)'"

$hwnd = $proc.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Host "ERROR: Process has no window handle" -ForegroundColor Red
    exit 1
}

Write-Host "Handle: $hwnd"
Write-Host "IsWindow: $([PostMsg4]::IsWindow($hwnd))"
Write-Host ""

$fgBefore = [PostMsg4]::GetForegroundWindow()
Write-Host "Foreground before: $fgBefore (is target: $($fgBefore -eq $hwnd))"
Write-Host ""

# Send "." + Enter (exactly what the watcher sends)
Write-Host "Sending '.' + Enter to PID $TargetPid..."

$dotResult = [PostMsg4]::PostMessage($hwnd, $WM_CHAR, [IntPtr][int][char]'.', [IntPtr]::Zero)
Write-Host "  '.' PostMessage result: $dotResult"
Start-Sleep -Milliseconds 50

$enterResult = [PostMsg4]::PostMessage($hwnd, $WM_CHAR, [IntPtr]$VK_RETURN, [IntPtr]::Zero)
Write-Host "  Enter PostMessage result: $enterResult"

Start-Sleep -Milliseconds 500

$fgAfter = [PostMsg4]::GetForegroundWindow()
Write-Host ""
Write-Host "Foreground after:  $fgAfter (is target: $($fgAfter -eq $hwnd))"
Write-Host "Focus preserved:   $($fgAfter -eq $fgBefore)" -ForegroundColor $(if ($fgAfter -eq $fgBefore) { "Green" } else { "Red" })
Write-Host ""
Write-Host "Check the target window - did '.' + Enter get delivered?"
