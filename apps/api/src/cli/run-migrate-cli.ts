import {
  createMigrationDatabase,
  describeDatabaseFailure,
  getMigrationStatus,
  runMigrations,
  type MigrationOptions,
  type MigrationRunResult,
  type MigrationStatus,
} from '@merchantflow/database';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { Env } from '../modules/config/env.schema.js';
import { InvalidConfigurationError } from '../modules/config/validate-env.js';

export interface MigrateCliOptions extends MigrationOptions {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

const SUCCESS = 0;
const FAILURE = 1;

/**
 * Reads `DATABASE_URL` through the same `AppConfigModule` the API uses, so the
 * CLI shares its environment reader, its `.env` lookup, and its validation.
 * The import is dynamic, and the caller handles the validation error, because
 * validation can run as soon as the module is loaded.
 */
async function readDatabaseUrl(): Promise<string> {
  const { AppConfigModule } =
    await import('../modules/config/config.module.js');
  const context = await NestFactory.createApplicationContext(AppConfigModule, {
    logger: false,
    // By default Nest aborts the process when initialization fails, which would
    // skip the handling of an invalid configuration below.
    abortOnError: false,
  });
  try {
    return context
      .get<ConfigService<Env, true>>(ConfigService)
      .get('DATABASE_URL', { infer: true });
  } finally {
    await context.close();
  }
}

function formatStatus(
  run: Extract<MigrationRunResult, { status: 'completed' }>,
  status: MigrationStatus,
): string {
  const lines = [
    run.applied.length === 0
      ? 'Applied in this run: none'
      : `Applied in this run: ${run.applied.join(', ')}`,
    'Migration status:',
    ...status.applied.map(
      (entry) => `  applied  ${entry.name}  ${entry.executedAt.toISOString()}`,
    ),
    ...status.pending.map((name) => `  pending  ${name}`),
    status.pending.length === 0
      ? 'Nothing is pending.'
      : `${status.pending.length} migration(s) pending.`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Applies the pending migrations and prints the resulting status. Resolves with
 * the process exit code: 0 on success, 1 on any failure. Output never contains
 * the connection URL, its parts, or the text of a database error; failures are
 * reported as the migration name and a cause label.
 */
export async function runMigrateCli(
  options: MigrateCliOptions,
): Promise<number> {
  let databaseUrl: string;
  try {
    databaseUrl = await readDatabaseUrl();
  } catch (error) {
    if (error instanceof InvalidConfigurationError) {
      options.stderr.write(`${error.message}\n`);
      return FAILURE;
    }
    throw error;
  }

  const database = createMigrationDatabase(databaseUrl, (error) =>
    options.stderr.write(
      `Database connection error (cause: ${describeDatabaseFailure(error)})\n`,
    ),
  );
  try {
    const run = await runMigrations(database, options);
    if (run.status === 'failed') {
      const detail =
        run.failedMigration === undefined
          ? `Migration run failed (cause: ${run.cause}).`
          : `Migration "${run.failedMigration}" failed (cause: ${run.cause}). The run is one transaction, so a failure rolls back every migration of the run.`;
      options.stderr.write(`${detail}\n`);
      return FAILURE;
    }
    options.stdout.write(
      formatStatus(run, await getMigrationStatus(database, options)),
    );
    return SUCCESS;
  } catch (error) {
    options.stderr.write(
      `Migration status could not be read (cause: ${describeDatabaseFailure(error)})\n`,
    );
    return FAILURE;
  } finally {
    await database.destroy();
  }
}
