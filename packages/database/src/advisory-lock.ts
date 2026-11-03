import { sql } from 'kysely';
import type { Database } from './schema.js';

/**
 * Outcome of `withTryAdvisoryLock`. `acquired: false` means another session
 * holds the lock and the action did not run.
 */
export type AdvisoryLockResult<T> =
  { readonly acquired: true; readonly value: T } | { readonly acquired: false };

/**
 * Runs `action` while holding a session-level PostgreSQL advisory lock, or
 * reports that the lock is taken without waiting for it. The lock is held on
 * one dedicated connection for the whole action, so the action itself uses the
 * pool as usual (its own transactions run on other connections). PostgreSQL
 * releases the lock when that connection ends, so a crash cannot leave it held.
 * Use a distinct `key` for each purpose.
 */
export async function withTryAdvisoryLock<T>(
  database: Database,
  key: number,
  action: () => Promise<T>,
): Promise<AdvisoryLockResult<T>> {
  return database.connection().execute(async (connection) => {
    const { rows } = await sql<{
      locked: boolean;
    }>`select pg_try_advisory_lock(${key}::bigint) as locked`.execute(
      connection,
    );
    if (rows[0]?.locked !== true) {
      return { acquired: false } as const;
    }
    try {
      return { acquired: true, value: await action() } as const;
    } finally {
      await sql`select pg_advisory_unlock(${key}::bigint)`.execute(connection);
    }
  });
}
