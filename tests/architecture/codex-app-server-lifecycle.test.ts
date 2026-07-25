import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  cleanupManagedCodexAppServer,
  managedCodexAppServerStatePath,
  type ProcessManager,
} from "../../core-daemon/bridges/codex/app-server-lifecycle.js";
import type { SessionId } from "../../packages/core-contracts/src/index.js";

describe("Codex managed app-server lifecycle", () => {
  it("stops only the app-server and terminal recorded for the session", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-lifecycle-"));
    const session = "codex_session" as SessionId;
    const statePath = managedCodexAppServerStatePath(session, stateRoot);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      sessionId: session,
      appServerUrl: "ws://127.0.0.1:4502",
      appServerPid: 111,
      appServerTerminalPid: 222,
      wrapperPath: "D:\\tmp\\codex-app-server.ps1",
    }), "utf8");
    const processes = new FakeProcessManager(
      new Map([
        [111, "powershell.exe -File codex.ps1 app-server --listen ws://127.0.0.1:4502"],
        [222, "powershell.exe -NoExit -File D:\\tmp\\codex-app-server.ps1"],
        [333, "node codex.js app-server --listen ws://127.0.0.1:4502"],
        [444, "codex.exe app-server --listen ws://127.0.0.1:4502"],
      ]),
      new Map([[111, [333, 444]]]),
    );

    const result = await cleanupManagedCodexAppServer(session, {
      stateRoot,
      processManager: processes,
      now: () => new Date("2026-05-17T22:30:00.000Z"),
    });

    assert.equal(result.ok, true);
    assert.equal(result.appServerStopped, 111);
    assert.equal(result.terminalStopped, 222);
    assert.deepEqual(processes.killed, [444, 333, 111, 222]);

    const updated = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(updated.stoppedAt, "2026-05-17T22:30:00.000Z");
    assert.equal(updated.stoppedBy, "codex-bridge-lease-release");
  });

  it("does not kill a pid whose command line no longer matches the tracked app-server", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-lifecycle-"));
    const session = "codex_session" as SessionId;
    const statePath = managedCodexAppServerStatePath(session, stateRoot);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      sessionId: session,
      appServerUrl: "ws://127.0.0.1:4502",
      appServerPid: 111,
      appServerTerminalPid: 222,
      wrapperPath: "D:\\tmp\\codex-app-server.ps1",
    }), "utf8");
    const processes = new FakeProcessManager(new Map([
      [111, "notepad.exe"],
      [222, "powershell.exe -NoExit -File D:\\tmp\\some-other-script.ps1"],
    ]));

    const result = await cleanupManagedCodexAppServer(session, {
      stateRoot,
      processManager: processes,
    });

    assert.equal(result.ok, true);
    assert.equal(result.appServerStopped, undefined);
    assert.equal(result.terminalStopped, undefined);
    assert.deepEqual(processes.killed, []);
  });

  it("cleanup of one labeled session leaves a same-project sibling untouched", async () => {
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), "codex-app-server-lifecycle-"));
    const mainSession = "codex_main" as SessionId;
    const consultantSession = "codex_consultant" as SessionId;
    const mainPath = managedCodexAppServerStatePath(mainSession, stateRoot);
    const consultantPath = managedCodexAppServerStatePath(consultantSession, stateRoot);
    await mkdir(path.dirname(mainPath), { recursive: true });
    await writeFile(mainPath, JSON.stringify({
      sessionId: mainSession,
      appServerUrl: "ws://127.0.0.1:4501",
      appServerPid: 111,
      appServerTerminalPid: 211,
      wrapperPath: "D:\\tmp\\codex-main.ps1",
    }), "utf8");
    await writeFile(consultantPath, JSON.stringify({
      sessionId: consultantSession,
      appServerUrl: "ws://127.0.0.1:4502",
      appServerPid: 122,
      appServerTerminalPid: 222,
      wrapperPath: "D:\\tmp\\codex-consultant.ps1",
    }), "utf8");
    const processes = new FakeProcessManager(new Map([
      [111, "codex.exe app-server --listen ws://127.0.0.1:4501"],
      [211, "powershell.exe -NoExit -File D:\\tmp\\codex-main.ps1"],
      [122, "codex.exe app-server --listen ws://127.0.0.1:4502"],
      [222, "powershell.exe -NoExit -File D:\\tmp\\codex-consultant.ps1"],
    ]));
    const siblingBefore = await readFile(consultantPath, "utf8");

    const result = await cleanupManagedCodexAppServer(mainSession, {
      stateRoot,
      processManager: processes,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(processes.killed, [111, 211]);
    assert.equal(await readFile(consultantPath, "utf8"), siblingBefore);
  });
});

class FakeProcessManager implements ProcessManager {
  readonly killed: number[] = [];

  constructor(
    private readonly commandLines: Map<number, string>,
    private readonly childPids = new Map<number, number[]>(),
  ) {}

  async commandLine(pid: number): Promise<string | null> {
    return this.commandLines.get(pid) ?? null;
  }

  async descendants(pid: number): Promise<number[]> {
    return this.childPids.get(pid) ?? [];
  }

  async kill(pid: number): Promise<boolean> {
    this.killed.push(pid);
    return true;
  }
}
