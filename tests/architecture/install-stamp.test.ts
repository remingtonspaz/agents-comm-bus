import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildInstallStamp,
  INSTALL_STAMP_SCHEMA,
} from "../../hosts/common/install/install-stamp.js";

// ---------------------------------------------------------------------------
// buildInstallStamp: the writer side of install-stamp.json. Pure — no build or
// staged artifacts needed. readInstallStamp (ensure-central-install.js) is the
// reader; both agree on shape + strictness.
// ---------------------------------------------------------------------------

const VALID = {
  agent: "claude",
  comm: "telegram",
  pluginVersion: "1.2.0",
  daemonBundleVersion: "2.0.0",
  adapterBundleVersion: "0.1.0",
};

describe("buildInstallStamp", () => {
  it("maps the three independent versions into the stamp shape", () => {
    const stamp = buildInstallStamp(VALID);
    assert.equal(stamp.schema_version, INSTALL_STAMP_SCHEMA);
    assert.equal(stamp.agent, "claude");
    assert.equal(stamp.comm, "telegram");
    assert.equal(stamp.plugin_version, "1.2.0");
    assert.equal(stamp.daemon_bundle_version, "2.0.0");
    assert.equal(stamp.adapter_bundle_version, "0.1.0");
    assert.deepEqual(stamp.adapter_bundle_versions, { telegram: "0.1.0" });
  });

  it("keeps the three versions independent — none derived from another", () => {
    // Distinct inputs must surface as distinct, correctly-placed fields, so a
    // plugin-version bump can never masquerade as an adapter/daemon change.
    const stamp = buildInstallStamp({
      agent: "codex",
      comm: "telegram",
      pluginVersion: "9.9.9",
      daemonBundleVersion: "2.0.0",
      adapterBundleVersion: "0.1.0",
    });
    assert.equal(stamp.plugin_version, "9.9.9");
    assert.equal(stamp.daemon_bundle_version, "2.0.0");
    assert.equal(stamp.adapter_bundle_version, "0.1.0");
    // The content keys must NOT equal the (higher) plugin_version.
    assert.notEqual(stamp.daemon_bundle_version, stamp.plugin_version);
    assert.notEqual(stamp.adapter_bundle_version, stamp.plugin_version);
    assert.deepEqual(stamp.adapter_bundle_versions, { telegram: "0.1.0" });
  });

  it("accepts an explicit adapterBundleVersions map when it matches the stamped comm", () => {
    const stamp = buildInstallStamp({
      ...VALID,
      adapterBundleVersions: { telegram: "0.1.0", discord: "0.2.0" },
    });
    assert.equal(stamp.adapter_bundle_version, "0.1.0");
    assert.deepEqual(stamp.adapter_bundle_versions, { telegram: "0.1.0", discord: "0.2.0" });
  });

  it("throws when adapterBundleVersions disagrees with adapterBundleVersion for the stamped comm", () => {
    assert.throws(
      () =>
        buildInstallStamp({
          ...VALID,
          adapterBundleVersions: { telegram: "9.9.9" },
        }),
      /adapterBundleVersions must include the stamped comm/,
    );
  });

  it("produces a stamp readInstallStamp accepts (schema_version === 1, three version strings)", () => {
    const stamp = buildInstallStamp(VALID);
    assert.equal(stamp.schema_version, 1);
    assert.equal(typeof stamp.plugin_version, "string");
    assert.equal(typeof stamp.daemon_bundle_version, "string");
    assert.equal(typeof stamp.adapter_bundle_version, "string");
  });

  for (const missing of [
    "agent",
    "comm",
    "pluginVersion",
    "daemonBundleVersion",
    "adapterBundleVersion",
  ] as const) {
    it(`throws when ${missing} is missing (fail loud at stage time)`, () => {
      const fields: Record<string, string> = { ...VALID };
      delete fields[missing];
      assert.throws(() => buildInstallStamp(fields as never), new RegExp(missing));
    });
  }

  it("throws on an empty-string version rather than emitting a bad stamp", () => {
    assert.throws(() => buildInstallStamp({ ...VALID, adapterBundleVersion: "" }), /adapterBundleVersion/);
  });
});
