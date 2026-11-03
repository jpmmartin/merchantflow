import {
  createMigrationDatabase,
  runMigrations,
  type MigrationOptions,
} from './migrations/run-migrations.js';

/**
 * Applies the project's migrations (or those of `options.directory`) to a test
 * database and resolves with the names it applied, so a test can start from a
 * migrated schema. Rejects with the failed migration and its cause label when
 * the run fails. It is meant for Testcontainers databases:
 *
 *     const postgres = await startPostgres();
 *     await migrateTestDatabase(postgres.getConnectionUri());
 */
export async function migrateTestDatabase(
  connectionString: string,
  options: MigrationOptions = {},
): Promise<readonly string[]> {
  const database = createMigrationDatabase(connectionString, () => undefined);
  try {
    const result = await runMigrations(database, options);
    if (result.status === 'failed') {
      throw new Error(
        `Test database migration failed: ${result.failedMigration ?? '<no migration>'} (${result.cause})`,
      );
    }
    return result.applied;
  } finally {
    await database.destroy();
  }
}
