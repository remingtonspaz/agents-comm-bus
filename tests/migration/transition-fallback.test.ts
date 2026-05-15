import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  TRANSITION_CLEANUP_RELEASE,
  TRANSITION_ONLY_MARKER,
} from "../../agents-comm-bus/src/migrations/legacy-readers.js";

describe("transition fallback markers and docs", () => {
  it("marks retained fallback behavior as temporary in code", () => {
    assert.equal(TRANSITION_ONLY_MARKER, "transition-only");
    assert.equal(TRANSITION_CLEANUP_RELEASE, "v4.1-cleanup");
  });

  it("documents fallback limits and cleanup window", () => {
    const doc = readFileSync("docs/architecture/transition-release.md", "utf8");

    assert.match(doc, /transition-only/);
    assert.match(doc, /v4\.1-cleanup/);
    assert.match(doc, /last-chat\.json/);
    assert.match(doc, /pending-permission\.json/);
    assert.match(doc, /must not start Telegram polling outside the daemon/);
  });
});
