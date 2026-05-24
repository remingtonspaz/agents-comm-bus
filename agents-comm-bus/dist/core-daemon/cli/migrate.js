#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { importLastChat } from "../migrations/import-last-chat.js";
import { importPendingPermission } from "../migrations/import-pending-permission.js";
import { discoverLegacyInputs, TRANSITION_CLEANUP_RELEASE, TRANSITION_ONLY_MARKER, } from "../migrations/legacy-readers.js";
export function runMigration(options) {
    const startedAt = options.now ?? Date.now();
    const projectRoot = resolve(options.projectRoot);
    const homeDir = resolve(options.homeDir ?? homedir());
    const audit = [
        { kind: "migration_scan_started", timestamp: startedAt, detail: { project_root: projectRoot, home_dir: homeDir } },
    ];
    const discovery = discoverLegacyInputs({ projectRoot, homeDir, now: startedAt });
    const warnings = [];
    const credentials = discovery.credentials.map((candidate) => {
        audit.push({
            kind: "credential_candidate_found",
            timestamp: startedAt,
            detail: sanitizedCredential(candidate),
            transition: TRANSITION_ONLY_MARKER,
            cleanupRelease: TRANSITION_CLEANUP_RELEASE,
        });
        const confirmed = credentialConfirmed(candidate, options.confirmCredentials ?? "none");
        audit.push({
            kind: confirmed ? "credential_registration_accepted" : "credential_registration_skipped",
            timestamp: startedAt,
            detail: { ...sanitizedCredential(candidate), reason: confirmed ? "explicitly_confirmed" : "explicit_confirmation_required" },
            transition: TRANSITION_ONLY_MARKER,
            cleanupRelease: TRANSITION_CLEANUP_RELEASE,
        });
        return { ...sanitizedCredential(candidate), confirmed };
    });
    const lastChatImports = [];
    const pendingImports = [];
    if (options.ingestState ?? true) {
        for (const file of discovery.lastChats) {
            const imported = importLastChat(file, { project: projectRoot });
            lastChatImports.push(imported);
            audit.push({ ...imported.audit, timestamp: startedAt });
        }
        for (const file of discovery.pendingPermissions) {
            const imported = importPendingPermission(file, {
                sessionId: `legacy:${file.agent}:${file.sessionRoot}`,
                now: startedAt,
            });
            pendingImports.push(imported);
            audit.push({ ...imported.audit, timestamp: startedAt });
        }
    }
    for (const skipped of discovery.skipped) {
        audit.push({
            kind: "legacy_state_skipped",
            timestamp: startedAt,
            detail: { source: skipped.kind, agent: skipped.agent, path: skipped.path, reason: skipped.reason },
            transition: TRANSITION_ONLY_MARKER,
            cleanupRelease: TRANSITION_CLEANUP_RELEASE,
        });
    }
    audit.push({
        kind: "migration_scan_completed",
        timestamp: startedAt,
        detail: {
            credentials: discovery.credentials.length,
            session_roots: discovery.sessionRoots.length,
            skipped: discovery.skipped.length,
        },
    });
    if (credentials.some((credential) => credential.hasBotToken && !credential.confirmed)) {
        warnings.push("Credential candidates were discovered but not registered because explicit confirmation was not provided.");
    }
    const result = {
        schema_version: 1,
        started_at: startedAt,
        completed_at: options.now ?? Date.now(),
        project_root: projectRoot,
        home_dir: homeDir,
        credentials,
        state_ingestion: {
            mode: options.ingestState ?? true ? "read-only" : "disabled",
            last_chat: lastChatImports,
            pending_permission: pendingImports,
            queue_files_seen: discovery.queues.length,
        },
        audit_events: audit,
        warnings,
        transition: TRANSITION_ONLY_MARKER,
        cleanupRelease: TRANSITION_CLEANUP_RELEASE,
    };
    if (options.outputJsonPath) {
        writeFileSync(options.outputJsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    return result;
}
export function parseMigrateArgs(argv) {
    const options = { projectRoot: process.cwd(), homeDir: homedir(), confirmCredentials: "none", ingestState: true };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--project")
            options.projectRoot = requireValue(argv, ++index, arg);
        else if (arg === "--home")
            options.homeDir = requireValue(argv, ++index, arg);
        else if (arg === "--confirm-credentials") {
            const value = requireValue(argv, ++index, arg);
            options.confirmCredentials = value === "all" ? "all" : value.split(",").map((item) => item.trim()).filter(Boolean);
        }
        else if (arg === "--no-state-ingest")
            options.ingestState = false;
        else if (arg === "--json-out")
            options.outputJsonPath = requireValue(argv, ++index, arg);
        else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }
        else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}
function sanitizedCredential(candidate) {
    return {
        agent: candidate.agent,
        path: candidate.path,
        scope: candidate.scope,
        hasBotToken: candidate.hasBotToken,
        userIds: candidate.userIds,
        credentialRef: candidate.credentialRef,
    };
}
function credentialConfirmed(candidate, confirmation) {
    if (confirmation === "all")
        return true;
    if (confirmation === "none" || confirmation == null)
        return false;
    return confirmation.includes(candidate.credentialRef) || confirmation.includes(candidate.path);
}
function requireValue(argv, index, flag) {
    const value = argv[index];
    if (!value)
        throw new Error(`${flag} requires a value`);
    return value;
}
function printHelp() {
    console.log(`agents-comm-bus migrate

Scans transition-only legacy Telegram files and emits an auditable migration result.

Options:
  --project <path>                 Project root to scan. Defaults to cwd.
  --home <path>                    Home directory containing legacy roots. Defaults to OS home.
  --confirm-credentials <all|refs> Explicitly accept credential refs or paths. Required for registration.
  --no-state-ingest                Disable read-only last-chat/pending-permission ingestion.
  --json-out <path>                Write result JSON to a file.
`);
}
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
    try {
        const result = runMigration(parseMigrateArgs(process.argv.slice(2)));
        console.log(JSON.stringify(result, null, 2));
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
//# sourceMappingURL=migrate.js.map