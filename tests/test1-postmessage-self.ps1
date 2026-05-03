# Test 1: PostMessage WM_CHAR to our own console window
# Expected: Characters should appear in this console as if typed
#
# Run: powershell -ExecutionPolicy Bypass -File tests\test1-postmessage-self.ps1

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PostMsg {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
}
"@

$WM_CHAR = 0x0102
$WM_KEYDOWN = 0x0100
$WM_KEYUP = 0x0101
$VK_RETURN = 0x0D

$hwnd = [PostMsg]::GetConsoleWindow()
Write-Host "Console window handle: $hwnd"
Write-Host "IsWindow: $([PostMsg]::IsWindow($hwnd))"
Write-Host ""
Write-Host "Sending 'Hello' via PostMessage WM_CHAR to our own console..."
Write-Host "Characters should appear below this line:"
Write-Host "---"

Start-Sleep -Milliseconds 500

# Send each character of "Hello" + Enter
$text = "Hello"
foreach ($char in $text.ToCharArray()) {
    $result = [PostMsg]::PostMessage($hwnd, $WM_CHAR, [IntPtr][int][char]$char, [IntPtr]::Zero)
    Write-Host "  Sent '$char' (0x$([int][char]$char | ForEach-Object { $_.ToString('X2') })) -> result=$result" -ForegroundColor Gray
}

# Send Enter
$result = [PostMsg]::PostMessage($hwnd, $WM_CHAR, [IntPtr]$VK_RETURN, [IntPtr]::Zero)
Write-Host "  Sent Enter (0x0D) -> result=$result" -ForegroundColor Gray

Write-Host "---"
Write-Host "Done. Did 'Hello' appear in the console input line above?"
Start-Sleep -Seconds 3
