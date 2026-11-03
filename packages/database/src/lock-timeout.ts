import { sql } from 'kysely';
import type { DatabaseTransaction } from './schema.js';

/** SQLSTATE of PostgreSQL's `lock_not_available`, raised when `lock_timeout` expires. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Sets `lock_timeout` for the rest of the given transaction only (`SET LOCAL`),
 * so that any later statement of it that waits longer than `milliseconds` for
 * a lock (a row, an index entry inserted by another transaction, or a table)
 * fails with `lock_not_available` instead of waiting. The setting ends with the
 * transaction, whether it commits or rolls back, so a pooled connection never
 * keeps it.
 */
export async function setLocalLockTimeout(
  trx: DatabaseTransaction,
  milliseconds: number,
): Promise<void> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new RangeError('lock timeout must be a positive whole number');
  }
  // SET does not take bind parameters, so the checked integer is written into
  // the statement as a literal.
  await sql`set local lock_timeout = ${sql.lit(`${milliseconds}ms`)}`.execute(
    trx,
  );
}

/**
 * Tells whether an error is PostgreSQL's `lock_not_available`, which is what a
 * statement raises when `lock_timeout` expires (or a `NOWAIT` lock is taken).
 * Any other error is not matched, so the caller still sees it.
 */
export function isLockNotAvailable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === LOCK_NOT_AVAILABLE
  );
}
