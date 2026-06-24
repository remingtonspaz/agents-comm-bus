import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CurlCommAdapter } from "../../adapters/curl/adapter.js";
import {
  CurlCommAdapterFactory,
  DEFAULT_CURL_ACCOUNT_ID,
  createCommAdapterFactory,
} from "../../adapters/curl/factory.js";
import { normalizeProjectPath } from "../../core-daemon/project-path.js";
import { makeTempDir, registerTempDirCleanup } from "./_temp-dirs.js";
import type {
  AccountId,
  AccountRegistration,
  AgentId,
  CommId,
} from "../../packages/core-contracts/src/index.js";
import { SCHEMA_VERSION_ACCOUNT } from "../../packages/core-contracts/src/types.js";

registerTempDirCleanup();

const PROJECT = normalizeProjectPath("/repo");

function registration(credentialsRef: string): AccountRegistration {
  return {
    schema_version: SCHEMA_VERSION_ACCOUNT,
    registration_id: "reg-curl-1",
    project: PROJECT,
    comm: "curl" as CommId,
    agent: "claude" as AgentId,
    account_label: "main",
    bot_user_id: DEFAULT_CURL_ACCOUNT_ID,
    credentials_ref: credentialsRef,
    created_at: 1,
    updated_at: 1,
  };
}

describe("curl factory credential resolution", () => {
  it("resolves daemon-owned file refs and threads the registration scope through", async () => {
    const dir = await makeTempDir("acb-curl-cred-");
    const tokenFile = join(dir, "token.json");
    await writeFile(
      tokenFile,
      JSON.stringify({ botToken: "s3cret", port: 8930, userId: ["ci", "cron"] }),
      "utf8",
    );
    const factory = new CurlCommAdapterFactory();
    const resolved = await factory.resolveCredentials(
      registration(`file:${tokenFile}`),
      { CURL_SENDER_ID: "hermes, ci" },
    );
    assert.ok(resolved.status === "ok");
    assert.equal(resolved.credentials.token, "s3cret");
    assert.equal(resolved.credentials.port, 8930);
    assert.equal(resolved.credentials.project, PROJECT);
    assert.equal(resolved.credentials.agent, "claude");
    // env CSV first, then file userIds, deduped.
    assert.deepEqual(resolved.credentials.allowedSenderIds, ["hermes", "ci", "cron"]);
  });

  it("returns undefined for non-file refs and unreadable/tokenless files", async () => {
    const dir = await makeTempDir("acb-curl-cred-");
    const factory = new CurlCommAdapterFactory();
    assert.equal((await factory.resolveCredentials(registration("env:CURL_TOKEN"), {})).status, "absent");
    assert.equal(
      (await factory.resolveCredentials(registration(`file:${join(dir, "missing.json")}`), {})).status,
      "absent",
    );
    const tokenless = join(dir, "tokenless.json");
    await writeFile(tokenless, JSON.stringify({ port: 8930 }), "utf8");
    const tokenlessResult = await factory.resolveCredentials(registration(`file:${tokenless}`), {});
    assert.equal(tokenlessResult.status, "invalid");
    if (tokenlessResult.status === "invalid") {
      assert.equal(tokenlessResult.failureKind, "missing_field");
    }
  });
});

describe("curl factory identity", () => {
  it("defaults to the synthetic curl:local account id", async () => {
    const factory = new CurlCommAdapterFactory();
    const identity = await factory.probeIdentity({ botToken: "s3cret" });
    assert.equal(identity.accountId, DEFAULT_CURL_ACCOUNT_ID);
  });

  it("honors an explicit account id and rejects bad input", async () => {
    const factory = new CurlCommAdapterFactory();
    const identity = await factory.probeIdentity({ botToken: "s3cret", accountId: "curl:buildbox" });
    assert.equal(identity.accountId, "curl:buildbox");
    await assert.rejects(() => factory.probeIdentity({}), /botToken is required/);
    await assert.rejects(
      () => factory.probeIdentity({ botToken: "s3cret", accountId: "has space" }),
      /must not contain whitespace/,
    );
  });
});

describe("curl factory adapter construction", () => {
  it("creates a CurlCommAdapter bound to the resolved scope", () => {
    const factory = createCommAdapterFactory();
    const adapter = factory.create(
      { token: "s3cret", project: PROJECT, agent: "claude", allowedSenderIds: ["ci"] },
      DEFAULT_CURL_ACCOUNT_ID as AccountId,
    );
    assert.ok(adapter instanceof CurlCommAdapter);
    assert.equal(adapter.id, "curl");
    assert.equal(adapter.accountId, DEFAULT_CURL_ACCOUNT_ID);
    assert.deepEqual(adapter.allowedSenderIds, ["ci"]);
  });

  it("fails loudly when required credentials are missing", () => {
    const factory = new CurlCommAdapterFactory();
    assert.throws(
      () => factory.create({ project: PROJECT, agent: "claude" }, "curl:local" as AccountId),
      /token, project, and agent are required/,
    );
  });
});

describe("curl factory outbound IPC surface", () => {
  it("registers curl_send/curl_send_image handlers that reject with the inbound-only diagnostic", async () => {
    const factory = new CurlCommAdapterFactory();
    const methods = factory.ipcMethods({} as never);
    assert.deepEqual(Array.from(methods.keys()).sort(), ["curl_send", "curl_send_image"]);
    for (const handler of methods.values()) {
      await assert.rejects(() => handler({}, {} as never), /inbound-only/);
    }
  });
});
