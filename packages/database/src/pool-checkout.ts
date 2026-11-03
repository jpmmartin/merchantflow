import type { PostgresPool, PostgresPoolClient } from 'kysely';
import { Client, type Pool } from 'pg';

/** `code` of `DatabaseBusyError`, also its label in `describeDatabaseFailure`. */
export const DATABASE_BUSY_CODE = 'POOL_CHECKOUT_TIMEOUT';

/**
 * Raised when every pool connection stayed checked out for the whole checkout
 * timeout. It is raised before the caller received a connection, so nothing
 * of that call ran on the database and the same work can be repeated.
 */
export class DatabaseBusyError extends Error {
  readonly code = DATABASE_BUSY_CODE;

  constructor(timeoutMillis: number) {
    super(`No database connection became free within ${timeoutMillis} ms`);
    this.name = 'DatabaseBusyError';
  }
}

/** True for the error of a checkout that found no free connection in time. */
export function isDatabaseBusy(error: unknown): error is DatabaseBusyError {
  return error instanceof DatabaseBusyError;
}

interface Waiter {
  readonly admit: () => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * Wraps a `pg` pool for Kysely so that a checkout waits at most
 * `checkoutTimeoutMillis` for a free connection and then fails with the typed
 * `DatabaseBusyError`. The wrapper admits at most `maxConnections` checkouts
 * at a time in arrival order and counts a connection as free again on the
 * pool's `release` event, so the pool itself always has a client or room for a
 * new one and never queues. The pool keeps its own `connectionTimeoutMillis`,
 * which then bounds only the connection of a new client to the server.
 */
export function boundPoolCheckout(
  pool: Pool,
  limits: {
    readonly maxConnections: number;
    readonly checkoutTimeoutMillis: number;
  },
): PostgresPool {
  let checkedOut = 0;
  const waiters: Waiter[] = [];

  const admitNext = () => {
    while (checkedOut < limits.maxConnections) {
      const waiter = waiters.shift();
      if (waiter === undefined) return;
      clearTimeout(waiter.timer);
      checkedOut += 1;
      waiter.admit();
    }
  };

  const free = () => {
    checkedOut -= 1;
    admitNext();
  };

  // Emitted for every release, also when the client is discarded afterwards.
  pool.on('release', free);

  const admission = (): Promise<void> => {
    if (checkedOut < limits.maxConnections && waiters.length === 0) {
      checkedOut += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        admit: resolve,
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new DatabaseBusyError(limits.checkoutTimeoutMillis));
        }, limits.checkoutTimeoutMillis),
      };
      waiters.push(waiter);
    });
  };

  return {
    // The class the pool creates its clients from; Kysely opens a separate
    // client of it to cancel a running query.
    Client,
    options: pool.options,
    async connect(): Promise<PostgresPoolClient> {
      await admission();
      try {
        return await pool.connect();
      } catch (error) {
        // No client was handed out, so no release event will free the slot.
        free();
        throw error;
      }
    },
    async end(): Promise<void> {
      // Waiters proceed to the pool, which refuses them once it is ending.
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        checkedOut += 1;
        waiter.admit();
      }
      await pool.end();
    },
  };
}
