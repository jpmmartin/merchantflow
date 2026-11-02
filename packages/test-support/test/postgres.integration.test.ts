import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres } from '../src/index.js';

describe('startPostgres', () => {
  let postgres: StartedPostgreSqlContainer | undefined;
  let client: Client | undefined;

  beforeAll(async () => {
    postgres = await startPostgres();
    client = new Client({ connectionString: postgres.getConnectionUri() });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await postgres?.stop();
  });

  function connected(): Client {
    if (client === undefined) {
      throw new Error('The PostgreSQL client was not connected in beforeAll.');
    }
    return client;
  }

  it('starts PostgreSQL 17', async () => {
    const result = await connected().query<{ version: number }>(
      `SELECT current_setting('server_version_num')::int AS version`,
    );

    const version = result.rows[0]?.version ?? 0;
    expect(version).toBeGreaterThanOrEqual(170000);
    expect(version).toBeLessThan(180000);
  });

  it('leaves no trace of a write that is rolled back', async () => {
    const db = connected();
    await db.query('CREATE TABLE rollback_probe (id integer PRIMARY KEY)');

    await db.query('BEGIN');
    await db.query('INSERT INTO rollback_probe (id) VALUES (1)');
    const inside = await db.query('SELECT id FROM rollback_probe');
    await db.query('ROLLBACK');
    const after = await db.query('SELECT id FROM rollback_probe');

    expect(inside.rows).toEqual([{ id: 1 }]);
    expect(after.rows).toEqual([]);
  });
});
