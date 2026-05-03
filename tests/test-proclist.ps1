param([int]$TargetPid)

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class TestConsole2 {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint GetConsoleProcessList(uint[] processList, uint processCount);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AllocConsole();
}
"@

[TestConsole2]::FreeConsole() | Out-Null
$r = [TestConsole2]::AttachConsole([uint32]$TargetPid)
if ($r) {
    $hwnd = [TestConsole2]::GetConsoleWindow()
    Write-Host "Console HWND: $($hwnd.ToInt64())"

    # Get all processes attached to this console
    [uint32[]]$pids = [uint32[]]::new(64)
    $count = [TestConsole2]::GetConsoleProcessList($pids, 64)
    Write-Host "Processes attached to this console ($count):"
    for ($i = 0; $i -lt $count; $i++) {
        $proc = Get-Process -Id $pids[$i] -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "  PID $($pids[$i]): $($proc.ProcessName)"
        } else {
            Write-Host "  PID $($pids[$i]): (not found)"
        }
    }
    [TestConsole2]::FreeConsole() | Out-Null
} else {
    Write-Host "AttachConsole failed"
}
[TestConsole2]::AllocConsole() | Out-Null
