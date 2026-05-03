param([long]$Hwnd)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class TestWin32 {
    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    public const uint WM_CHAR = 0x0102;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
}
"@

$hwndPtr = [IntPtr]$Hwnd

Write-Host "Testing PostMessage to HWND $Hwnd"
Write-Host "  IsWindow: $([TestWin32]::IsWindow($hwndPtr))"

# Send '.' via WM_CHAR
$r1 = [TestWin32]::PostMessage($hwndPtr, [TestWin32]::WM_CHAR, [IntPtr][int][char]'.', [IntPtr]::Zero)
Write-Host "  PostMessage WM_CHAR '.': $r1"

# Send Enter via WM_KEYDOWN + WM_KEYUP
$r2 = [TestWin32]::PostMessage($hwndPtr, [TestWin32]::WM_KEYDOWN, [IntPtr]0x0D, [IntPtr]::Zero)
Write-Host "  PostMessage WM_KEYDOWN VK_RETURN: $r2"
$r3 = [TestWin32]::PostMessage($hwndPtr, [TestWin32]::WM_KEYUP, [IntPtr]0x0D, [IntPtr]::Zero)
Write-Host "  PostMessage WM_KEYUP VK_RETURN: $r3"
