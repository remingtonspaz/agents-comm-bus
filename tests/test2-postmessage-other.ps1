# Test 2: PostMessage WM_CHAR to ANOTHER cmd.exe window
# Spawns a new cmd.exe, waits for it to get a window, then sends characters to it.
# Expected: Characters should appear in the OTHER cmd.exe window.
#
# Run: powershell -ExecutionPolicy Bypass -File tests\test2-postmessage-other.ps1

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PostMsg2 {
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$WM_CHAR = 0x0102
$VK_RETURN = 0x0D

Write-Host "Spawning a new cmd.exe window..."
$proc = Start-Process -FilePath "cmd.exe" -PassThru
Write-Host "Spawned cmd.exe PID: $($proc.Id)"

# Wait for window handle
Write-Host "Waiting for window handle..."
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 200
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
        $hwnd = $proc.MainWindowHandle
        break
    }
}

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Host "ERROR: Could not get window handle for cmd.exe" -ForegroundColor Red
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "Window handle: $hwnd"
Write-Host "IsWindow: $([PostMsg2]::IsWindow($hwnd))"
Write-Host ""
Write-Host "Sending 'echo POSTMSG_TEST' + Enter to the other cmd.exe..."
Write-Host "(Watch the other cmd.exe window for output)"

Start-Sleep -Seconds 1

$text = "echo POSTMSG_TEST"
foreach ($char in $text.ToCharArray()) {
    [PostMsg2]::PostMessage($hwnd, $WM_CHAR, [IntPtr][int][char]$char, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 20
}

# Send Enter
[PostMsg2]::PostMessage($hwnd, $WM_CHAR, [IntPtr]$VK_RETURN, [IntPtr]::Zero) | Out-Null

Write-Host ""
Write-Host "Done. Check the other cmd.exe window - it should show 'POSTMSG_TEST'."
Write-Host "Press any key to close the spawned cmd.exe and exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
