import { execSync } from 'child_process';

// Test AttachConsole + WriteConsoleInput against the persistent cmd.exe
const targetPid = 674376; // persistent cmd.exe from session-info

const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Explicit)]
public struct KEY_EVENT_RECORD {
    [FieldOffset(0)] public bool bKeyDown;
    [FieldOffset(4)] public ushort wRepeatCount;
    [FieldOffset(6)] public ushort wVirtualKeyCode;
    [FieldOffset(8)] public ushort wVirtualScanCode;
    [FieldOffset(10)] public char UnicodeChar;
    [FieldOffset(12)] public uint dwControlKeyState;
}

[StructLayout(LayoutKind.Explicit)]
public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
}

public class ConsoleApi {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool WriteConsoleInputW(IntPtr hConsoleInput, INPUT_RECORD[] lpBuffer, uint nLength, out uint lpNumberOfEventsWritten);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
    public const uint GENERIC_READ = 0x80000000;
    public const uint GENERIC_WRITE = 0x40000000;
    public const uint FILE_SHARE_READ = 1;
    public const uint FILE_SHARE_WRITE = 2;
    public const uint OPEN_EXISTING = 3;
    public const ushort KEY_EVENT = 1;
}
"@

Write-Host "Step 1: FreeConsole"
$r = [ConsoleApi]::FreeConsole()
Write-Host "  Result: $r (error: $([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))"

Write-Host "Step 2: AttachConsole(${targetPid})"
$r = [ConsoleApi]::AttachConsole([uint32]${targetPid})
$err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
Write-Host "  Result: $r (error: $err)"

if ($r) {
    $hwnd = [ConsoleApi]::GetConsoleWindow()
    Write-Host "  Console HWND: $($hwnd.ToInt64())"

    Write-Host "Step 3: CreateFileW CONIN"
    $handle = [ConsoleApi]::CreateFileW("CONIN`$", [ConsoleApi]::GENERIC_READ -bor [ConsoleApi]::GENERIC_WRITE, [ConsoleApi]::FILE_SHARE_READ -bor [ConsoleApi]::FILE_SHARE_WRITE, [IntPtr]::Zero, [ConsoleApi]::OPEN_EXISTING, 0, [IntPtr]::Zero)
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Write-Host "  Handle: $($handle.ToInt64()) (error: $err)"

    if ($handle -ne [IntPtr]::new(-1)) {
        Write-Host "Step 4: WriteConsoleInputW (test char X + Enter)"
        $records = New-Object System.Collections.ArrayList
        foreach ($char in @([char]'X', [char]"`r")) {
            $down = New-Object INPUT_RECORD
            $down.EventType = [ConsoleApi]::KEY_EVENT
            $down.KeyEvent = New-Object KEY_EVENT_RECORD
            $down.KeyEvent.bKeyDown = $true
            $down.KeyEvent.wRepeatCount = 1
            $down.KeyEvent.UnicodeChar = $char
            if ($char -eq "`r") { $down.KeyEvent.wVirtualKeyCode = 0x0D }
            $records.Add($down) | Out-Null
            $up = New-Object INPUT_RECORD
            $up.EventType = [ConsoleApi]::KEY_EVENT
            $up.KeyEvent = New-Object KEY_EVENT_RECORD
            $up.KeyEvent.bKeyDown = $false
            $up.KeyEvent.wRepeatCount = 1
            $up.KeyEvent.UnicodeChar = $char
            if ($char -eq "`r") { $up.KeyEvent.wVirtualKeyCode = 0x0D }
            $records.Add($up) | Out-Null
        }
        $inputArray = [INPUT_RECORD[]]$records.ToArray([INPUT_RECORD])
        $written = [uint32]0
        $r = [ConsoleApi]::WriteConsoleInputW($handle, $inputArray, [uint32]$inputArray.Length, [ref]$written)
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-Host "  Result: $r Written: $written (error: $err)"
        [ConsoleApi]::CloseHandle($handle) | Out-Null
    }
    [ConsoleApi]::FreeConsole() | Out-Null
} else {
    Write-Host "AttachConsole FAILED"
}
`;

const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
try {
  const result = execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, {
    encoding: 'utf-8', windowsHide: true, timeout: 15000
  });
  console.log(result);
} catch (e) { console.log('Error:', e.stderr || e.message); }
