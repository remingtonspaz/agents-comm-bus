import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCanonicalProjectEnvVars,
  parseTomlStringArray,
  syncProjectMcpEnvVars,
} from "../../hosts/codex/install-codex-config.js";
import {
  CODEX_MCP_ENV_VAR_NAMES,
  formatTomlEnvVars,
} from "../../hosts/codex/mcp-env-vars.js";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.join(fileURLToPath(import.meta.url), "../../.."));
const INSTALL_CODEX = path.join(REPO_ROOT, "install-codex.js");
const CODEX_COMMS = ["telegram", "discord", "matrix", "curl"] as const;

function resolveCodexInvocation(): { command: string; argsPrefix: string[] } | null {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      const codexJs = path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(codexJs)) {
        return { command: process.execPath, argsPrefix: [codexJs] };
      }
    }
  }

  const executable = resolveCodexExecutable();
  if (!executable) return null;
  return { command: executable, argsPrefix: [] };
}

function resolveCodexExecutable(): string | null {
  try {
    const output = execFileSync(
      process.platform === "win32" ? "where.exe" : "which",
      ["codex"],
      { encoding: "utf8" },
    ).trim();
    const candidates = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (process.platform === "win32") {
      const cmd = candidates.find((line) => line.toLowerCase().endsWith(".cmd"));
      if (cmd) return cmd;
    }
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

const CODEX_INVOCATION = resolveCodexInvocation();

function probeTempRoot(): string {
  return existsSync("D:/tmp") ? "D:/tmp" : os.tmpdir();
}

async function makeProbeDir(prefix: string): Promise<string> {
  const parent = probeTempRoot();
  await mkdir(parent, { recursive: true });
  return mkdtemp(path.join(parent, prefix));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProbeProcess(child: ReturnType<typeof spawn> | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = once(child, "exit").catch(() => []);
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // The process may have exited between the check above and taskkill.
    }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, sleep(5000)]);
}

function assertExactEnvVarSet(actual: readonly string[], label: string) {
  assert.deepEqual(
    [...actual].sort(),
    [...CODEX_MCP_ENV_VAR_NAMES].sort(),
    `${label} must declare the canonical Codex MCP env_vars set`,
  );
}

async function runInstallCodex(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return run(process.execPath, [INSTALL_CODEX, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    timeout: 30000,
  });
}

describe("AGE-87 Codex MCP env_vars forwarding", () => {
  it("canonical list matches bootstrap and shim reads", () => {
    assert.deepEqual(CODEX_MCP_ENV_VAR_NAMES, [
      "AGENTS_COMM_BUS_AGENT",
      "AGENTS_COMM_BUS_SESSION_ID",
      "AGENTS_COMM_LABELS",
      "AGENTS_COMM_BUS_BIN",
      "AGENTS_COMM_BUS_DISCOVERY_ROOT",
      "AGENTS_COMM_BUS_ADAPTERS_DIR",
      "AGENTS_COMM_BUS_ROOT",
      "CODEX_APP_SERVER_URL",
      "CODEX_THREAD_ID",
      "CODEX_SESSION_ID",
    ]);
  });

  it("install-codex.js writes canonical env_vars into disposable global MCP block", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-home-"));
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-project-"));
    try {
      await runInstallCodex(["--mcp-only", "--project", projectDir], { CODEX_HOME: codexHome });
      const globalConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");
      assert.match(globalConfig, /\[mcp_servers\.telegram\]/);
      assert.match(globalConfig, /mcp-server[\\/]+dist[\\/]+codex-mcp-shim\.js/);
      assertExactEnvVarSet(parseTomlStringArray(globalConfig, "env_vars") ?? [], codexHome);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("install-codex.js does not create a project MCP table when none exists", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-home-"));
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-project-"));
    try {
      await runInstallCodex(["--hooks-only", "--project", projectDir], { CODEX_HOME: codexHome });
      const projectConfig = await readFile(path.join(projectDir, ".codex", "config.toml"), "utf8");
      assert.doesNotMatch(projectConfig, /\[mcp_servers\.telegram\]/);
      assert.match(projectConfig, /agents-comm-bus codex hooks/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("install-codex.js syncs env_vars on an existing project override without replacing command/args", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-home-"));
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-project-"));
    const customCommand = "C:/machine-specific/node.exe";
    const customArg = "C:/machine-specific/custom-shim.js";
    try {
      const projectCodexDir = path.join(projectDir, ".codex");
      await mkdir(projectCodexDir, { recursive: true });
      await writeFile(
        path.join(projectCodexDir, "config.toml"),
        [
          "[mcp_servers.telegram]",
          `command = ${JSON.stringify(customCommand)}`,
          `args = [${JSON.stringify(customArg)}]`,
          'env_vars = ["STALE_ONLY"]',
          "",
        ].join("\n"),
        "utf8",
      );

      await runInstallCodex(["--hooks-only", "--project", projectDir], { CODEX_HOME: codexHome });
      const projectConfig = await readFile(path.join(projectCodexDir, "config.toml"), "utf8");
      assert.match(projectConfig, new RegExp(`command = ${JSON.stringify(customCommand).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(projectConfig, new RegExp(JSON.stringify(customArg).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(projectConfig, /STALE_ONLY/);
      assertCanonicalProjectEnvVars(projectConfig);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("install-codex.js fails loud instead of silently skipping an inline project MCP override", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-home-"));
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-project-"));
    const projectCodexDir = path.join(projectDir, ".codex");
    const configPath = path.join(projectCodexDir, "config.toml");
    const original =
      'mcp_servers.telegram = { command = "node", args = ["custom-shim.js"] }\n';
    try {
      await mkdir(projectCodexDir, { recursive: true });
      await writeFile(configPath, original, "utf8");
      await assert.rejects(
        runInstallCodex(["--hooks-only", "--project", projectDir], { CODEX_HOME: codexHome }),
        /Cannot install Codex hooks without canonical MCP env_vars/,
      );
      assert.equal(await readFile(configPath, "utf8"), original);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("syncProjectMcpEnvVars is a no-op when the project override table is absent", () => {
    const input = "[features]\nhooks = true\n";
    const result = syncProjectMcpEnvVars(input);
    assert.equal(result.changed, false);
    assert.equal(result.content, input);
  });

  it("installer verification does not mistake a nested dotted key for the project MCP table", async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-home-"));
    const projectDir = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-project-"));
    const projectCodexDir = path.join(projectDir, ".codex");
    try {
      await mkdir(projectCodexDir, { recursive: true });
      await writeFile(
        path.join(projectCodexDir, "config.toml"),
        '[other]\nmcp_servers.telegram = { enabled = false }\n',
        "utf8",
      );
      await runInstallCodex(
        ["--hooks-only", "--project", projectDir],
        { CODEX_HOME: codexHome },
      );
    } finally {
      await rm(codexHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("syncProjectMcpEnvVars replaces a multiline stale array without corrupting the table", () => {
    const input = [
      "[mcp_servers.telegram]",
      'command = "node"',
      'args = ["custom.js"]',
      "env_vars = [",
      '  "STALE_ONE",',
      '  "STALE_TWO",',
      "]",
      "startup_timeout_sec = 15",
      "",
    ].join("\n");
    const result = syncProjectMcpEnvVars(input);
    assert.equal(result.changed, true);
    assert.doesNotMatch(result.content, /STALE_(ONE|TWO)/);
    assert.match(result.content, /startup_timeout_sec = 15/);
    assertCanonicalProjectEnvVars(result.content);
  });

  for (const comm of CODEX_COMMS) {
    it(`staged plugins/codex/${comm}/.mcp.json declares the canonical env_vars set`, async () => {
      const mcpPath = path.join(REPO_ROOT, "plugins/codex", comm, ".mcp.json");
      const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
      const entry = mcp[comm];
      assert.ok(entry, `missing ${comm} MCP entry`);
      assertExactEnvVarSet(entry.env_vars ?? [], mcpPath);
    });
  }

  it("omitting env_vars from the canonical list fails the discriminating assertion", () => {
    const mutated = CODEX_MCP_ENV_VAR_NAMES.filter((name) => name !== "AGENTS_COMM_LABELS");
    assert.throws(
      () => assertExactEnvVarSet(mutated, "mutation probe"),
      /must declare the canonical Codex MCP env_vars set/,
    );
  });

  it("removing AGENTS_COMM_BUS_DISCOVERY_ROOT fails the discriminating assertion", () => {
    const mutated = CODEX_MCP_ENV_VAR_NAMES.filter(
      (name) => name !== "AGENTS_COMM_BUS_DISCOVERY_ROOT",
    );
    assert.throws(
      () => assertExactEnvVarSet(mutated, "discovery-root mutation probe"),
      /must declare the canonical Codex MCP env_vars set/,
    );
  });

});

describe("AGE-87 Codex parser validation probes", () => {
  it("codex accepts env_vars in project config.toml (parse only)", async (t) => {
    if (!CODEX_INVOCATION) {
      t.skip("codex executable not found on PATH");
      return;
    }
    const probeRoot = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-toml-"));
    try {
      await writeFile(
        path.join(probeRoot, "config.toml"),
        [
          "[mcp_servers.probe_stdio]",
          'command = "node"',
          'args = ["-e", "console.log(\\"ok\\")"]',
          formatTomlEnvVars(),
          "",
        ].join("\n"),
        "utf8",
      );
      const { stdout } = await run(
        CODEX_INVOCATION.command,
        [...CODEX_INVOCATION.argsPrefix, "mcp", "list"],
        {
          env: { ...process.env, CODEX_HOME: probeRoot },
          timeout: 15000,
        },
      );
      assert.match(stdout, /probe_stdio/);
      for (const name of ["AGENTS_COMM_BUS_AGENT", "AGENTS_COMM_LABELS", "CODEX_APP_SERVER_URL"]) {
        assert.match(stdout, new RegExp(`${name}=\\*+`));
      }
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
  });

  it("codex accepts env_vars in plugin-provided .mcp.json (parse only)", async (t) => {
    if (!CODEX_INVOCATION) {
      t.skip("codex executable not found on PATH");
      return;
    }
    const probeRoot = await mkdtemp(path.join(os.tmpdir(), "acb-age87-codex-mcpjson-"));
    const pluginRoot = path.join(
      probeRoot,
      "plugins/cache/agents-comm-bus-codex/telegram/0.0.0-probe",
    );
    try {
      const srcPlugin = path.join(REPO_ROOT, "plugins/codex/telegram");
      await mkdir(pluginRoot, { recursive: true });
      await copyFile(path.join(srcPlugin, ".mcp.json"), path.join(pluginRoot, ".mcp.json"));
      await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await copyFile(
        path.join(srcPlugin, ".codex-plugin/plugin.json"),
        path.join(pluginRoot, ".codex-plugin/plugin.json"),
      );

      const mcp = JSON.parse(await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"));
      mcp.telegram.env_vars = [...CODEX_MCP_ENV_VAR_NAMES];
      await writeFile(path.join(pluginRoot, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, "utf8");

      const probeSource = probeRoot.replace(/\\/g, "/");
      await writeFile(
        path.join(probeRoot, "config.toml"),
        [
          '[plugins."telegram@agents-comm-bus-codex"]',
          "enabled = true",
          "",
          "[marketplaces.agents-comm-bus-codex]",
          'source_type = "local"',
          `source = "${probeSource}"`,
          "",
        ].join("\n"),
        "utf8",
      );

      const { stdout } = await run(
        CODEX_INVOCATION.command,
        [...CODEX_INVOCATION.argsPrefix, "mcp", "list"],
        {
          env: { ...process.env, CODEX_HOME: probeRoot },
          timeout: 15000,
        },
      );
      assert.match(stdout, /\btelegram\b/);
      assert.match(stdout, /AGENTS_COMM_BUS_DISCOVERY_ROOT=\*+/);
      assert.match(stdout, /AGENTS_COMM_LABELS=\*+/);
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
  });
});

describe("AGE-87 Codex stdio child env forwarding probe", () => {
  it("codex exec forwards sentinel env through project TOML and plugin .mcp.json", async (t) => {
    if (!CODEX_INVOCATION) {
      t.skip("codex executable not found on PATH");
      return;
    }

    const probeRoot = await makeProbeDir("acb-age87-codex-forward-");
    const projectOutFile = path.join(probeRoot, "project-child-env.json");
    const pluginOutFile = path.join(probeRoot, "plugin-child-env.json");
    const probeScript = path.join(probeRoot, "probe-mcp.js");
    const pluginRoot = path.join(
      probeRoot,
      "plugins/cache/agents-comm-bus-codex/telegram/0.0.0-probe",
    );
    let child: ReturnType<typeof spawn> | undefined;

    try {
      const installerProject = path.join(probeRoot, "installer-project");
      await mkdir(installerProject, { recursive: true });
      await runInstallCodex(
        ["--mcp-only", "--project", installerProject],
        { CODEX_HOME: probeRoot },
      );
      const installedConfig = await readFile(path.join(probeRoot, "config.toml"), "utf8");
      const projectEnvVars = parseTomlStringArray(installedConfig, "env_vars") ?? [];
      const stagedPlugin = JSON.parse(
        await readFile(path.join(REPO_ROOT, "plugins/codex/telegram/.mcp.json"), "utf8"),
      );
      const pluginEnvVars = stagedPlugin.telegram?.env_vars ?? [];

      await writeFile(
        probeScript,
        [
          "const fs = require('node:fs');",
          "const payload = {",
          "  AGENTS_COMM_LABELS: process.env.AGENTS_COMM_LABELS ?? null,",
          "  CODEX_APP_SERVER_URL: process.env.CODEX_APP_SERVER_URL ?? null,",
          "  AGENTS_COMM_BUS_DISCOVERY_ROOT: process.env.AGENTS_COMM_BUS_DISCOVERY_ROOT ?? null,",
          "  AGENTS_COMM_BUS_SESSION_ID: process.env.AGENTS_COMM_BUS_SESSION_ID ?? null,",
          "};",
          "fs.writeFileSync(process.argv[2], JSON.stringify(payload));",
          "setInterval(() => {}, 60000);",
          "",
        ].join("\n"),
        "utf8",
      );

      const scriptPathForToml = probeScript.replace(/\\/g, "/");
      const projectOutForToml = projectOutFile.replace(/\\/g, "/");
      const pluginOutForJson = pluginOutFile.replace(/\\/g, "/");
      await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
      await writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        `${JSON.stringify({
          name: "telegram",
          version: "0.0.0-probe",
          description: "AGE-87 env forwarding probe",
        }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(
        path.join(pluginRoot, ".mcp.json"),
        `${JSON.stringify({
          acb_probe_plugin: {
            command: process.execPath,
            args: [probeScript, pluginOutForJson],
            env_vars: pluginEnvVars,
          },
        }, null, 2)}\n`,
        "utf8",
      );

      const probeSource = probeRoot.replace(/\\/g, "/");
      await writeFile(
        path.join(probeRoot, "config.toml"),
        [
          "[mcp_servers.acb_probe_project]",
          `command = ${JSON.stringify(process.execPath.replace(/\\/g, "/"))}`,
          `args = ["${scriptPathForToml}", "${projectOutForToml}"]`,
          formatTomlEnvVars(projectEnvVars),
          "",
          '[plugins."telegram@agents-comm-bus-codex"]',
          "enabled = true",
          "",
          "[marketplaces.agents-comm-bus-codex]",
          'source_type = "local"',
          `source = "${probeSource}"`,
          "",
        ].join("\n"),
        "utf8",
      );

      const sentinelEnv = {
        ...process.env,
        CODEX_HOME: probeRoot,
        AGENTS_COMM_LABELS: "telegram:forward-probe",
        CODEX_APP_SERVER_URL: "ws://127.0.0.1:49999",
        AGENTS_COMM_BUS_DISCOVERY_ROOT: "D:/tmp/acb-age87-discovery",
        AGENTS_COMM_BUS_SESSION_ID: "probe_session_123",
      };

      child = spawn(
        CODEX_INVOCATION.command,
        [
          ...CODEX_INVOCATION.argsPrefix,
          "exec",
          "-m",
          "gpt-5.6-sol",
          "--sandbox",
          "read-only",
          "Reply with exactly OK.",
        ],
        {
          env: sentinelEnv,
          cwd: REPO_ROOT,
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      child.stdin?.end();

      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const ready = await Promise.all(
          [projectOutFile, pluginOutFile].map(async (file) => {
            try {
              await access(file);
              return true;
            } catch {
              return false;
            }
          }),
        );
        if (ready.every(Boolean)) break;
        await sleep(250);
      }

      await stopProbeProcess(child);

      for (const [surface, outFile] of [
        ["project TOML", projectOutFile],
        ["plugin .mcp.json", pluginOutFile],
      ] as const) {
        let payload;
        try {
          payload = JSON.parse(await readFile(outFile, "utf8"));
        } catch (error) {
          assert.fail(
            `Codex did not write the ${surface} forwarded env probe at ${outFile}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        assert.equal(payload.AGENTS_COMM_LABELS, "telegram:forward-probe", surface);
        assert.equal(payload.CODEX_APP_SERVER_URL, "ws://127.0.0.1:49999", surface);
        assert.equal(
          payload.AGENTS_COMM_BUS_DISCOVERY_ROOT,
          "D:/tmp/acb-age87-discovery",
          surface,
        );
        assert.equal(payload.AGENTS_COMM_BUS_SESSION_ID, "probe_session_123", surface);
      }
    } finally {
      await stopProbeProcess(child);
      try {
        await rm(probeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Codex may leave sqlite locks under the disposable CODEX_HOME.
      }
    }
  });
});

describe("AGE-87 omission mutations fail staged artifact checks", () => {
  it("a .mcp.json missing env_vars fails the canonical set assertion", () => {
    const entry = {
      command: "node",
      args: ["-e", "console.log('ok')"],
    };
    assert.throws(
      () => assertExactEnvVarSet(entry.env_vars ?? [], "missing env_vars"),
      /must declare the canonical Codex MCP env_vars set/,
    );
  });

  it("project override without env_vars fails canonical assertion after strip", () => {
    const stripped = [
      "[mcp_servers.telegram]",
      'command = "node"',
      'args = ["custom.js"]',
      "",
    ].join("\n");
    assert.throws(() => assertCanonicalProjectEnvVars(stripped), /expected env_vars array/);
  });
});

describe("AGE-87 stage-plugins generator includes env_vars", () => {
  it("stage-plugins.js wires CODEX_MCP_ENV_VAR_NAMES into Codex .mcp.json output", async () => {
    const stageScript = await readFile(path.join(REPO_ROOT, "scripts/stage-plugins.js"), "utf8");
    assert.match(stageScript, /env_vars:\s*\[\.\.\.CODEX_MCP_ENV_VAR_NAMES\]/);
  });
});
