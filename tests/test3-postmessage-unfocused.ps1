# Test 3: PostMessage WM_CHAR to another cmd.exe while THIS window stays focused
# This is the critical multi-session test: can we send input WITHOUT stealing focus?
#
# Run: powershell -ExecutionPolicy Bypass -File tests\test3-postmessage-unfocused.ps1

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PostMsg3 {
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

Write-Host "=== Test 3: Unfocused PostMessage ==="
Write-Host ""

# Spawn target cmd.exe
Write-Host "Spawning target cmd.exe..."
$proc = Start-Process -FilePath "cmd.exe" -PassThru
Start-Sleep -Seconds 1

$proc.Refresh()
$hwnd = $proc.MainWindowHandle

if ($hwnd -eq [IntPtr]::Zero) {
    Write-Host "ERROR: No window handle" -ForegroundColor Red
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "Target cmd.exe PID: $($proc.Id), Handle: $hwnd"
Write-Host ""

# Now click back to THIS window (give user time)
Write-Host ">>> CLICK ON THIS WINDOW NOW to make it focused <<<" -ForegroundColor Yellow
Write-Host ">>> You have 5 seconds... <<<" -ForegroundColor Yellow
for ($i = 5; $i -gt 0; $i--) {
    Write-Host "  $i..."
    Start-Sleep -Seconds 1
}

$myHwnd = [PostMsg3]::GetConsoleWindow()
$fgHwnd = [PostMsg3]::GetForegroundWindow()
Write-Host ""
Write-Host "My console handle:     $myHwnd"
Write-Host "Foreground handle:     $fgHwnd"
Write-Host "This window focused:   $($fgHwnd -eq $myHwnd)" -ForegroundColor $(if ($fgHwnd -eq $myHwnd) { "Green" } else { "Red" })
Write-Host ""

# Send text to the OTHER window while we're focused
Write-Host "Sending 'echo UNFOCUSED_TEST' + Enter to other cmd.exe (without focus change)..."

$text = "echo UNFOCUSED_TEST"
foreach ($char in $text.ToCharArray()) {
    [PostMsg3]::PostMessage($hwnd, $WM_CHAR, [IntPtr][int][char]$char, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Milliseconds 20
}
[PostMsg3]::PostMessage($hwnd, $WM_CHAR, [IntPtr]$VK_RETURN, [IntPtr]::Zero) | Out-Null

Start-Sleep -Milliseconds 500

# Check focus didn't change
$fgAfter = [PostMsg3]::GetForegroundWindow()
Write-Host ""
Write-Host "Foreground after send: $fgAfter"
Write-Host "Focus preserved:      $($fgAfter -eq $myHwnd)" -ForegroundColor $(if ($fgAfter -eq $myHwnd) { "Green" } else { "Red" })
Write-Host ""
Write-Host "Now check the OTHER cmd.exe window."
Write-Host "SUCCESS = 'UNFOCUSED_TEST' appears there AND this window kept focus."
Write-Host ""
Write-Host "Press any key to clean up..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
