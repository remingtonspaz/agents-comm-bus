# Wake / keystroke delivery (sessions 4–5, 2026-01-13 & 2026-02-14)

- **PostMessage WM_CHAR is the only reliable way** to type into a Claude Code
  console window on Windows. `WM_KEYDOWN` doesn't reach the console;
  `SetForegroundWindow` is blocked by focus-stealing prevention; `AppActivate`
  works but steals focus and breaks multi-session. `WriteConsoleInputW` looks
  like it works but ConPTY bypasses the console input buffer, so the chars
  never reach the agent.
- **`lParam = 1` is non-negotiable.** `lParam = 0` triggers 65536 repeats
  because the 16-bit repeat count wraps to max.
- **20 ms between chars** prevents drops on the receiving console.
- **VT escape sequences via WM_CHAR don't combine.** Each char is processed
  individually; arrow keys (`ESC [ B`) don't move the cursor. Use number-key
  selection for `AskUserQuestion`.
- **Process tree topology on Windows** (for finding the right cmd.exe):
  ```
  explorer.exe
    └─ cmd.exe (persistent — has the visible console)
         └─ claude.exe
              └─ cmd.exe (transient — exists only while a hook runs)
                   └─ node.exe (the hook process)
  ```
  Walking up from the hook's PID, the **first** cmd.exe is the transient one
  (dies with the hook). The watcher must target the **persistent** cmd.exe
  whose direct child is `claude.exe`.
- **Hook process has no console.** `GetConsoleWindow()` from inside the hook
  always returns 0. The window handle must come from walking the process
  tree, not from the hook's own console.
