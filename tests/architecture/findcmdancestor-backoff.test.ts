import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findCmdAncestor } from "../../hosts/claude/hooks/wake-support.js";

const resolved = { pid: 100, hwnd: 200, claudePid: 50 };

function testDeps(
  readChain: () => typeof resolved | null,
  options: {
    backoffMs?: number[];
    sleepCalls?: number[];
  } = {},
) {
  const sleepCalls = options.sleepCalls ?? [];
  return {
    platform: "win32" as const,
    backoffMs: options.backoffMs ?? [0, 500, 1000],
    readChain,
    sleep: (ms: number) => {
      sleepCalls.push(ms);
    },
    _sleepCalls: sleepCalls,
  };
}

describe("findCmdAncestor backoff retry", () => {
  it("transient then success: retries until cmd->claude match on attempt 3", () => {
    let reads = 0;
    const deps = testDeps(() => {
      reads += 1;
      if (reads < 3) return null;
      return resolved;
    });

    const result = findCmdAncestor(() => {}, deps);

    assert.deepEqual(result, resolved);
    assert.equal(reads, 3);
    assert.deepEqual(deps._sleepCalls, [500, 1000]);
  });

  it("permanent no-match: stops after bounded attempts", () => {
    let reads = 0;
    const deps = testDeps(() => {
      reads += 1;
      return null;
    });

    const result = findCmdAncestor(() => {}, deps);

    assert.equal(result, null);
    assert.equal(reads, 3);
    assert.deepEqual(deps._sleepCalls, [500, 1000]);
  });

  it("happy path: match on first attempt adds zero latency", () => {
    let reads = 0;
    const deps = testDeps(() => {
      reads += 1;
      return resolved;
    });

    const result = findCmdAncestor(() => {}, deps);

    assert.deepEqual(result, resolved);
    assert.equal(reads, 1);
    assert.deepEqual(deps._sleepCalls, []);
  });
});
