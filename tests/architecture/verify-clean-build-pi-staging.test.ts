/**
 * AGE-92: verify-clean-build must stage Pi artifacts before its drift check.
 *
 * The gate's status check already watches all of plugins/ (ARTIFACT_PATHS), but
 * scripts/stage-pi-plugins.js was never invoked before the check ran — so stale
 * Pi bundles were invisible (found in AGE-89 review: four Pi packages shipped a
 * stale daemon while the gate reported green).
 *
 * These are wiring assertions against the gate's source: removing the stager
 * invocation, moving it after the status check, or "fixing" the wrong side
 * (touching ARTIFACT_PATHS instead of staging) must turn a test red. The
 * behavioral acceptance (revert a Pi artifact → gate red; two consecutive
 * stagings → zero drift) is verified by mutation at review time, since running
 * the full gate inside a unit test would rebuild the entire repo.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gateSource = readFileSync(
  join(repoRoot, "scripts", "verify-clean-build.mjs"),
  "utf8",
);

const STAGE_PLUGINS_CALL = 'run("node scripts/stage-plugins.js")';
const STAGE_PI_CALL = 'run("node scripts/stage-pi-plugins.js")';

describe("AGE-92 verify-clean-build stages Pi artifacts", () => {
  it("invokes stage-pi-plugins.js", () => {
    assert.ok(
      gateSource.includes(STAGE_PI_CALL),
      "verify-clean-build.mjs does not invoke scripts/stage-pi-plugins.js — " +
        "Pi artifacts are never regenerated before the drift check",
    );
  });

  it("stages Pi AFTER stage-plugins.js and BEFORE the git status drift check", () => {
    const stageIdx = gateSource.indexOf(STAGE_PLUGINS_CALL);
    const stagePiIdx = gateSource.indexOf(STAGE_PI_CALL);
    const statusIdx = gateSource.indexOf("git status --porcelain");
    assert.ok(stageIdx !== -1, "stage-plugins.js invocation missing");
    assert.ok(stagePiIdx !== -1, "stage-pi-plugins.js invocation missing");
    assert.ok(statusIdx !== -1, "git status drift check missing");
    assert.ok(
      stageIdx < stagePiIdx && stagePiIdx < statusIdx,
      `ordering wrong: stage-plugins=${stageIdx} stage-pi=${stagePiIdx} status=${statusIdx} — ` +
        "Pi staging must happen after the Claude/Codex staging and before the drift check",
    );
  });

  it("leaves ARTIFACT_PATHS watching the whole plugins tree (the wrong fix touches this)", () => {
    // The plausible wrong fix is "add Pi to the watched paths" — the check side
    // was never the defect. Pin the watched set so that change is visible.
    const match = gateSource.match(/const ARTIFACT_PATHS = \[([^\]]*)\]/);
    assert.ok(match, "ARTIFACT_PATHS declaration not found");
    const paths = match[1];
    assert.ok(paths.includes('"plugins"'), "ARTIFACT_PATHS must keep watching plugins/");
    assert.ok(
      !paths.includes("plugins/pi"),
      "ARTIFACT_PATHS should not gain a Pi-specific entry — the defect was staging, not watching",
    );
  });

  it("failure message names stage-pi-plugins.js as part of the fix", () => {
    assert.ok(
      gateSource.includes("stage-pi-plugins.js` and commit"),
      "stale-artifact failure message must name stage-pi-plugins.js — " +
        "a gate that fails without naming the fix command gets worked around",
    );
  });
});
