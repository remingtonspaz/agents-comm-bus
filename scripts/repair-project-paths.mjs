#!/usr/bin/env node
/**
 * One-time local repair: canonicalize account_registrations.project and
 * sessions.project. Does NOT touch conversations or transcript files.
 *
 * Dry-run by default. Apply requires --apply --i-have-a-backup.
 * Stop the daemon before --apply.
 */
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { normalizeProjectPath } from "../agents-comm-bus/dist/core-daemon/project-path.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDb = path.join(os.homedir(), ".agents-comm-bus", "agents-comm-bus.db");

function parseArgs(argv) {
  const flags = {
    apply: false,
    backupAck: false,
    dbPath: defaultDb,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--i-have-a-backup") flags.backupAck = true;
    else if (arg === "--db") flags.dbPath = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

function printHelp() {
  console.log(`repair-project-paths.mjs — canonicalize stored project paths (dry-run by default)

Usage:
  node scripts/repair-project-paths.mjs [--db <path>]
  node scripts/repair-project-paths.mjs --apply --i-have-a-backup [--db <path>]

Before --apply:
  1. Stop the agents-comm-bus daemon (remove port + daemon.pid or Stop-Process the pid).
  2. Back up the database:
     Copy-Item "$env:USERPROFILE\\.agents-comm-bus\\agents-comm-bus.db" \\
       "$env:USERPROFILE\\.agents-comm-bus\\agents-comm-bus.db.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"

Does NOT rewrite conversations or transcript files.`);
}

function distinctProjects(rows) {
  const map = new Map();
  for (const row of rows) {
    const raw = row.project;
    const canonical = normalizeProjectPath(raw);
    if (!map.has(raw)) {
      map.set(raw, { raw, canonical, count: 0 });
    }
    map.get(raw).count += 1;
  }
  return [...map.values()];
}

function printTable(title, rows) {
  console.log(`\n=== ${title} ===`);
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  const needsChange = rows.filter((entry) => entry.raw !== entry.canonical);
  for (const entry of rows) {
    const flag = entry.raw !== entry.canonical ? "NEEDS_CANONICALIZE" : "ok";
    console.log(`  ${flag}  raw=${JSON.stringify(entry.raw)}  canonical=${JSON.stringify(entry.canonical)}  rows=${entry.count}`);
  }
  const collisions = collisionGroups(rows);
  if (collisions.length > 0) {
    console.log("  COLLISION: distinct raw values map to the same canonical form:");
    for (const group of collisions) {
      console.log(`    canonical=${JSON.stringify(group.canonical)}  raw_values=${JSON.stringify(group.rawValues)}`);
    }
  }
  if (needsChange.length === 0) {
    console.log("  All project values already canonical.");
  }
}

function collisionGroups(distinctEntries) {
  const byCanonical = new Map();
  for (const entry of distinctEntries) {
    const list = byCanonical.get(entry.canonical) ?? [];
    list.push(entry.raw);
    byCanonical.set(entry.canonical, list);
  }
  return [...byCanonical.entries()]
    .filter(([, rawValues]) => rawValues.length > 1)
    .map(([canonical, rawValues]) => ({ canonical, rawValues }));
}

function loadRows(db, table) {
  return db.prepare(`SELECT * FROM ${table}`).all();
}

function summarizeRow(row) {
  return {
    project: row.project,
    canonical: normalizeProjectPath(row.project),
  };
}

function planAccountRegistrationUpdates(rows) {
  const projected = rows.map((row) => ({
    ...row,
    canonical: normalizeProjectPath(row.project),
  }));
  const collisions = [];

  const byLabelKey = new Map();
  for (const row of projected) {
    const key = `${row.canonical}\0${row.comm}\0${row.agent}\0${row.account_label}`;
    const list = byLabelKey.get(key) ?? [];
    list.push(row);
    byLabelKey.set(key, list);
  }
  for (const [key, group] of byLabelKey) {
    if (group.length <= 1) continue;
    const rawProjects = [...new Set(group.map((row) => row.project))];
    collisions.push({
      kind: "account_registrations",
      unique_index: "UNIQUE(project, comm, agent, account_label)",
      scope_key: key,
      raw_projects: rawProjects,
      rows: group.map((row) => ({
        registration_id: row.registration_id,
        ...summarizeRow(row),
        comm: row.comm,
        agent: row.agent,
        account_label: row.account_label,
        bot_user_id: row.bot_user_id,
      })),
    });
  }

  const byBotKey = new Map();
  for (const row of projected) {
    const key = `${row.comm}\0${row.bot_user_id}`;
    const list = byBotKey.get(key) ?? [];
    list.push(row);
    byBotKey.set(key, list);
  }
  for (const [key, group] of byBotKey) {
    if (group.length <= 1) continue;
    const rawProjects = [...new Set(group.map((row) => row.project))];
    collisions.push({
      kind: "account_registrations",
      unique_index: "UNIQUE(comm, bot_user_id)",
      scope_key: key,
      raw_projects: rawProjects,
      rows: group.map((row) => ({
        registration_id: row.registration_id,
        ...summarizeRow(row),
        comm: row.comm,
        agent: row.agent,
        account_label: row.account_label,
        bot_user_id: row.bot_user_id,
      })),
    });
  }

  const updates = projected
    .filter((row) => row.project !== row.canonical)
    .map((row) => ({ row, canonical: row.canonical }));

  return { updates, collisions };
}

function planSessionUpdates(rows) {
  const projected = rows.map((row) => ({
    ...row,
    canonical: normalizeProjectPath(row.project),
  }));
  const collisions = [];

  const activeLeased = projected.filter(
    (row) => row.status === "active" && row.lease_holder_connection_id,
  );
  const byAgentProject = new Map();
  for (const row of activeLeased) {
    const key = `${row.agent}\0${row.canonical}`;
    const list = byAgentProject.get(key) ?? [];
    list.push(row);
    byAgentProject.set(key, list);
  }
  for (const [key, group] of byAgentProject) {
    if (group.length <= 1) continue;
    const rawProjects = [...new Set(group.map((row) => row.project))];
    collisions.push({
      kind: "sessions",
      unique_index: "idx_sessions_one_live_lease_per_agent_project",
      scope_key: key,
      raw_projects: rawProjects,
      rows: group.map((row) => ({
        session_id: row.session_id,
        ...summarizeRow(row),
        agent: row.agent,
        status: row.status,
        lease_holder_connection_id: row.lease_holder_connection_id,
      })),
    });
  }

  const updates = projected
    .filter((row) => row.project !== row.canonical)
    .map((row) => ({ row, canonical: row.canonical }));

  return { updates, collisions };
}

function applyPlan(db, { accountPlan, sessionPlan, dryRun }) {
  const collisions = [...accountPlan.collisions, ...sessionPlan.collisions];
  if (collisions.length > 0) {
    console.error("\nABORT: project-path collisions require manual remediation:");
    for (const item of collisions) {
      console.error(JSON.stringify(item, null, 2));
    }
    process.exit(1);
  }

  console.log(`\n=== Apply plan (${dryRun ? "DRY-RUN" : "WRITING"}) ===`);
  for (const { row, canonical } of accountPlan.updates) {
    console.log(
      `  UPDATE account_registrations ${row.registration_id}: ${JSON.stringify(row.project)} -> ${JSON.stringify(canonical)}`,
    );
    if (!dryRun) {
      db.prepare(
        "UPDATE account_registrations SET project = ?, updated_at = ? WHERE registration_id = ?",
      ).run(canonical, Date.now(), row.registration_id);
    }
  }
  for (const { row, canonical } of sessionPlan.updates) {
    console.log(
      `  UPDATE sessions ${row.session_id}: ${JSON.stringify(row.project)} -> ${JSON.stringify(canonical)}`,
    );
    if (!dryRun) {
      db.prepare("UPDATE sessions SET project = ? WHERE session_id = ?").run(canonical, row.session_id);
    }
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.apply && !flags.backupAck) {
    console.error("Refusing --apply without --i-have-a-backup.");
    console.error(
      `Back up first:\n  Copy-Item "${flags.dbPath}" "${flags.dbPath}.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"`,
    );
    console.error("Stop the daemon before applying.");
    process.exit(1);
  }
  if (flags.apply) {
    console.error("Ensure the agents-comm-bus daemon is STOPPED before applying.");
  }

  const db = new DatabaseSync(flags.dbPath, { readOnly: !flags.apply });
  try {
    const accountRows = loadRows(db, "account_registrations");
    const sessionRows = loadRows(db, "sessions");
    const conversationRows = loadRows(db, "conversations");

    printTable("account_registrations.project", distinctProjects(accountRows));
    printTable("sessions.project", distinctProjects(sessionRows));
    printTable("conversations.project (informational only — NOT modified)", distinctProjects(conversationRows));

    const accountPlan = planAccountRegistrationUpdates(accountRows);
    const sessionPlan = planSessionUpdates(sessionRows);
    applyPlan(db, { accountPlan, sessionPlan, dryRun: !flags.apply });

    if (!flags.apply) {
      console.log("\nDry-run complete. Re-run with --apply --i-have-a-backup to write changes.");
    } else {
      console.log("\nApply complete.");
    }
  } finally {
    db.close();
  }
}

main();
