import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { prepareShellEnvFilter } from "../../hosts/codex/install-shell-env-filter.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(initial = "") {
  const root = mkdtempSync(path.join(tmpdir(), "acb-age107-"));
  roots.push(root);
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  const config = path.join(project, ".codex", "config.toml");
  mkdirSync(path.dirname(config), { recursive: true });
  mkdirSync(home);
  writeFileSync(config, initial);
  // Installer only writes files: it does not execute the hooks or MCP shim.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith("AGENTS_COMM_BUS_") &&
    !["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_PROJECT_DIR"].includes(key.toUpperCase())));
  Object.assign(env, { HOME: home, USERPROFILE: home, CODEX_HOME: home });
  return {
    config, home,
    read: () => readFileSync(config, "utf8"),
    run: (hooksOnly = true) => spawnSync(process.execPath,
      [path.join(repo, "install-codex.js"), "--project", project, ...(hooksOnly ? ["--hooks-only"] : [])],
      { cwd: root, env, encoding: "utf8", timeout: 10_000 }),
  };
}

// Narrow parser for generated filters: reject duplicate tables/keys and require
// each filter value to be a quoted string. Other TOML sections are not parsed.
function filters(content: string) {
  let inside = false;
  let tables = 0;
  const values = new Map<string, string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inside = /^\[shell_environment_policy\.filters\]\s*(?:#.*)?$/.test(line);
      if (inside) assert.equal(++tables, 1, "duplicate filters table");
      continue;
    }
    if (!inside) continue;
    const match = line.match(/^"([^"]+)"\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
    assert.ok(match, `invalid filter: ${line}`);
    assert.equal(values.has(match[1]), false, "duplicate filter key");
    values.set(match[1], match[2]);
  }
  assert.equal(tables, 1);
  return values;
}

test("fresh installer emits a managed comm filter and is byte-idempotent", () => {
  const f = fixture();
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const content = f.read();
  assert.equal(filters(content).get("AGENTS_COMM_BUS_*"), "exclude");
  assert.ok(content.indexOf("[shell_environment_policy.filters]") > content.indexOf("# BEGIN agents-comm-bus codex hooks"));
  assert.equal(f.run().status, 0);
  assert.equal(f.read(), content);
});

test("existing filters merge without a duplicate table or damage to custom hooks", () => {
  const f = fixture('[features]\nhooks = true\n[[hooks.SessionStart]]\nmatcher = "custom"\n[shell_environment_policy.filters] # user policy\n"SECRET_*" = "exclude"\n[other]\nvalue = 1\n');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const content = f.read();
  assert.deepEqual([...filters(content)], [["SECRET_*", "exclude"], ["AGENTS_COMM_BUS_*", "exclude"]]);
  assert.ok(content.includes('matcher = "custom"'));
  assert.ok(content.includes('[other]\nvalue = 1'));
  assert.ok(content.indexOf("[shell_environment_policy.filters]") < content.indexOf("# BEGIN agents-comm-bus codex hooks"));
  assert.equal(f.run().status, 0);
  assert.equal(f.read(), content);
});

for (const key of ["exclude", "include_only"]) {
  test(`legacy ${key} refuses before project or global writes`, () => {
    const initial = `[shell_environment_policy]\n${key} = ["SECRET_*"]\n`;
    const f = fixture(initial);
    const result = f.run(false);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy exclude\/include_only/);
    assert.equal(f.read(), initial);
    assert.equal(existsSync(path.join(f.home, "config.toml")), false);
  });
}

test("existing comm key is replaced case-insensitively; inline policy is refused", () => {
  const result = prepareShellEnvFilter('[shell_environment_policy.filters]\n"agents_comm_bus_*" = "include"\n');
  assert.equal(filters(result.content).get("AGENTS_COMM_BUS_*"), "exclude");
  assert.equal(result.managedFilter, "");
  assert.throws(() => prepareShellEnvFilter('shell_environment_policy = { exclude = [] }'), /inline or dotted/);
});
