import { startPostgres, startSilentServer } from '@merchantflow/test-support';
import { sql } from 'kysely';
import { Client } from 'pg';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  DEFAULT_DATABASE_SETTINGS,
  createDatabase,
  describeDatabaseFailure,
  pingDatabase,
  type Database,
  type DatabaseOptions,
} from '../src/index.js';

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_BIGINT = 9223372036854775807n;
const MIN_BIGINT = -9223372036854775808n;
const AMOUNTS = [
  0n,
  1n,
  -1n,
  MAX_SAFE,
  MAX_SAFE + 1n,
  MAX_SAFE + 2n,
  -(MAX_SAFE + 2n),
  MAX_BIGINT,
  MIN_BIGINT,
];

type Postgres = Awaited<ReturnType<typeof startPostgres>>;
type OpenOptions = Partial<DatabaseOptions>;

describe('database against PostgreSQL', () => {
  let postgres: Postgres;
  let admin: Client;
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

  // Opens a database whose connection errors are collected instead of logged.
  function open(overrides: OpenOptions = {}) {
    const errors: Error[] = [];
    const database = createDatabase({
      connectionString: postgres.getConnectionUri(),
      onConnectionError: (error) => void errors.push(error),
      ...overrides,
    });
    opened.push(database);
    return { database, errors };
  }

  async function connectionsOf(applicationName: string): Promise<number> {
    const result = await admin.query<{ total: string }>(
      'select count(*) as total from pg_stat_activity where application_name = $1',
      [applicationName],
    );
    return Number(result.rows[0]?.total);
  }

  describe('BIGINT', () => {
    beforeAll(async () => {
      await admin.query(
        'create table bigint_probe (id integer primary key, amount bigint not null)',
      );
    });

    it('returns values above Number.MAX_SAFE_INTEGER as exact bigint values', async () => {
      const { database } = open();
      for (const [id, amount] of AMOUNTS.entries()) {
        await sql`insert into bigint_probe (id, amount) values (${id}, ${amount})`.execute(
          database,
        );
      }

      const result = await sql<{
        amount: bigint;
      }>`select amount from bigint_probe order by id`.execute(database);

      expect(result.rows.map((row) => row.amount)).toEqual(AMOUNTS);
      for (const row of result.rows) {
        expect(typeof row.amount).toBe('bigint');
      }
    });

    it('accepts a bigint parameter and returns it unchanged, up to the maximum BIGINT', async () => {
      const { database } = open();

      for (const amount of AMOUNTS) {
        const result = await sql<{
          value: bigint;
        }>`select ${amount}::bigint as value`.execute(database);

        expect(result.rows[0]?.value).toBe(amount);
      }
    });

    it('is not converted through number anywhere on the way', async () => {
      const { database } = open();
      const unsafe = MAX_SAFE + 2n;

      const result = await sql<{
        value: bigint;
      }>`select ${unsafe}::bigint as value`.execute(database);

      expect(result.rows[0]?.value).toBe(9007199254740993n);
      expect(BigInt(Number(unsafe))).not.toBe(unsafe);
    });

    it('returns COUNT(*) as a bigint', async () => {
      const { database } = open();

      const result = await sql<{
        total: bigint;
      }>`select count(*) as total from bigint_probe`.execute(database);

      expect(result.rows[0]?.total).toBe(BigInt(AMOUNTS.length));
    });

    it('rejects a value outside the BIGINT range instead of truncating it', async () => {
      const { database } = open();

      await expect(
        sql`select (${MAX_BIGINT}::bigint + 1) as value`.execute(database),
      ).rejects.toMatchObject({ code: '22003' });
    });

    it('leaves BIGINT arrays as exact strings', async () => {
      const { database } = open();

      const result = await sql<{
        values: string[];
      }>`select array[${MAX_BIGINT}::bigint, 1::bigint] as values`.execute(
        database,
      );

      expect(result.rows[0]?.values).toEqual([MAX_BIGINT.toString(), '1']);
    });

    it('leaves numeric aggregates such as SUM as exact strings', async () => {
      const { database } = open();

      const result = await sql<{
        total: string;
      }>`select sum(amount) as total from bigint_probe`.execute(database);

      expect(result.rows[0]?.total).toBe(
        AMOUNTS.reduce((sum, amount) => sum + amount, 0n).toString(),
      );
    });
  });

  describe('session settings', () => {
    it('applies the default idle_in_transaction_session_timeout and application name', async () => {
      const { database } = open();

      const result = await sql<{ timeout: string; application: string }>`
        select current_setting('idle_in_transaction_session_timeout') as timeout,
               current_setting('application_name') as application`.execute(
        database,
      );

      expect(
        DEFAULT_DATABASE_SETTINGS.idleInTransactionSessionTimeoutMillis,
      ).toBe(10_000);
      expect(result.rows[0]).toEqual({
        timeout: '10s',
        application: DEFAULT_DATABASE_SETTINGS.applicationName,
      });
    });

    it('applies the values it is given', async () => {
      const { database } = open({
        idleInTransactionSessionTimeoutMillis: 3_000,
        applicationName: 'settings-probe',
      });

      const result = await sql<{ timeout: string; application: string }>`
        select current_setting('idle_in_transaction_session_timeout') as timeout,
               current_setting('application_name') as application`.execute(
        database,
      );

      expect(result.rows[0]).toEqual({
        timeout: '3s',
        application: 'settings-probe',
      });
    });

    it('ends a transaction left idle, rejects it, and keeps the process and the pool alive', async () => {
      const { database, errors } = open({
        idleInTransactionSessionTimeoutMillis: 200,
      });

      const forgotten = database.transaction().execute(async (transaction) => {
        await sql`select 1`.execute(transaction);
        await vi.waitFor(() => expect(errors).not.toHaveLength(0), {
          timeout: 5_000,
        });
        await sql`select 2`.execute(transaction);
      });

      await expect(forgotten).rejects.toThrow();
      expect(errors.map(describeDatabaseFailure)).toEqual(['25P03']);
      await expect(pingDatabase(database)).resolves.toBeUndefined();
    });
  });

  describe('failures', () => {
    it('reports an idle connection that PostgreSQL terminates, and recovers on the next query', async () => {
      const { database, errors } = open({
        applicationName: 'terminated-probe',
      });
      await pingDatabase(database);

      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1',
        ['terminated-probe'],
      );
      await vi.waitFor(() => expect(errors).toHaveLength(1), {
        timeout: 5_000,
      });

      expect(describeDatabaseFailure(errors[0])).toBe('57P01');
      await expect(pingDatabase(database)).resolves.toBeUndefined();
    });

    it('gives up opening a connection within connectionTimeoutMillis when the server never answers', async () => {
      const silent = await startSilentServer();
      try {
        const { database } = open({
          connectionString: `postgresql://nobody:placeholder@127.0.0.1:${silent.port}/placeholder`,
          connectionTimeoutMillis: 300,
        });
        const started = performance.now();

        const failure = await pingDatabase(database).catch(
          (error: unknown) => error,
        );

        expect(describeDatabaseFailure(failure)).toBe('TIMEOUT');
        expect(performance.now() - started).toBeLessThan(300 + 1_500);
      } finally {
        await silent.stop();
      }
    });

    it('stops waiting for a query after queryTimeoutMillis', async () => {
      const { database } = open({
        applicationName: 'query-timeout-probe',
        queryTimeoutMillis: 300,
      });
      const started = performance.now();

      const failure = await sql`select pg_sleep(30)`
        .execute(database)
        .catch((error: unknown) => error);

      expect(describeDatabaseFailure(failure)).toBe('TIMEOUT');
      expect(performance.now() - started).toBeLessThan(300 + 1_500);
      // The timeout is client-side: the statement keeps running on the server
      // until it is cancelled.
      await expect(connectionsOf('query-timeout-probe')).resolves.toBe(1);
      await admin.query(
        'select pg_cancel_backend(pid) from pg_stat_activity where application_name = $1',
        ['query-timeout-probe'],
      );
    });
  });

  describe('lifecycle', () => {
    it('answers a ping while PostgreSQL is up', async () => {
      const { database } = open();

      await expect(pingDatabase(database)).resolves.toBeUndefined();
    });

    it('closes every connection of the pool on destroy', async () => {
      const { database } = open({ applicationName: 'closing-probe' });
      await Promise.all([
        pingDatabase(database),
        pingDatabase(database),
        pingDatabase(database),
      ]);
      expect(await connectionsOf('closing-probe')).toBeGreaterThan(0);

      await database.destroy();

      await vi.waitFor(
        async () => expect(await connectionsOf('closing-probe')).toBe(0),
        { timeout: 5_000 },
      );
    });

    it('can be destroyed twice', async () => {
      const { database } = open();
      await pingDatabase(database);

      await database.destroy();

      await expect(database.destroy()).resolves.toBeUndefined();
    });
  });
});
