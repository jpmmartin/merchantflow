import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { bigintTypes } from './bigint-types.js';
import type { Database, DatabaseSchema } from './schema.js';

/**
 * Pool settings used when the caller gives none.
 *
 * - `connectionTimeoutMillis` bounds both waiting for a free connection and
 *   opening a new one, so an unreachable server fails fast instead of hanging.
 * - `queryTimeoutMillis` is a client-side limit. It rejects the call but does
 *   not cancel the statement on the server, so a write that times out has an
 *   unknown outcome.
 * - `idleInTransactionSessionTimeoutMillis` makes PostgreSQL terminate a
 *   session that leaves a transaction open without running anything, which
 *   releases the locks that transaction holds.
 */
export const DEFAULT_DATABASE_SETTINGS = {
  applicationName: 'merchantflow',
  maxConnections: 10,
  connectionTimeoutMillis: 2_000,
  queryTimeoutMillis: 5_000,
  idleInTransactionSessionTimeoutMillis: 10_000,
} as const;

export interface DatabaseOptions {
  /** PostgreSQL connection URI, credentials included. This package never logs it. */
  readonly connectionString: string;
  /**
   * Called when a connection fails while no query is running on it: idle in
   * the pool, or checked out between two statements of a transaction. Typical
   * causes are a PostgreSQL restart (`57P01`) and the server ending a
   * transaction that stayed open and idle (`25P03`). The pool discards that
   * connection and opens a new one on demand. The error message can contain
   * the host and the port.
   */
  readonly onConnectionError: (error: Error) => void;
  readonly applicationName?: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMillis?: number;
  readonly queryTimeoutMillis?: number;
  readonly idleInTransactionSessionTimeoutMillis?: number;
}

/**
 * Creates the Kysely instance over a `pg` pool. Nothing connects until the
 * first query, so the process can start while PostgreSQL is down. Call
 * `destroy()` on the result to close the pool.
 */
export function createDatabase(options: DatabaseOptions): Database {
  const defaults = DEFAULT_DATABASE_SETTINGS;
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? defaults.applicationName,
    max: options.maxConnections ?? defaults.maxConnections,
    connectionTimeoutMillis:
      options.connectionTimeoutMillis ?? defaults.connectionTimeoutMillis,
    query_timeout: options.queryTimeoutMillis ?? defaults.queryTimeoutMillis,
    idle_in_transaction_session_timeout:
      options.idleInTransactionSessionTimeoutMillis ??
      defaults.idleInTransactionSessionTimeoutMillis,
    types: bigintTypes,
  });
  // `pg` emits 'error' on a client that fails while no query is running, and an
  // 'error' event without a listener takes the process down. The pool listens
  // only while a client is idle, so a client checked out inside a transaction
  // needs its own listener for its whole life. Verified: with the server ending
  // an idle transaction, the process died with an uncaught `25P03`.
  pool.on('connect', (client) => {
    // The server's error is followed by a second one when the socket closes
    // ("Connection terminated unexpectedly"). Both come from one failure, and
    // the listener must stay attached to absorb the second.
    let reported = false;
    client.on('error', (error) => {
      if (!reported) {
        reported = true;
        options.onConnectionError(error);
      }
    });
  });
  // The pool re-emits the error of an idle client after the client listener
  // above has reported it, and the pool itself must have a listener too.
  pool.on('error', () => undefined);
  return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
}
