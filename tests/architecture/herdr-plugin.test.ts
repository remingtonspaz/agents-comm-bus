import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readFile, readdir, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import test from "node:test";

import { resolveClaudeSessionId } from "../../hosts/common/claude-session-id.js";
import { claudeMcpSessionInUse } from "../../hosts/common/claude-mcp-session.js";
import {
  resolveCodexSessionId,
  resolveCodexMcpSessionId,
} from "../../hosts/common/codex-session-id.js";
import {
  agentKindFromListEntry,
  buildSyncIdentity,
  cwdFromEvent,
  extractAgentKind,
  resolveProjectForPane,
  wakeStrictForProject,
} from "../../plugins/herdr/plugin-lib.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const herdrPluginDir = path.join(repoRoot, "plugins/herdr");

const herdrEnv = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p1",
  HERDR_SOCKET_PATH: "C:\\Users\\me\\AppData\\herdr\\herdr.sock",
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("buildSyncIdentity uses agent pane id, not plugin HERDR_PANE_ID", () => {
  const identity = buildSyncIdentity(
    "claude",
    "w1:p3",
    { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/sock" },
    {},
  );
  assert.ok(identity);
  assert.equal(identity.pane_id, "w1:p3");
});

test("startup list entry w1:p3 keeps pane id when plugin env has w1:p1", () => {
  const entry = { agent: "claude", pane_id: "w1:p3", cwd: "D:\\proj" };
  const identity = buildSyncIdentity("claude", entry.pane_id, {
    HERDR_PANE_ID: "w1:p1",
    HERDR_SOCKET_PATH: "/sock",
  }, entry);
  assert.equal(identity?.pane_id, "w1:p3");
});

test("plugins/herdr imports are only node: builtins or relative files in plugins/herdr", async () => {
  const files = (await readdir(herdrPluginDir)).filter((name) => name.endsWith(".js"));
  for (const file of files) {
    const src = await readFile(path.join(herdrPluginDir, file), "utf8");
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const imp of imports) {
      assert.ok(
        imp.startsWith("node:") || imp.startsWith("./"),
        `${file} must not import ${imp}`,
      );
      assert.doesNotMatch(imp, /agents-comm-bus/);
    }
  }
});

test("extractAgentKind accepts string or PaneInfo-style object", () => {
  assert.equal(extractAgentKind("claude"), "claude");
  assert.equal(extractAgentKind({ agent: "codex" }), "codex");
  assert.equal(extractAgentKind({ agent: { agent: "claude" } }), "claude");
});

test("resolveProjectForPane uses agent get when list/event lack cwd", async () => {
  const project = await resolveProjectForPane({
    listEntry: { agent: "claude", pane_id: "w1:p1" },
    paneId: "w1:p1",
    agentGet: async () => ({ result: { agent: { cwd: "D:\\repo\\pkg" } } }),
  });
  assert.equal(project, path.resolve("D:\\repo\\pkg"));
});

test("resolveProjectForPane returns null without cwd (no plugin-dir fallback)", async () => {
  const project = await resolveProjectForPane({
    paneId: "w1:p9",
    agentGet: async () => ({ result: { agent: { agent: "claude" } } }),
  });
  assert.equal(project, null);
});

test("cwdFromEvent reads cwd from agent object on event", () => {
  const cwd = cwdFromEvent({ agent: { agent: "claude", cwd: "D:\\work" } });
  assert.equal(cwd, path.resolve("D:\\work"));
});

test("agentKindFromListEntry reads agent object on list row", () => {
  assert.equal(agentKindFromListEntry({ agent: { agent: "claude" }, pane_id: "w1:p1" }), "claude");
});

test("wakeStrictForProject reads wakeStrict from checkout dev marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acb-herdr-ws-"));
  const checkout = path.join(root, "repo");
  const project = path.join(checkout, "pkg");
  await mkdir(project, { recursive: true });
  await mkdir(path.join(checkout, ".git"), { recursive: true });
  await writeFile(
    path.join(checkout, ".agents-comm-bus-dev.json"),
    JSON.stringify({
      daemonBin: "agents-comm-bus/dist/core-daemon/serve.js",
      wakeStrict: "herdr",
    }),
    "utf8",
  );
  assert.equal(wakeStrictForProject(project), "herdr");
});

test("resolveClaudeSessionId: herdr wins over leaked AGENTS_COMM_BUS_SESSION_ID", () => {
  withEnv(
    { ...herdrEnv, AGENTS_COMM_BUS_SESSION_ID: "sess_leaked" },
    () => {
      const id = resolveClaudeSessionId({});
      assert.match(id, /^herdr_/);
    },
  );
});

test("resolveClaudeSessionId: without herdr ignores AGENTS_COMM_BUS_SESSION_ID", () => {
  withEnv(
    {
      HERDR_ENV: undefined,
      HERDR_PANE_ID: undefined,
      HERDR_SOCKET_PATH: undefined,
      AGENTS_COMM_BUS_SESSION_ID: "sess_leaked",
      CLAUDE_SESSION_ID: "seed",
    },
    () => {
      const id = resolveClaudeSessionId({});
      assert.match(id, /^claude_/);
      assert.notEqual(id, "sess_leaked");
    },
  );
});

test("claudeMcpSessionInUse: herdr, then managed id, then mcp fallback", () => {
  withEnv({
    HERDR_ENV: undefined,
    HERDR_PANE_ID: undefined,
    HERDR_SOCKET_PATH: undefined,
    AGENTS_COMM_BUS_SESSION_ID: undefined,
    CLAUDE_SESSION_ID: undefined,
  }, () => {
    assert.equal(claudeMcpSessionInUse(), "mcp");
  });
  withEnv({ ...herdrEnv, AGENTS_COMM_BUS_SESSION_ID: "managed" }, () => {
    assert.match(claudeMcpSessionInUse(), /^herdr_/);
  });
  withEnv(
    {
      HERDR_ENV: undefined,
      HERDR_PANE_ID: undefined,
      HERDR_SOCKET_PATH: undefined,
      AGENTS_COMM_BUS_SESSION_ID: "managed",
      CLAUDE_SESSION_ID: "x",
    },
    () => assert.equal(claudeMcpSessionInUse(), "managed"),
  );
});

test("resolveCodexSessionId hooks: herdr then hash, not managed id", () => {
  withEnv(
    {
      HERDR_ENV: undefined,
      HERDR_PANE_ID: undefined,
      HERDR_SOCKET_PATH: undefined,
      AGENTS_COMM_BUS_SESSION_ID: "managed",
      CODEX_SESSION_ID: "thread-1",
    },
    () => {
      const id = resolveCodexSessionId({});
      assert.match(id, /^codex_/);
      assert.notEqual(id, "managed");
    },
  );
  withEnv({ ...herdrEnv, AGENTS_COMM_BUS_SESSION_ID: "managed" }, () => {
    assert.match(resolveCodexSessionId({}), /^herdr_/);
  });
});

test("resolveCodexMcpSessionId: herdr then managed then hash", () => {
  withEnv(
    {
      HERDR_ENV: undefined,
      HERDR_PANE_ID: undefined,
      HERDR_SOCKET_PATH: undefined,
      AGENTS_COMM_BUS_SESSION_ID: "managed",
      CODEX_SESSION_ID: "t",
    },
    () => assert.equal(resolveCodexMcpSessionId({}), "managed"),
  );
  withEnv({ ...herdrEnv, AGENTS_COMM_BUS_SESSION_ID: "managed" }, () => {
    assert.match(resolveCodexMcpSessionId({}), /^herdr_/);
  });
});
