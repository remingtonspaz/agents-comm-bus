import type { Migration, MigrationRunner } from "agents-comm-bus-core";
export interface SqliteLike {
    exec(sql: string): void;
    prepare(sql: string): {
        all(...params: unknown[]): unknown[];
        get(...params: unknown[]): unknown;
        run(...params: unknown[]): unknown;
    };
}
export declare class SqliteMigrationRunner implements MigrationRunner {
    private readonly db;
    constructor(db: SqliteLike);
    getCurrentVersion(): Promise<number>;
    setVersion(version: number): Promise<void>;
    apply(migrations: Migration[]): Promise<void>;
}
export declare const initialMigration: Migration;
export declare const conversationAgentIdentityMigration: Migration;
export declare const allowlistMigration: Migration;
export declare const sessionOwnerProcessMigration: Migration;
export declare const conversationBotIdentityMigration: Migration;
export declare const registrationIdentityMigration: Migration;
export declare const registrationPkMigration: Migration;
export declare const conversationRegistrationKeyMigration: Migration;
export declare const multiOpenQueriesMigration: Migration;
export declare function runStorageMigrations(db: SqliteLike): Promise<void>;
//# sourceMappingURL=runner.d.ts.map