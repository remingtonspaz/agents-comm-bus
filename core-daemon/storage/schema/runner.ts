import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Migration,
  MigrationRunner,
} from "agents-comm-bus-core";

export interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

export class SqliteMigrationRunner implements MigrationRunner {
  constructor(private readonly db: SqliteLike) {}

  async getCurrentVersion(): Promise<number> {
    const row = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    return row.user_version;
  }

  async setVersion(version: number): Promise<void> {
    this.db.exec(`PRAGMA user_version = ${version}`);
  }

  async apply(migrations: Migration[]): Promise<void> {
    const current = await this.getCurrentVersion();
    const pending = migrations
      .filter((migration) => migration.version > current)
      .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
      await migration.up({ exec: async (sql) => this.db.exec(sql) });
      await this.setVersion(migration.version);
    }
  }
}

const schemaDir = dirname(fileURLToPath(import.meta.url));

export const initialMigration: Migration = {
  version: 1,
  description: "initial storage schema",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "001_initial.sql"), "utf8");
    await ctx.exec(sql);
  },
};

export const conversationAgentIdentityMigration: Migration = {
  version: 2,
  description: "include agent in conversation identity",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "002_conversation_agent_identity.sql"), "utf8");
    await ctx.exec(sql);
  },
};

export const allowlistMigration: Migration = {
  version: 3,
  description: "add allowlist_global and allowlist_per_bot tables",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "003_allowlist.sql"), "utf8");
    await ctx.exec(sql);
  },
};

export const sessionOwnerProcessMigration: Migration = {
  version: 4,
  description: "track owning agent process for session leases",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "004_session_owner_process.sql"), "utf8");
    await ctx.exec(sql);
  },
};

export async function runStorageMigrations(db: SqliteLike): Promise<void> {
  await new SqliteMigrationRunner(db).apply([
    initialMigration,
    conversationAgentIdentityMigration,
    allowlistMigration,
    sessionOwnerProcessMigration,
  ]);
}
