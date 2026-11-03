// SQLSTATE values (`57P01`) and Node.js system error codes (`ECONNREFUSED`).
const SAFE_CODE = /^[A-Za-z0-9_]{1,32}$/;

/**
 * Reduces a failed database call to a short label that is safe to log or to
 * return: the error code when it has the shape of a SQLSTATE or a system error
 * code, `TIMEOUT` for the timeouts that `pg` reports without a code, and
 * `UNKNOWN` otherwise.
 *
 * Error messages are deliberately left out. Those of `pg` and Node.js can carry
 * the host, the port, the user name, or the database name.
 */
export function describeDatabaseFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'UNKNOWN';
  }
  if ('code' in error && typeof error.code === 'string') {
    if (SAFE_CODE.test(error.code)) {
      return error.code;
    }
  }
  return /time(d)? ?out/i.test(error.message) ? 'TIMEOUT' : 'UNKNOWN';
}
