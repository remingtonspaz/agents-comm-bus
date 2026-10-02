import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import test from "node:test";

import { herdrSessionId } from "../../core-daemon/runtime/herdr.ts";
import {
  herdrIdentityFromEnv,
  herdrSessionIdFromEnv,
  wakeStrictFromDevMarker,
} from "../../hosts/common/herdr-env.js";
import { resolveCliEntry, CENTRAL_CLI, CHECKOUT_CLI_REL } from "../../plugins/herdr/plugin-lib.js";

test("herdrIdentityFromEnv requires HERDR_ENV, pane id, and socket path", () => {
  const base = {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p1",
    HERDR_SOCKET_PATH: "C:\\Users\\me\\AppData\\herdr\\herdr.sock",
    HERDR_BIN_PATH: "C:\\herdr\\herdr.exe",
  };
  const identity = herdrIdentityFromEnv("claude", base);
  assert.ok(identity);
  assert.equal(identity.agent, "claude");
  assert.equal(identity.bin_path, base.HERDR_BIN_PATH);

  assert.equal(herdrIdentityFromEnv("claude", { ...base, HERDR_ENV: "0" }), null);
  assert.equal(herdrIdentityFromEnv("claude", { ...base, HERDR_PANE_ID: "" }), null);
  assert.equal(herdrIdentityFromEnv("claude", { ...base, HERDR_SOCKET_PATH: "" }), null);
});

test("herdrSessionIdFromEnv matches daemon herdrSessionId", () => {
  const env = {
    HERDR_ENV: "1",
    HERDR_PANE_ID: "w1:p2",
    HERDR_SOCKET_PATH: "C:\\Users\\me\\AppData\\herdr\\session-dev.sock",
  };
  const identity = herdrIdentityFromEnv("codex", env);
  assert.ok(identity);
  assert.equal(herdrSessionIdFromEnv("codex", env), herdrSessionId(identity));
});

test("wakeStrictFromDevMarker reads wakeStrict herdr", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acb-herdr-dev-"));
  assert.equal(wakeStrictFromDevMarker(root), null);
  await writeFile(
    path.join(root, ".agents-comm-bus-dev.json"),
    JSON.stringify({ daemonBin: "agents-comm-bus/dist/core-daemon/serve.js", wakeStrict: "herdr" }),
    "utf8",
  );
  assert.equal(wakeStrictFromDevMarker(root), "herdr");
});

test("resolveCliEntry prefers dev checkout CLI when marker + cli exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acb-herdr-cli-"));
  const checkoutRoot = path.join(root, "repo");
  const project = path.join(checkoutRoot, "pkg");
  await mkdir(project, { recursive: true });
  await mkdir(path.join(checkoutRoot, ".git"), { recursive: true });
  const cliPath = path.join(checkoutRoot, CHECKOUT_CLI_REL);
  await mkdir(path.dirname(cliPath), { recursive: true });
  await writeFile(cliPath, "// stub\n", "utf8");
  await writeFile(
    path.join(checkoutRoot, ".agents-comm-bus-dev.json"),
    JSON.stringify({ daemonBin: "agents-comm-bus/dist/core-daemon/serve.js" }),
    "utf8",
  );

  const resolved = resolveCliEntry(project);
  assert.equal(resolved.entry, cliPath);
  assert.equal(resolved.source, "dev-checkout");
});

test("resolveCliEntry falls back to central CLI without dev marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "acb-herdr-cli-central-"));
  const project = path.join(root, "work");
  await mkdir(project, { recursive: true });
  await mkdir(path.join(project, ".git"), { recursive: true });

  const resolved = resolveCliEntry(project);
  assert.equal(resolved.entry, CENTRAL_CLI);
  assert.equal(resolved.source, "central");
});
