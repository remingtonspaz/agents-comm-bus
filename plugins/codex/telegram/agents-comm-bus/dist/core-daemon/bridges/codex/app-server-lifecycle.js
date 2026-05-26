import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const DEFAULT_STOPPED_BY = "codex-bridge-lease-release";
export async function cleanupManagedCodexAppServer(session, options = {}) {
    const statePath = managedCodexAppServerStatePath(session, options.stateRoot);
    const state = await readManagedAppServerState(statePath);
    if (!state) {
        return { ok: false, statePath, reason: "state file not found" };
    }
    if (state.sessionId && state.sessionId !== session) {
        return { ok: false, statePath, reason: "state file session mismatch" };
    }
    const processManager = options.processManager ?? defaultProcessManager;
    const result = { ok: true, statePath };
    if (state.appServerPid && await isTrackedAppServer(processManager, state)) {
        if (await killTree(processManager, state.appServerPid)) {
            result.appServerStopped = state.appServerPid;
        }
    }
    if (state.appServerTerminalPid && await isTrackedAppServerTerminal(processManager, state)) {
        if (await processManager.kill(state.appServerTerminalPid)) {
            result.terminalStopped = state.appServerTerminalPid;
        }
    }
    state.stoppedAt = (options.now ?? (() => new Date()))().toISOString();
    state.stoppedBy = DEFAULT_STOPPED_BY;
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
    return result;
}
async function killTree(processManager, pid) {
    const descendants = processManager.descendants ? await processManager.descendants(pid) : [];
    for (const childPid of descendants.reverse()) {
        await processManager.kill(childPid);
    }
    return processManager.kill(pid);
}
export function managedCodexAppServerStatePath(session, stateRoot = path.join(os.homedir(), ".agents-comm-bus", "codex-bootstrapper")) {
    return path.join(stateRoot, "sessions", `${session}.json`);
}
async function readManagedAppServerState(statePath) {
    try {
        return JSON.parse(await readFile(statePath, "utf8"));
    }
    catch {
        return null;
    }
}
async function isTrackedAppServer(processManager, state) {
    if (!state.appServerPid || !state.appServerUrl)
        return false;
    const commandLine = await processManager.commandLine(state.appServerPid);
    return commandLine != null &&
        /\bapp-server\b/i.test(commandLine) &&
        /(^|\s)--listen(\s|$)/i.test(commandLine) &&
        commandLine.includes(state.appServerUrl);
}
async function isTrackedAppServerTerminal(processManager, state) {
    if (!state.appServerTerminalPid || !state.wrapperPath)
        return false;
    const commandLine = await processManager.commandLine(state.appServerTerminalPid);
    return commandLine != null &&
        /\b(powershell|pwsh|cmd)(\.exe)?\b/i.test(commandLine) &&
        commandLine.includes(state.wrapperPath);
}
const defaultProcessManager = {
    async commandLine(pid) {
        if (!Number.isInteger(pid) || pid <= 0)
            return null;
        if (process.platform === "win32") {
            const script = [
                `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
                "if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }",
            ].join("; ");
            try {
                const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
                return output.trim() || null;
            }
            catch {
                return null;
            }
        }
        try {
            const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
            return output.trim() || null;
        }
        catch {
            return null;
        }
    },
    async descendants(pid) {
        if (!Number.isInteger(pid) || pid <= 0)
            return [];
        if (process.platform === "win32") {
            const script = `
function Get-Children([int]$ParentPid) {
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentPid" -ErrorAction SilentlyContinue)
  foreach ($child in $children) {
    [int]$child.ProcessId
    Get-Children -ParentPid ([int]$child.ProcessId)
  }
}
Get-Children -ParentPid ${pid}
`;
            try {
                const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
                return output.split(/\r?\n/)
                    .map((line) => Number.parseInt(line.trim(), 10))
                    .filter((value) => Number.isInteger(value) && value > 0);
            }
            catch {
                return [];
            }
        }
        try {
            const output = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
            return output.split(/\r?\n/)
                .map((line) => Number.parseInt(line.trim(), 10))
                .filter((value) => Number.isInteger(value) && value > 0);
        }
        catch {
            return [];
        }
    },
    async kill(pid) {
        try {
            process.kill(pid);
            return true;
        }
        catch {
            return false;
        }
    },
};
//# sourceMappingURL=app-server-lifecycle.js.map