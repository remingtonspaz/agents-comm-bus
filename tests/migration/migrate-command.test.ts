import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseMigrateArgs, runMigration } from "../../agents-comm-bus/src/cli/migrate.js";
import { legacySessionDirForProject } from "../../agents-comm-bus/src/migrations/legacy-readers.js";

describe("migrate command behavior", () => {
  it("requires explicit credential confirmation but ingests state read-only", () => {
    const root = mkdtempSync(join(tmpdir(), "acb-migrate-"));
    const project = join(root, "project");
    const home = join(root, "home");
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".codex", "telegram.json"), JSON.stringify({ botToken: "do-not-report", userId: "321" }));
    const sessionDir = legacySessionDirForProject(project, "codex", home);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "last-chat.json"), JSON.stringify({ chat_id: "777", updated_at: "2026-05-15T12:00:00.000Z" }));

    const result = runMigration({ projectRoot: project, homeDir: home, now: Date.parse("2026-05-15T12:01:00.000Z") });

    assert.equal(result.credentials[0].confirmed, false);
    assert.equal(result.state_ingestion.mode, "read-only");
    assert.equal(result.state_ingestion.last_chat.length, 1);
    assert.equal(result.audit_events.some((event) => event.kind === "credential_registration_skipped"), true);
    assert.equal(result.audit_events.some((event) => event.kind === "legacy_state_imported"), true);
    assert.equal(JSON.stringify(result).includes("do-not-report"), false);
  });

  it("accepts explicit credential confirmation by ref", () => {
    const root = mkdtempSync(join(tmpdir(), "acb-migrate-confirm-"));
    const project = join(root, "project");
    const home = join(root, "home");
    const credentialPath = join(project, ".claude", "telegram.json");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(credentialPath, JSON.stringify({ botToken: "secret", userId: "123" }));

    const result = runMigration({
      projectRoot: project,
      homeDir: home,
      now: Date.parse("2026-05-15T12:01:00.000Z"),
      confirmCredentials: [`legacy-file:${credentialPath}`],
    });

    assert.equal(result.credentials[0].confirmed, true);
    assert.equal(result.audit_events.some((event) => event.kind === "credential_registration_accepted"), true);
  });

  it("parses CLI flags for daemon-guided migration", () => {
    const options = parseMigrateArgs(["--project", "p", "--home", "h", "--confirm-credentials", "all", "--no-state-ingest"]);

    assert.equal(options.projectRoot, "p");
    assert.equal(options.homeDir, "h");
    assert.equal(options.confirmCredentials, "all");
    assert.equal(options.ingestState, false);
  });
});
