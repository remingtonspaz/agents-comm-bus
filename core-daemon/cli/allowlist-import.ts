import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CommId } from "../../packages/core-contracts/dist/index.js";
import { resolveStatePaths } from "../paths.js";
import { openSqliteStorage } from "../storage/sqlite.js";

export interface ImportFromEnvOptions {
  comm?: string;
}

export interface ImportFromFilesOptions {
  comm?: string;
  dryRun?: boolean;
}

export interface ImportResult {
  comm: string;
  added: number;
  skipped: number;
  details: Array<{ scope: "global" | "per-bot"; bot_user_id?: string; sender_id: string; status: "added" | "duplicate" | "would-add" }>;
}

/**
 * Read `process.env.TELEGRAM_USER_ID` CSV and seed `allowlist_global` rows
 * for the given comm. Idempotent — PK collisions count as "duplicate". The
 * env var continues to flow into the union at adapter attach time; this
 * just persists a snapshot.
 */
export async function allowlistImportFromEnv(
  options: ImportFromEnvOptions = {},
): Promise<ImportResult> {
  const comm = (options.comm ?? "telegram") as CommId;
  if (comm !== "telegram") {
    throw new Error(`import-from-env: only telegram supported in this slice (got ${comm})`);
  }
  const raw = process.env.TELEGRAM_USER_ID ?? "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const storage = await openSqliteStorage(resolveStatePaths().database);
  const details: ImportResult["details"] = [];
  let added = 0;
  let skipped = 0;
  try {
    for (const sender_id of ids) {
      const before = await storage.listAllowlistGlobal({ comm });
      const existed = before.some((row) => row.sender_id === sender_id);
      await storage.addAllowlistGlobal({
        comm,
        sender_id,
        added_at: Date.now(),
        added_by: "migration:env",
      });
      if (existed) {
        details.push({ scope: "global", sender_id, status: "duplicate" });
        skipped += 1;
      } else {
        details.push({ scope: "global", sender_id, status: "added" });
        added += 1;
      }
    }
  } finally {
    await storage.close();
  }
  return { comm, added, skipped, details };
}

/**
 * Walk all account_registrations whose `credentials_ref` is `file:<path>`
 * and try to read the `userId` field (string, number, or array) out of
 * that JSON file. Each id becomes an `allowlist_per_bot` row scoped to
 * that registration's `bot_user_id`. Idempotent.
 */
export async function allowlistImportFromFiles(
  options: ImportFromFilesOptions = {},
): Promise<ImportResult> {
  const comm = (options.comm ?? "telegram") as CommId;
  if (comm !== "telegram") {
    throw new Error(
      `import-from-files: only telegram supported in this slice (got ${comm})`,
    );
  }
  const storage = await openSqliteStorage(resolveStatePaths().database);
  const details: ImportResult["details"] = [];
  let added = 0;
  let skipped = 0;
  try {
    const registrations = await storage.listAccountRegistrations({ comm });
    for (const reg of registrations) {
      const filePath = filePathFromCredentialsRef(reg.credentials_ref, reg.project);
      if (!filePath) continue;
      const ids = await readUserIdsFromJson(filePath);
      for (const sender_id of ids) {
        const before = await storage.listAllowlistPerBot({
          comm,
          bot_user_id: reg.bot_user_id,
        });
        const existed = before.some((row) => row.sender_id === sender_id);
        if (options.dryRun) {
          details.push({
            scope: "per-bot",
            bot_user_id: reg.bot_user_id,
            sender_id,
            status: existed ? "duplicate" : "would-add",
          });
          if (!existed) added += 1;
          else skipped += 1;
          continue;
        }
        await storage.addAllowlistPerBot({
          comm,
          bot_user_id: reg.bot_user_id,
          sender_id,
          added_at: Date.now(),
          added_by: "migration:file",
        });
        if (existed) {
          details.push({
            scope: "per-bot",
            bot_user_id: reg.bot_user_id,
            sender_id,
            status: "duplicate",
          });
          skipped += 1;
        } else {
          details.push({
            scope: "per-bot",
            bot_user_id: reg.bot_user_id,
            sender_id,
            status: "added",
          });
          added += 1;
        }
      }
    }
  } finally {
    await storage.close();
  }
  return { comm, added, skipped, details };
}

function filePathFromCredentialsRef(ref: string | undefined, project: string): string | null {
  if (!ref) return null;
  if (ref.startsWith("file:")) {
    return ref.slice("file:".length);
  }
  // env:<NAME> path — file fallback is at project/.claude/telegram.json by convention.
  if (ref.startsWith("env:")) {
    return path.join(project, ".claude", "telegram.json");
  }
  return null;
}

async function readUserIdsFromJson(filePath: string): Promise<string[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as { userId?: unknown };
    return normalizeUserIdField(parsed.userId);
  } catch {
    return [];
  }
}

function normalizeUserIdField(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((v) => (typeof v === "string" || typeof v === "number" ? String(v) : ""))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") return [raw.trim()].filter(Boolean);
  if (typeof raw === "number") return [String(raw)];
  return [];
}
