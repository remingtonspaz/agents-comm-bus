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

export const conversationBotIdentityMigration: Migration = {
  version: 5,
  description: "store receiving bot identity on conversations",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "005_conversation_bot_identity.sql"), "utf8");
    await ctx.exec(sql);
  },
};

export const registrationIdentityMigration: Migration = {
  version: 6,
  description: "add immutable registration_id surrogate to registrations + conversations",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "006_registration_identity.sql"), "utf8");
    await ctx.exec(sql);
  },
};

export const registrationPkMigration: Migration = {
  version: 7,
  description: "make registration_id the canonical primary key of account_registrations",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "007_registration_pk.sql"), "utf8");
    await ctx.exec(sql);
  },
};

export const conversationRegistrationKeyMigration: Migration = {
  version: 8,
  description: "re-key conversations on (registration_id, chat, thread) + drop account_label",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "008_conversation_registration_key.sql"), "utf8");
    await ctx.exec(sql);
  },
};

export const multiOpenQueriesMigration: Migration = {
  version: 9,
  description: "AGE-9: drop the one-open-query-per-session unique index (policy moves to callers)",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "009_multi_open_queries.sql"), "utf8");
    await ctx.exec(sql);
  },
};

export const durablePendingInboundMigration: Migration = {
  version: 10,
  description: "AGE-56: durable pending inbound delivery rows",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "010_durable_pending_inbound.sql"), "utf8");
    await ctx.exec(sql);
  },
};

export const sessionDaemonOwnerMigration: Migration = {
  version: 11,
  description: "AGE-58: stamp daemon-instance identity on session leases",
  async up(ctx) {
    const sql = await readFile(join(schemaDir, "011_session_daemon_owner.sql"), "utf8");
    await ctx.exec(sql);
  },
};

export async function runStorageMigrations(db: SqliteLike): Promise<void> {
  await new SqliteMigrationRunner(db).apply([
    initialMigration,
    conversationAgentIdentityMigration,
    allowlistMigration,
    sessionOwnerProcessMigration,
    conversationBotIdentityMigration,
    registrationIdentityMigration,
    registrationPkMigration,
    conversationRegistrationKeyMigration,
    multiOpenQueriesMigration,
    durablePendingInboundMigration,
    sessionDaemonOwnerMigration,
  ]);
}
