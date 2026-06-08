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

function planAccountRegistrationUpdates(rows) {
  const updates = [];
  const deletes = [];
  const byTargetKey = new Map();

  for (const row of rows) {
    const canonical = normalizeProjectPath(row.project);
    if (canonical === row.project) continue;
    const targetKey = `${canonical}\0${row.comm}\0${row.agent}\0${row.account_label}`;
    const existing = byTargetKey.get(targetKey);
    if (!existing) {
      byTargetKey.set(targetKey, row);
      updates.push({ row, canonical });
      continue;
    }
    const keepExisting =
      Number(row.updated_at ?? row.created_at ?? 0) >
      Number(existing.updated_at ?? existing.created_at ?? 0);
    if (keepExisting) {
      deletes.push({ row: existing, reason: "superseded by newer duplicate after canonicalize" });
      byTargetKey.set(targetKey, row);
      const idx = updates.findIndex((u) => u.row.registration_id === existing.registration_id);
      if (idx >= 0) updates.splice(idx, 1);
      updates.push({ row, canonical });
      deletes.push({ row: existing, reason: "duplicate after canonicalize" });
    } else {
      deletes.push({ row, reason: "duplicate after canonicalize" });
    }
  }

  const botCollisions = new Map();
  for (const row of rows) {
    const canonical = normalizeProjectPath(row.project);
    const botKey = `${row.comm}\0${row.bot_user_id}`;
    const list = botCollisions.get(botKey) ?? [];
    list.push({ ...row, canonical });
    botCollisions.set(botKey, list);
  }
  for (const [, group] of botCollisions) {
    const canonicalProjects = new Set(group.map((r) => r.canonical));
    if (canonicalProjects.size <= 1 && group.length <= 1) continue;
    if (group.length > 1 && canonicalProjects.size === 1) {
      const sorted = [...group].sort(
        (a, b) => Number(b.updated_at ?? b.created_at ?? 0) - Number(a.updated_at ?? a.created_at ?? 0),
      );
      const keeper = sorted[0];
      for (const loser of sorted.slice(1)) {
        if (!deletes.some((d) => d.row.registration_id === loser.registration_id)) {
          deletes.push({ row: loser, reason: "same bot after canonicalize; keeping newest" });
        }
        const updateIdx = updates.findIndex((u) => u.row.registration_id === loser.registration_id);
        if (updateIdx >= 0) updates.splice(updateIdx, 1);
      }
      if (keeper.project !== keeper.canonical && !updates.some((u) => u.row.registration_id === keeper.registration_id)) {
        updates.push({ row: keeper, canonical: keeper.canonical });
      }
    }
  }

  const ambiguous = [];
  const projected = rows.map((row) => ({
    ...row,
    canonical: normalizeProjectPath(row.project),
  }));
  const labelGroups = new Map();
  for (const row of projected) {
    const key = `${row.canonical}\0${row.comm}\0${row.agent}\0${row.account_label}`;
    const list = labelGroups.get(key) ?? [];
    list.push(row);
    labelGroups.set(key, list);
  }
  for (const [key, group] of labelGroups) {
    const bots = new Set(group.map((r) => r.bot_user_id));
    if (bots.size > 1) {
      ambiguous.push({
        kind: "account_registrations",
        key,
        registration_ids: group.map((r) => r.registration_id),
        bot_user_ids: [...bots],
      });
    }
  }

  return { updates, deletes, ambiguous };
}

function planSessionUpdates(rows) {
  const updates = [];
  const deletes = [];
  const ambiguous = [];

  const projected = rows.map((row) => ({
    ...row,
    canonical: normalizeProjectPath(row.project),
  }));

  const leaseGroups = new Map();
  for (const row of projected) {
    if (row.status !== "active" || !row.lease_holder_connection_id) continue;
    const key = `${row.agent}\0${row.canonical}`;
    const list = leaseGroups.get(key) ?? [];
    list.push(row);
    leaseGroups.set(key, list);
  }
  for (const [key, group] of leaseGroups) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort(
      (a, b) => Number(b.created_at ?? 0) - Number(a.created_at ?? 0),
    );
    const keeper = sorted[0];
    for (const loser of sorted.slice(1)) {
      deletes.push({ row: loser, reason: `active lease collision on ${key}; keeping ${keeper.session_id}` });
    }
  }

  for (const row of projected) {
    if (row.canonical === row.project) continue;
    if (deletes.some((d) => d.row.session_id === row.session_id)) continue;
    const key = `${row.agent}\0${row.canonical}`;
    const activePeers = (leaseGroups.get(key) ?? []).filter((p) => p.session_id !== row.session_id);
    if (
      row.status === "active" &&
      row.lease_holder_connection_id &&
      activePeers.some((p) => !deletes.some((d) => d.row.session_id === p.session_id))
    ) {
      ambiguous.push({
        kind: "sessions",
        key,
        session_ids: [row.session_id, ...activePeers.map((p) => p.session_id)],
      });
      continue;
    }
    updates.push({ row, canonical: row.canonical });
  }

  return { updates, deletes, ambiguous };
}

function applyPlan(db, { accountPlan, sessionPlan, dryRun }) {
  if (accountPlan.ambiguous.length > 0 || sessionPlan.ambiguous.length > 0) {
    console.error("\nABORT: ambiguous collisions require manual remediation:");
    for (const item of [...accountPlan.ambiguous, ...sessionPlan.ambiguous]) {
      console.error(JSON.stringify(item, null, 2));
    }
    process.exit(1);
  }

  console.log(`\n=== Apply plan (${dryRun ? "DRY-RUN" : "WRITING"}) ===`);
  for (const { row, canonical } of accountPlan.updates) {
    console.log(`  UPDATE account_registrations ${row.registration_id}: ${JSON.stringify(row.project)} -> ${JSON.stringify(canonical)}`);
    if (!dryRun) {
      db.prepare("UPDATE account_registrations SET project = ?, updated_at = ? WHERE registration_id = ?")
        .run(canonical, Date.now(), row.registration_id);
    }
  }
  for (const { row, reason } of accountPlan.deletes) {
    console.log(`  DELETE account_registrations ${row.registration_id} (${reason})`);
    if (!dryRun) {
      db.prepare("DELETE FROM account_registrations WHERE registration_id = ?").run(row.registration_id);
    }
  }
  for (const { row, canonical } of sessionPlan.updates) {
    console.log(`  UPDATE sessions ${row.session_id}: ${JSON.stringify(row.project)} -> ${JSON.stringify(canonical)}`);
    if (!dryRun) {
      db.prepare("UPDATE sessions SET project = ? WHERE session_id = ?").run(canonical, row.session_id);
    }
  }
  for (const { row, reason } of sessionPlan.deletes) {
    console.log(`  DELETE sessions ${row.session_id} (${reason})`);
    if (!dryRun) {
      db.prepare("DELETE FROM sessions WHERE session_id = ?").run(row.session_id);
    }
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.apply && !flags.backupAck) {
    console.error("Refusing --apply without --i-have-a-backup.");
    console.error(`Back up first:\n  Copy-Item "${flags.dbPath}" "${flags.dbPath}.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"`);
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
