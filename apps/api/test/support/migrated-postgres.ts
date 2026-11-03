import { createDatabase, type Database } from '@merchantflow/database';
import { migrateTestDatabase } from '@merchantflow/database/testing';
import { startPostgres } from '@merchantflow/test-support';
import { Client, DatabaseError } from 'pg';
import { expect } from 'vitest';

type Postgres = Awaited<ReturnType<typeof startPostgres>>;

/**
 * A PostgreSQL container with the project's migrations applied, a raw `pg`
 * client that bypasses the application code, and a Kysely instance for the
 * query functions under test.
 */
export interface MigratedPostgres {
  readonly connectionString: string;
  readonly client: Client;
  readonly db: Database;
  stop(): Promise<void>;
}

export async function startMigratedPostgres(): Promise<MigratedPostgres> {
  const postgres: Postgres = await startPostgres();
  await migrateTestDatabase(postgres.getConnectionUri());
  const client = new Client({ connectionString: postgres.getConnectionUri() });
  await client.connect();
  const db = createDatabase({
    connectionString: postgres.getConnectionUri(),
    onConnectionError: () => undefined,
  });
  return {
    connectionString: postgres.getConnectionUri(),
    client,
    db,
    async stop() {
      await db.destroy();
      await client.end();
      await postgres.stop();
    },
  };
}

/**
 * Asserts that a statement fails with the given SQLSTATE and, when given, the
 * constraint that PostgreSQL names in the error.
 */
export async function expectDatabaseError(
  statement: Promise<unknown>,
  expected: { readonly code: string; readonly constraint?: string },
): Promise<DatabaseError> {
  const error: unknown = await statement.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof DatabaseError)) {
    throw new Error(
      `Expected a PostgreSQL error with code ${expected.code}, got ${String(error)}`,
    );
  }
  expect(error.code).toBe(expected.code);
  if (expected.constraint !== undefined) {
    expect(error.constraint).toBe(expected.constraint);
  }
  return error;
}
