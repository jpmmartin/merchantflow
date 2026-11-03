import { fileURLToPath } from 'node:url';
import { startPostgres } from '@merchantflow/test-support';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigrationDatabase,
  getMigrationStatus,
  runMigrations,
  type Database,
  type MigrationRunResult,
} from '../src/index.js';
import { migrateTestDatabase } from '../src/testing.js';

type Postgres = Awaited<ReturnType<typeof startPostgres>>;

function fixture(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url));
}

describe('SQL migrations against PostgreSQL', () => {
  let postgres: Postgres;
  let admin: Client;
  let databaseCount = 0;
  const opened: Database[] = [];

  beforeAll(async () => {
    postgres = await startPostgres();
    admin = new Client({ connectionString: postgres.getConnectionUri() });
    await admin.connect();
  });

  afterAll(async () => {
    await admin.end();
    await postgres.stop();
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((database) => database.destroy()));
  });

  // Each test gets an empty database of its own inside the shared container.
  async function createTestDatabase(): Promise<string> {
    databaseCount += 1;
    const name = `migrations_test_${databaseCount}`;
    await admin.query(`create database ${name}`);
    const url = new URL(postgres.getConnectionUri());
    url.pathname = `/${name}`;
    return url.toString();
  }

  function connect(connectionString: string): Database {
    const database = createMigrationDatabase(connectionString, () => undefined);
    opened.push(database);
    return database;
  }

  async function withClient<T>(
    connectionString: string,
    run: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.end();
    }
  }

  async function recordedMigrations(connectionString: string) {
    return withClient(connectionString, async (client) => {
      const result = await client.query<{ name: string }>(
        'select name from kysely_migration order by name',
      );
      return result.rows.map((row) => row.name);
    });
  }

  async function tablesOf(connectionString: string) {
    return withClient(connectionString, async (client) => {
      const result = await client.query<{ table_name: string }>(
        `select table_name from information_schema.tables
         where table_schema = 'public' order by table_name`,
      );
      return result.rows.map((row) => row.table_name);
    });
  }

  describe('a first run', () => {
    it('applies every migration in order and records each name', async () => {
      const url = await createTestDatabase();
      const database = connect(url);

      const result = await runMigrations(database, {
        directory: fixture('basic'),
      });

      expect(result).toEqual({
        status: 'completed',
        applied: ['20261101000000_create_alpha', '20261101000100_create_beta'],
      });
      expect(await recordedMigrations(url)).toEqual([
        '20261101000000_create_alpha',
        '20261101000100_create_beta',
      ]);
      expect(await tablesOf(url)).toEqual([
        'alpha',
        'beta',
        'kysely_migration',
        'kysely_migration_lock',
      ]);
    });

    it('creates only the two bookkeeping tables of the migrator when no migration exists', async () => {
      const url = await createTestDatabase();
      const database = connect(url);

      const result = await runMigrations(database, {
        directory: fixture('none'),
      });

      expect(result).toEqual({ status: 'completed', applied: [] });
      expect(await tablesOf(url)).toEqual([
        'kysely_migration',
        'kysely_migration_lock',
      ]);
    });
  });

  describe('a repeated run', () => {
    it('applies nothing the second time', async () => {
      const url = await createTestDatabase();
      const database = connect(url);
      const options = { directory: fixture('basic') };
      await runMigrations(database, options);

      const second = await runMigrations(database, options);

      expect(second).toEqual({ status: 'completed', applied: [] });
      expect(await recordedMigrations(url)).toHaveLength(2);
    });
  });

  describe('status', () => {
    it('lists every migration as pending before the first run and reads nothing it must create', async () => {
      const url = await createTestDatabase();
      const database = connect(url);

      const status = await getMigrationStatus(database, {
        directory: fixture('basic'),
      });

      expect(status.applied).toEqual([]);
      expect(status.pending).toEqual([
        '20261101000000_create_alpha',
        '20261101000100_create_beta',
      ]);
      expect(await tablesOf(url)).toEqual([]);
    });

    it('separates applied from pending migrations', async () => {
      const url = await createTestDatabase();
      const database = connect(url);
      await runMigrations(database, { directory: fixture('incremental/1') });

      const status = await getMigrationStatus(database, {
        directory: fixture('incremental/2'),
      });

      expect(status.applied.map((entry) => entry.name)).toEqual([
        '20261101000000_create_alpha',
      ]);
      expect(status.applied[0]?.executedAt).toBeInstanceOf(Date);
      expect(status.pending).toEqual([
        '20261101000100_create_beta',
        '20261101000200_create_gamma_then_fail',
      ]);
    });
  });

  describe('a file with several statements', () => {
    it('applies all of them, including a literal above Number.MAX_SAFE_INTEGER', async () => {
      const url = await createTestDatabase();
      const database = connect(url);

      const result = await runMigrations(database, {
        directory: fixture('multi-statement'),
      });

      expect(result.status).toBe('completed');
      await withClient(url, async (client) => {
        const rows = await client.query<{ id: number; amount: string }>(
          'select id, amount::text as amount from ledger_probe order by id',
        );
        expect(rows.rows).toEqual([
          { id: 1, amount: '100' },
          { id: 2, amount: '250' },
          { id: 3, amount: '9007199254740993' },
        ]);
        const index = await client.query(
          "select 1 from pg_indexes where indexname = 'ledger_probe_amount_idx'",
        );
        expect(index.rowCount).toBe(1);
        const comment = await client.query<{ comment: string }>(
          "select obj_description('ledger_probe'::regclass) as comment",
        );
        expect(comment.rows[0]?.comment).toBe(
          'semicolons; inside a string literal',
        );
      });
    });
  });

  describe('a failing migration', () => {
    it('reports the migration and the SQLSTATE, exits the run, and leaves nothing from the failed run behind', async () => {
      const url = await createTestDatabase();
      const database = connect(url);
      await runMigrations(database, { directory: fixture('incremental/1') });

      const result = await runMigrations(database, {
        directory: fixture('incremental/2'),
      });

      expect(result).toEqual({
        status: 'failed',
        failedMigration: '20261101000200_create_gamma_then_fail',
        cause: '42P01',
      });
      // The whole run is one transaction: the migration that preceded the
      // failing one (beta) is rolled back with it, and so is gamma's first
      // statement. Only the migration of the earlier, successful run remains.
      expect(await recordedMigrations(url)).toEqual([
        '20261101000000_create_alpha',
      ]);
      expect(await tablesOf(url)).toEqual([
        'alpha',
        'kysely_migration',
        'kysely_migration_lock',
      ]);
    });

    it('never puts the SQL error message in the result', async () => {
      const url = await createTestDatabase();
      const database = connect(url);

      const result = await runMigrations(database, {
        directory: fixture('incremental/2'),
      });

      expect(JSON.stringify(result)).not.toContain('table_that_does_not_exist');
    });

    it('fails again on the next run for the same reason, never skipping the migration', async () => {
      const url = await createTestDatabase();
      const database = connect(url);
      const options = { directory: fixture('incremental/2') };

      const first = await runMigrations(database, options);
      const second = await runMigrations(database, options);

      expect(second).toEqual(first);
      expect(await recordedMigrations(url)).toEqual([]);
    });

    it('releases the migration lock, so the next run does not wait', async () => {
      const url = await createTestDatabase();
      const database = connect(url);
      await runMigrations(database, { directory: fixture('incremental/2') });

      const next = await runMigrations(database, {
        directory: fixture('basic'),
      });

      expect(next.status).toBe('completed');
    });
  });

  describe('ordering', () => {
    it('refuses a new migration that sorts before one already applied', async () => {
      const url = await createTestDatabase();
      const database = connect(url);
      await runMigrations(database, { directory: fixture('ordering/applied') });

      const result = await runMigrations(database, {
        directory: fixture('ordering/inserted-before'),
      });

      expect(result).toEqual({
        status: 'failed',
        failedMigration: undefined,
        cause: 'CORRUPTED_MIGRATIONS',
      });
      expect(await recordedMigrations(url)).toEqual([
        '20261101000200_create_second',
      ]);
      expect(await tablesOf(url)).not.toContain('first');
    });

    it('refuses to run when an applied migration is no longer on disk', async () => {
      const url = await createTestDatabase();
      const database = connect(url);
      await runMigrations(database, { directory: fixture('ordering/applied') });

      const result = await runMigrations(database, {
        directory: fixture('ordering/missing'),
      });

      expect(result).toEqual({
        status: 'failed',
        failedMigration: undefined,
        cause: 'CORRUPTED_MIGRATIONS',
      });
      expect(await tablesOf(url)).not.toContain('third');
    });
  });

  describe('invalid migration files', () => {
    it('stops before running anything when a file is misnamed', async () => {
      const url = await createTestDatabase();
      const database = connect(url);

      const result = await runMigrations(database, {
        directory: fixture('invalid-name'),
      });

      expect(result).toEqual({
        status: 'failed',
        failedMigration: undefined,
        cause: 'INVALID_MIGRATION_FILE',
      });
      expect(await tablesOf(url)).not.toContain('ok');
    });

    it('fails with ENOENT for a directory that does not exist', async () => {
      const url = await createTestDatabase();
      const database = connect(url);

      const result = await runMigrations(database, {
        directory: fixture('does-not-exist'),
      });

      expect(result).toMatchObject({ status: 'failed', cause: 'ENOENT' });
    });
  });

  describe('concurrent runs', () => {
    it('applies each migration exactly once and lets every run complete', async () => {
      const url = await createTestDatabase();
      // The first migration sleeps for a second while it holds the lock, so
      // the other runs are certain to be waiting on it.
      const runs = Array.from({ length: 6 }, () => connect(url));

      const results = await Promise.all(
        runs.map((database) =>
          runMigrations(database, { directory: fixture('slow') }),
        ),
      );

      expect(results.every((result) => result.status === 'completed')).toBe(
        true,
      );
      const applied = results.flatMap((result) =>
        result.status === 'completed' ? result.applied : [],
      );
      expect(applied.toSorted()).toEqual([
        '20261101000000_create_slow',
        '20261101000100_create_after_slow',
      ]);
      expect(await recordedMigrations(url)).toEqual([
        '20261101000000_create_slow',
        '20261101000100_create_after_slow',
      ]);
    });

    it('keeps every concurrent run failing for the same migration when it is broken, and applies nothing', async () => {
      const url = await createTestDatabase();
      const runs = Array.from({ length: 4 }, () => connect(url));

      const results: MigrationRunResult[] = await Promise.all(
        runs.map((database) =>
          runMigrations(database, { directory: fixture('incremental/2') }),
        ),
      );

      for (const result of results) {
        expect(result).toEqual({
          status: 'failed',
          failedMigration: '20261101000200_create_gamma_then_fail',
          cause: '42P01',
        });
      }
      expect(await recordedMigrations(url)).toEqual([]);
    });
  });

  describe('migrateTestDatabase', () => {
    it('migrates a database from its connection string and reports what it applied', async () => {
      const url = await createTestDatabase();

      const applied = await migrateTestDatabase(url, {
        directory: fixture('basic'),
      });

      expect(applied).toHaveLength(2);
      expect(await tablesOf(url)).toContain('beta');
    });

    it('rejects with the failed migration and the cause label, without connection details', async () => {
      const url = await createTestDatabase();

      const failure = await migrateTestDatabase(url, {
        directory: fixture('incremental/2'),
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain('20261101000200_create_gamma_then_fail');
      expect(message).toContain('42P01');
      expect(message).not.toContain(new URL(url).host);
    });
  });
});
