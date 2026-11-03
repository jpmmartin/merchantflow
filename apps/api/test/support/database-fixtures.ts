import type { startPostgres } from '@merchantflow/test-support';
import { Client } from 'pg';

export type Postgres = Awaited<ReturnType<typeof startPostgres>>;

// Distinct values, so that a leak of any of them into a response or a log line
// cannot be mistaken for an unrelated occurrence of a common word.
export const CREDENTIALS = {
  database: 'readiness_db_7c1d',
  username: 'readiness_user_7c1d',
  password: 'readiness-pass-7c1d',
};

/**
 * Counts the sessions that have a given application name, through a
 * connection of its own that is closed again before the caller continues.
 */
export async function sessionsOf(
  postgres: Postgres,
  applicationName: string,
): Promise<number> {
  const client = new Client({ connectionString: postgres.getConnectionUri() });
  await client.connect();
  try {
    const result = await client.query<{ total: string }>(
      'select count(*) as total from pg_stat_activity where application_name = $1',
      [applicationName],
    );
    return Number(result.rows[0]?.total);
  } finally {
    await client.end();
  }
}
