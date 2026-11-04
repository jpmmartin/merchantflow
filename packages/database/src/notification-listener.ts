import { sql } from 'kysely';
import { Client } from 'pg';
import type { DatabaseTransaction } from './schema.js';

/**
 * Settings of the listening connection when the caller gives none.
 *
 * - `connectionTimeoutMillis` bounds opening the connection, as for the pool.
 * - A lost or refused connection is opened again after `firstRetryDelayMillis`,
 *   doubled after every failure in a row up to `maxRetryDelayMillis`, until the
 *   listener is closed. The delay is bounded, so the listener recovers within
 *   that bound once PostgreSQL is back.
 */
export const NOTIFICATION_LISTENER_SETTINGS = {
  connectionTimeoutMillis: 2_000,
  firstRetryDelayMillis: 1_000,
  maxRetryDelayMillis: 30_000,
} as const;

/** A channel name that is safe to write into `LISTEN` as an identifier. */
const CHANNEL_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface NotificationListenerOptions {
  /** PostgreSQL connection URI, credentials included. This package never logs it. */
  readonly connectionString: string;
  readonly applicationName: string;
  /** The channel to listen on: lower-case letters, digits, and underscores. */
  readonly channel: string;
  /** Called with the payload of every notification on the channel. */
  readonly onNotification: (payload: string) => void;
  /**
   * Called every time the listener starts listening: the first time and
   * after every reconnection. Notifications sent while it was not listening
   * are not delivered to it, so the caller refills them from its own data.
   */
  readonly onListening: () => void;
  /**
   * Called when the connection fails or is lost, with the error and the delay
   * before the next attempt. The error message can contain the host and the
   * port.
   */
  readonly onConnectionLost: (error: unknown, retryInMillis: number) => void;
  readonly connectionTimeoutMillis?: number;
  readonly firstRetryDelayMillis?: number;
  readonly maxRetryDelayMillis?: number;
}

export interface NotificationListener {
  /** Stops listening and closes the connection; no reconnection follows. */
  close(): Promise<void>;
}

/**
 * Opens one dedicated connection, outside any pool, that runs `LISTEN` on a
 * channel and reports its notifications. The connection is opened at once,
 * and opened again after a failure with a bounded delay. The retry timer does
 * not keep the process alive.
 */
export function createNotificationListener(
  options: NotificationListenerOptions,
): NotificationListener {
  if (!CHANNEL_NAME.test(options.channel)) {
    throw new Error('the notification channel is not a plain identifier');
  }
  const settings = NOTIFICATION_LISTENER_SETTINGS;
  const firstDelay =
    options.firstRetryDelayMillis ?? settings.firstRetryDelayMillis;
  const maxDelay = options.maxRetryDelayMillis ?? settings.maxRetryDelayMillis;
  let closed = false;
  let failuresInARow = 0;
  let current: Client | undefined;
  let retryTimer: NodeJS.Timeout | undefined;

  const connect = async (): Promise<void> => {
    if (closed) return;
    const client = new Client({
      connectionString: options.connectionString,
      application_name: options.applicationName,
      connectionTimeoutMillis:
        options.connectionTimeoutMillis ?? settings.connectionTimeoutMillis,
      // An idle listening connection is otherwise never probed, so a peer that
      // vanished would go unnoticed.
      keepAlive: true,
    });
    current = client;
    let failed = false;
    // `pg` reports one failure as an `error` event, an `end` event, or a
    // rejected call, often more than one of them; the first one counts.
    const fail = (error: unknown): void => {
      if (failed) return;
      failed = true;
      if (current === client) current = undefined;
      client.removeAllListeners('notification');
      void client.end().catch(() => undefined);
      if (closed) return;
      const delay = Math.min(maxDelay, firstDelay * 2 ** failuresInARow);
      failuresInARow += 1;
      options.onConnectionLost(error, delay);
      retryTimer = setTimeout(() => void connect(), delay);
      retryTimer.unref();
    };
    client.on('error', fail);
    client.on('end', () => fail(new Error('the listening connection ended')));
    client.on('notification', (message) => {
      if (message.channel === options.channel) {
        options.onNotification(message.payload ?? '');
      }
    });
    try {
      await client.connect();
      // The channel was checked against a plain identifier pattern above.
      await client.query(`LISTEN ${options.channel}`);
    } catch (error) {
      fail(error);
      return;
    }
    if (closed || failed) return;
    failuresInARow = 0;
    options.onListening();
  };

  void connect();

  return {
    async close(): Promise<void> {
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      const client = current;
      current = undefined;
      if (client === undefined) return;
      client.removeAllListeners('notification');
      await client.end().catch(() => undefined);
    },
  };
}

/**
 * Queues a notification on a channel inside the given transaction, through
 * `pg_notify`. PostgreSQL delivers it to listeners only if and when the
 * transaction commits, and drops it if the transaction rolls back. The payload
 * must be shorter than 8000 bytes; callers send an identifier only.
 */
export async function notifyInTransaction(
  trx: DatabaseTransaction,
  channel: string,
  payload: string,
): Promise<void> {
  if (!CHANNEL_NAME.test(channel)) {
    throw new Error('the notification channel is not a plain identifier');
  }
  if (Buffer.byteLength(payload, 'utf8') >= 8_000) {
    throw new RangeError('a notification payload must be under 8000 bytes');
  }
  await sql`select pg_notify(${channel}, ${payload})`.execute(trx);
}
