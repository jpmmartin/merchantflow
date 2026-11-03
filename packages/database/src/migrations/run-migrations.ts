import { Migrator } from 'kysely/migration';
import { createDatabase } from '../create-database.js';
import { describeDatabaseFailure } from '../describe-failure.js';
import type { Database } from '../schema.js';
import {
  InvalidMigrationError,
  MIGRATIONS_DIRECTORY,
  SqlMigrationProvider,
} from './sql-migration-provider.js';

/**
 * Settings for the connection that applies migrations. The client-side query
 * timeout of the application pool (5 s) would abort a long migration, and a run
 * that waits for the migration lock behind another one, so it is raised. A
 * migration that hangs is still bounded.
 */
export const MIGRATION_DATABASE_SETTINGS = {
  applicationName: 'merchantflow-migrate',
  maxConnections: 2,
  queryTimeoutMillis: 600_000,
} as const;

/** Creates the Kysely instance used to run migrations. Call `destroy()` after. */
export function createMigrationDatabase(
  connectionString: string,
  onConnectionError: (error: Error) => void,
): Database {
  return createDatabase({
    connectionString,
    onConnectionError,
    ...MIGRATION_DATABASE_SETTINGS,
  });
}

/**
 * Outcome of a run. `applied` lists the migrations the run committed. A failed
 * run is rolled back as a whole (see `runMigrations`), so it reports no applied
 * migrations: the failure names the migration that raised the error, if any,
 * and a cause label that never carries connection details or data.
 */
export type MigrationRunResult =
  | { readonly status: 'completed'; readonly applied: readonly string[] }
  | {
      readonly status: 'failed';
      readonly failedMigration: string | undefined;
      readonly cause: string;
    };

export interface AppliedMigration {
  readonly name: string;
  readonly executedAt: Date;
}

export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly string[];
}

export interface MigrationOptions {
  /** Directory of `.sql` files. Defaults to the package's `migrations/`. */
  readonly directory?: string;
}

function createMigrator(database: Database, options: MigrationOptions) {
  return new Migrator({
    db: database,
    provider: new SqlMigrationProvider(
      options.directory ?? MIGRATIONS_DIRECTORY,
    ),
  });
}

// Messages of the migrator's own consistency errors start with this text
// (verified against Kysely 0.29.8, which is pinned exactly). The message names
// migrations only, but the label keeps the output uniform.
const CORRUPTED_MIGRATIONS = 'corrupted migrations:';

function describeMigrationFailure(error: unknown): string {
  if (error instanceof InvalidMigrationError) {
    return error.code;
  }
  if (
    error instanceof Error &&
    error.message.startsWith(CORRUPTED_MIGRATIONS)
  ) {
    return 'CORRUPTED_MIGRATIONS';
  }
  return describeDatabaseFailure(error);
}

/**
 * Applies every pending migration in alphabetical order.
 *
 * Kysely 0.29.8 on PostgreSQL pins one connection, takes a session-level
 * advisory lock on it, and runs ALL pending migrations, together with their
 * rows in `kysely_migration`, in ONE transaction. A failure therefore rolls
 * back every migration of the run, including those that ran before the failing
 * one; their individual results still read `Success` in the migrator's own
 * report, which is why this function does not forward them. Concurrent runs
 * queue on the lock, and the later ones find nothing pending.
 *
 * A migration cannot use statements that PostgreSQL refuses inside a
 * transaction, such as `CREATE INDEX CONCURRENTLY`, and it must not contain its
 * own `BEGIN` or `COMMIT`.
 */
export async function runMigrations(
  database: Database,
  options: MigrationOptions = {},
): Promise<MigrationRunResult> {
  const { error, results } = await createMigrator(
    database,
    options,
  ).migrateToLatest();
  if (error !== undefined) {
    return {
      status: 'failed',
      failedMigration: results?.find((result) => result.status === 'Error')
        ?.migrationName,
      cause: describeMigrationFailure(error),
    };
  }
  return {
    status: 'completed',
    applied: (results ?? [])
      .filter((result) => result.status === 'Success')
      .map((result) => result.migrationName),
  };
}

/**
 * Reads which migrations are applied and which are pending, without changing
 * anything. It rejects when PostgreSQL cannot answer or the directory cannot be
 * read; log `describeDatabaseFailure(error)`, never the message.
 */
export async function getMigrationStatus(
  database: Database,
  options: MigrationOptions = {},
): Promise<MigrationStatus> {
  const migrations = await createMigrator(database, options).getMigrations();
  const applied: AppliedMigration[] = [];
  const pending: string[] = [];
  for (const { name, executedAt } of migrations) {
    if (executedAt === undefined) {
      pending.push(name);
    } else {
      applied.push({ name, executedAt });
    }
  }
  return { applied, pending };
}
