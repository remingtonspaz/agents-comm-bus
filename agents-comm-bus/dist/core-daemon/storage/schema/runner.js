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
export const sessionOwnerProcessMigration = {
    version: 4,
    description: "track owning agent process for session leases",
    async up(ctx) {
        const sql = await readFile(join(schemaDir, "004_session_owner_process.sql"), "utf8");
        await ctx.exec(sql);
    },
};
export const conversationBotIdentityMigration = {
    version: 5,
    description: "store receiving bot identity on conversations",
    async up(ctx) {
        const sql = await readFile(join(schemaDir, "005_conversation_bot_identity.sql"), "utf8");
        await ctx.exec(sql);
    },
};
export const registrationIdentityMigration = {
    version: 6,
    description: "add immutable registration_id surrogate to registrations + conversations",
    async up(ctx) {
        const sql = await readFile(join(schemaDir, "006_registration_identity.sql"), "utf8");
        await ctx.exec(sql);
    },
};
export const registrationPkMigration = {
    version: 7,
    description: "make registration_id the canonical primary key of account_registrations",
    async up(ctx) {
        const sql = await readFile(join(schemaDir, "007_registration_pk.sql"), "utf8");
        await ctx.exec(sql);
    },
};
export const conversationRegistrationKeyMigration = {
    version: 8,
    description: "re-key conversations on (registration_id, chat, thread) + drop account_label",
    async up(ctx) {
        const sql = await readFile(join(schemaDir, "008_conversation_registration_key.sql"), "utf8");
        await ctx.exec(sql);
    },
};
export async function runStorageMigrations(db) {
    await new SqliteMigrationRunner(db).apply([
        initialMigration,
        conversationAgentIdentityMigration,
        allowlistMigration,
        sessionOwnerProcessMigration,
        conversationBotIdentityMigration,
        registrationIdentityMigration,
        registrationPkMigration,
        conversationRegistrationKeyMigration,
    ]);
}
//# sourceMappingURL=runner.js.map