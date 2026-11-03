import { startPostgres } from '@merchantflow/test-support';
import { sql } from 'kysely';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DATABASE_BUSY_CODE,
  DatabaseBusyError,
  createDatabase,
  describeDatabaseFailure,
  isDatabaseBusy,
  type Database,
  type DatabaseOptions,
} from '../src/index.js';

type Postgres = Awaited<ReturnType<typeof startPostgres>>;

const APPLICATION_NAME = 'pool-checkout-test';

/** A promise with its resolver, used to hold a transaction open. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Settles a promise into its value or its rejection reason. */
function settle<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    (value) => value,
    (reason: unknown) => reason,
  );
}

describe('bounded pool checkout against PostgreSQL', () => {
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

  function open(overrides: Partial<DatabaseOptions> = {}): Database {
    const database = createDatabase({
      connectionString: postgres.getConnectionUri(),
      applicationName: APPLICATION_NAME,
      onConnectionError: () => undefined,
      ...overrides,
    });
    opened.push(database);
    return database;
  }

  /** Checks out one connection and keeps it until `release` is called. */
  async function hold(database: Database) {
    const { opened: released, open: release } = gate();
    const { opened: started, open: start } = gate();
    const done = database.transaction().execute(async (trx) => {
      await sql`select 1`.execute(trx);
      start();
      await released;
    });
    await started;
    return { release, done };
  }

  async function sessions(): Promise<number> {
    const result = await admin.query<{ total: number }>(
      'select count(*)::int as total from pg_stat_activity where application_name = $1',
      [APPLICATION_NAME],
    );
    return result.rows[0]?.total ?? 0;
  }

  it('fails a checkout with DatabaseBusyError when every connection stays checked out', async () => {
    const database = open({ maxConnections: 2, connectionTimeoutMillis: 300 });
    const holders = [await hold(database), await hold(database)];

    const startedAt = performance.now();
    const error = await settle(sql`select 1`.execute(database));
    const elapsed = performance.now() - startedAt;

    expect(error).toBeInstanceOf(DatabaseBusyError);
    expect(isDatabaseBusy(error)).toBe(true);
    expect((error as DatabaseBusyError).code).toBe(DATABASE_BUSY_CODE);
    expect(describeDatabaseFailure(error)).toBe(DATABASE_BUSY_CODE);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    // The waiting checkout never reached the pool, which opened no third client.
    expect(await sessions()).toBe(2);

    for (const holder of holders) holder.release();
    await Promise.all(holders.map((holder) => holder.done));
    const result = await sql<{ one: number }>`select 1 as one`.execute(
      database,
    );
    expect(result.rows).toEqual([{ one: 1 }]);
  });

  it('admits a waiting checkout when a connection is released in time', async () => {
    const database = open({
      maxConnections: 1,
      connectionTimeoutMillis: 60_000,
    });
    const holder = await hold(database);

    const waiting = sql<{ one: number }>`select 1 as one`.execute(database);
    holder.release();
    await holder.done;

    expect((await waiting).rows).toEqual([{ one: 1 }]);
  });

  it('frees the slot of a checkout whose connection attempt failed', async () => {
    const database = open({
      connectionString: 'postgresql://nobody:placeholder@127.0.0.1:1/none',
      maxConnections: 1,
      connectionTimeoutMillis: 60_000,
    });

    // With the slot kept, the second call would wait for 60 s instead.
    for (const attempt of [1, 2]) {
      const error = await settle(sql`select 1`.execute(database));
      expect(isDatabaseBusy(error), `attempt ${attempt}`).toBe(false);
      expect(describeDatabaseFailure(error)).toBe('ECONNREFUSED');
    }
  });

  it('frees the slot of a connection that is discarded after its session ended', async () => {
    const database = open({
      maxConnections: 1,
      connectionTimeoutMillis: 60_000,
    });

    const failed = await settle(
      database.transaction().execute(async (trx) => {
        const { rows } = await sql<{
          pid: number;
        }>`select pg_backend_pid() as pid`.execute(trx);
        await admin.query('select pg_terminate_backend($1)', [rows[0]?.pid]);
        await sql`select 1`.execute(trx);
      }),
    );
    expect(failed).toBeInstanceOf(Error);
    expect(isDatabaseBusy(failed)).toBe(false);

    const result = await sql<{ one: number }>`select 1 as one`.execute(
      database,
    );
    expect(result.rows).toEqual([{ one: 1 }]);
  });

  it('refuses a waiting checkout when the database is destroyed', async () => {
    const database = createDatabase({
      connectionString: postgres.getConnectionUri(),
      applicationName: APPLICATION_NAME,
      onConnectionError: () => undefined,
      maxConnections: 1,
      connectionTimeoutMillis: 60_000,
    });
    const holder = await hold(database);

    const waiting = settle(sql`select 1`.execute(database));
    const destroyed = database.destroy();
    holder.release();
    await holder.done;
    await destroyed;

    const error = await waiting;
    expect(error).toBeInstanceOf(Error);
    expect(isDatabaseBusy(error)).toBe(false);
  });
});
