# Hook contract on Windows (session 4)

- **`SessionStart` hook is unreliable** in Claude Code on Windows (known
  harness issue tracked upstream as
  [anthropics/claude-code#21468](https://github.com/anthropics/claude-code/issues/21468),
  with related #55427 / #23576). Workaround: also call
  `ensureClaudeWakeWatcher` from `UserPromptSubmit` (and now also
  `PermissionRequest`) so the watcher spawns at first prompt even if
  `SessionStart` never fires.
- **Node `spawn(detached:true)` on Windows often dies immediately**, especially
  when launching `powershell.exe -File`. Use `Start-Process -PassThru |
  Select-Object -ExpandProperty Id` via `execSync` to get the real PID of a
  detached child.
