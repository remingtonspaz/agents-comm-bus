import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  IPC_FILES,
  contractFingerprint,
  evaluateProtocolChange,
  ipcProtocolContractFromContents,
} from "../../scripts/check-ipc-protocol-bump.mjs";

function baseFiles(): Record<string, string> {
  return Object.fromEntries(
    Object.values(IPC_FILES).map((file) => [file, readFileSync(file, "utf8")]),
  );
}

function contract(files: Record<string, string>) {
  return ipcProtocolContractFromContents(files);
}

test("IPC protocol fingerprint ignores implementation-only body changes", () => {
  const base = baseFiles();
  const changed = {
    ...base,
    [IPC_FILES.protocol]: base[IPC_FILES.protocol].replace(
      "Invalid agents-comm-bus IPC message type.",
      "Implementation-only wording changed.",
    ),
  };

  assert.equal(
    contractFingerprint(contract(changed)).hash,
    contractFingerprint(contract(base)).hash,
  );
  assert.equal(evaluateProtocolChange(contract(base), contract(changed)).reason, "unchanged");
});

test("IPC protocol fingerprint fails a wire-shape change without a protocol bump", () => {
  const base = baseFiles();
  const changed = {
    ...base,
    [IPC_FILES.protocol]: addDaemonHelloCapability(base[IPC_FILES.protocol]),
  };

  const result = evaluateProtocolChange(contract(base), contract(changed));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing-protocol-bump");
  assert.match(
    result.diffs.map((d) => d.path).join("\n"),
    /DaemonHello\.properties\.capabilities/,
  );
});

test("IPC protocol fingerprint accepts a wire-shape change with a protocol bump", () => {
  const base = baseFiles();
  const changed = {
    ...base,
    [IPC_FILES.config]: base[IPC_FILES.config].replace(
      'export const IPC_PROTOCOL_VERSION = "1.0.0";',
      'export const IPC_PROTOCOL_VERSION = "1.1.0";',
    ),
    [IPC_FILES.protocol]: addDaemonHelloCapability(base[IPC_FILES.protocol]),
  };

  const result = evaluateProtocolChange(contract(base), contract(changed));
  assert.equal(result.ok, true);
  assert.equal(result.reason, "protocol-bumped");
  assert.equal(result.baseProtocol, "1.0.0");
  assert.equal(result.headProtocol, "1.1.0");
});

test("IPC protocol fingerprint accepts a deliberate compat note", () => {
  const base = baseFiles();
  const changed = {
    ...base,
    [IPC_FILES.protocol]: addDaemonHelloCapability(base[IPC_FILES.protocol]),
  };

  const result = evaluateProtocolChange(contract(base), contract(changed), { compatNote: true });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "compat-note");
});

function addDaemonHelloCapability(source: string): string {
  return source.replace(
    /(  daemonName: typeof DAEMON_NAME;\r?\n  metadata: DiagnosticMetadata;\r?\n)(})/,
    "$1  capabilities?: readonly string[];\n$2",
  );
}
