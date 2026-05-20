import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
export class SqliteMigrationRunner {
    db;
    constructor(db) {
        this.db = db;
    }
    async getCurrentVersion() {
        const row = this.db.prepare("PRAGMA user_version").get();
        return row.user_version;
    }
    async setVersion(version) {
        this.db.exec(`PRAGMA user_version = ${version}`);
    }
    async apply(migrations) {
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
export const initialMigration = {
    version: 1,
    description: "initial storage schema",
    async up(ctx) {
        const sql = await readFile(join(schemaDir, "001_initial.sql"), "utf8");
        await ctx.exec(sql);
    },
};
export const conversationAgentIdentityMigration = {
    version: 2,
    description: "include agent in conversation identity",
    async up(ctx) {
        const sql = await readFile(join(schemaDir, "002_conversation_agent_identity.sql"), "utf8");
        await ctx.exec(sql);
    },
};
export const allowlistMigration = {
    version: 3,
    description: "add allowlist_global and allowlist_per_bot tables",
    async up(ctx) {
        const sql = await readFile(join(schemaDir, "003_allowlist.sql"), "utf8");
        await ctx.exec(sql);
    },
};
export async function runStorageMigrations(db) {
    await new SqliteMigrationRunner(db).apply([
        initialMigration,
        conversationAgentIdentityMigration,
        allowlistMigration,
    ]);
}
//# sourceMappingURL=runner.js.map