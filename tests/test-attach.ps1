param([int]$TargetPid)

Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Explicit, Size = 16)]
public struct KEY_EVENT_RECORD2 {
    [FieldOffset(0)] public int bKeyDown;         // BOOL = 4 bytes (not C# bool which is 1 byte!)
    [FieldOffset(4)] public ushort wRepeatCount;
    [FieldOffset(6)] public ushort wVirtualKeyCode;
    [FieldOffset(8)] public ushort wVirtualScanCode;
    [FieldOffset(10)] public char UnicodeChar;
    [FieldOffset(12)] public uint dwControlKeyState;
}

[StructLayout(LayoutKind.Explicit, Size = 20)]
public struct INPUT_RECORD2 {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD2 KeyEvent;
}

public class TestConsoleApi2 {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool WriteConsoleInputW(IntPtr hConsoleInput, INPUT_RECORD2[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")]
    public static extern uint MapVirtualKeyW(uint uCode, uint uMapType);
    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 1;
    public const uint FILE_SHARE_WRITE = 2;
    public const uint OPEN_EXISTING = 3;
    public const ushort KEY_EVENT = 1;
}
"@

Write-Host "Targeting PID: $TargetPid"
Write-Host "Struct sizes: KEY_EVENT_RECORD2=$([System.Runtime.InteropServices.Marshal]::SizeOf([type][KEY_EVENT_RECORD2])) INPUT_RECORD2=$([System.Runtime.InteropServices.Marshal]::SizeOf([type][INPUT_RECORD2]))"

[TestConsoleApi2]::FreeConsole() | Out-Null
$r = [TestConsoleApi2]::AttachConsole([uint32]$TargetPid)
Write-Host "AttachConsole: $r"

if ($r) {
    $handle = [TestConsoleApi2]::CreateFileW("CONIN$", [TestConsoleApi2]::GENERIC_READ -bor [TestConsoleApi2]::GENERIC_WRITE, [TestConsoleApi2]::FILE_SHARE_READ -bor [TestConsoleApi2]::FILE_SHARE_WRITE, [IntPtr]::Zero, [TestConsoleApi2]::OPEN_EXISTING, 0, [IntPtr]::Zero)
    Write-Host "CONIN$ handle: $($handle.ToInt64())"

    if ($handle -ne [IntPtr]::new(-1)) {
        $records = New-Object System.Collections.ArrayList

        # Send '.' character
        $vkPeriod = 0xBE  # VK_OEM_PERIOD
        $scanPeriod = [TestConsoleApi2]::MapVirtualKeyW($vkPeriod, 0)

        $down = New-Object INPUT_RECORD2
        $down.EventType = [TestConsoleApi2]::KEY_EVENT
        $down.KeyEvent = New-Object KEY_EVENT_RECORD2
        $down.KeyEvent.bKeyDown = 1
        $down.KeyEvent.wRepeatCount = 1
        $down.KeyEvent.wVirtualKeyCode = $vkPeriod
        $down.KeyEvent.wVirtualScanCode = $scanPeriod
        $down.KeyEvent.UnicodeChar = [char]'.'
        $down.KeyEvent.dwControlKeyState = 0
        $records.Add($down) | Out-Null

        $up = New-Object INPUT_RECORD2
        $up.EventType = [TestConsoleApi2]::KEY_EVENT
        $up.KeyEvent = New-Object KEY_EVENT_RECORD2
        $up.KeyEvent.bKeyDown = 0
        $up.KeyEvent.wRepeatCount = 1
        $up.KeyEvent.wVirtualKeyCode = $vkPeriod
        $up.KeyEvent.wVirtualScanCode = $scanPeriod
        $up.KeyEvent.UnicodeChar = [char]'.'
        $up.KeyEvent.dwControlKeyState = 0
        $records.Add($up) | Out-Null

        # Send Enter
        $vkReturn = 0x0D
        $scanReturn = [TestConsoleApi2]::MapVirtualKeyW($vkReturn, 0)

        $down2 = New-Object INPUT_RECORD2
        $down2.EventType = [TestConsoleApi2]::KEY_EVENT
        $down2.KeyEvent = New-Object KEY_EVENT_RECORD2
        $down2.KeyEvent.bKeyDown = 1
        $down2.KeyEvent.wRepeatCount = 1
        $down2.KeyEvent.wVirtualKeyCode = $vkReturn
        $down2.KeyEvent.wVirtualScanCode = $scanReturn
        $down2.KeyEvent.UnicodeChar = [char]"`r"
        $down2.KeyEvent.dwControlKeyState = 0
        $records.Add($down2) | Out-Null

        $up2 = New-Object INPUT_RECORD2
        $up2.EventType = [TestConsoleApi2]::KEY_EVENT
        $up2.KeyEvent = New-Object KEY_EVENT_RECORD2
        $up2.KeyEvent.bKeyDown = 0
        $up2.KeyEvent.wRepeatCount = 1
        $up2.KeyEvent.wVirtualKeyCode = $vkReturn
        $up2.KeyEvent.wVirtualScanCode = $scanReturn
        $up2.KeyEvent.UnicodeChar = [char]"`r"
        $up2.KeyEvent.dwControlKeyState = 0
        $records.Add($up2) | Out-Null

        $inputArray = [INPUT_RECORD2[]]$records.ToArray([INPUT_RECORD2])
        $written = [uint32]0
        $r = [TestConsoleApi2]::WriteConsoleInputW($handle, $inputArray, [uint32]$inputArray.Length, [ref]$written)
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Host "WriteConsoleInputW: Result=$r Written=$written Error=$err"
        [TestConsoleApi2]::CloseHandle($handle) | Out-Null
    }
    [TestConsoleApi2]::FreeConsole() | Out-Null
} else {
    Write-Host "AttachConsole FAILED"
}
