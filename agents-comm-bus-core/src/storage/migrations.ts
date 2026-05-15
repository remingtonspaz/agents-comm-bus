// Schema versioning via `PRAGMA user_version` — v4 non-negotiable #7.
// Migrations apply forward-only, monotonically. The runner reads/writes the
// pragma; individual migrations only see a generic `exec(sql)` context so the
// migration body never needs to know which SQLite driver is in use.

export interface MigrationContext {
  exec(sql: string): Promise<void>;
}

export interface Migration {
  /** Monotonically increasing version number; matches `PRAGMA user_version`. */
  readonly version: number;
  readonly description: string;
  up(ctx: MigrationContext): Promise<void>;
}

export interface MigrationRunner {
  /** Reads `PRAGMA user_version`. */
  getCurrentVersion(): Promise<number>;
  /** Writes `PRAGMA user_version`. */
  setVersion(version: number): Promise<void>;
  /**
   * Applies any migrations with version > getCurrentVersion(), in order,
   * advancing user_version after each successful migration.
   */
  apply(migrations: Migration[]): Promise<void>;
}
