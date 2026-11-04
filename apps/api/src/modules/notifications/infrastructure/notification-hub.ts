import { AsyncResource } from 'node:async_hooks';
import {
  createNotificationListener,
  describeDatabaseFailure,
  type NotificationListener,
} from '@merchantflow/database';
import {
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { Observable, Subject } from 'rxjs';
import type { Env } from '../../config/env.schema.js';
import { NOTIFICATION_CHANNEL } from '../application/notification.js';

/**
 * What the hub tells each open stream:
 *
 * - `NOTIFIED`: a notification with this ID committed; it may belong to any
 *   merchant, so a stream reads it within its own merchant;
 * - `RESYNC`: the listener has just started listening, the first time or
 *   after a lost connection, so notifications may have committed while it was
 *   not; a stream reads what its merchant has after the last one it sent.
 */
export type NotificationSignal =
  | { readonly kind: 'NOTIFIED'; readonly id: string }
  | { readonly kind: 'RESYNC' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Owns the one dedicated `LISTEN` connection of the process, outside the
 * query pool, and fans its notifications out to the open streams. The
 * connection is opened when the first stream subscribes and closed when the
 * last one ends, so a process with no open stream holds no extra session.
 * A lost connection is opened again with a bounded delay
 * (`createNotificationListener`); its failures are logged as a short code,
 * never with the message, which can carry the host and the port.
 *
 * On shutdown, `beforeApplicationShutdown` ends every open stream before the
 * HTTP server stops accepting connections, so a long-lived response never
 * holds the shutdown back, and `onApplicationShutdown` waits for the
 * connection to close.
 */
@Injectable()
export class NotificationHub
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  private readonly signals = new Subject<NotificationSignal>();
  private readonly stopping = new Subject<void>();
  private listener: NotificationListener | undefined;
  private closing: Promise<void> = Promise.resolve();
  private subscribers = 0;
  private shuttingDown = false;
  /**
   * The async context of the application's start, outside any request. The
   * listener is created in it, so its log lines carry no request's context
   * (the first stream's user, for example), which the request logger would
   * otherwise attach to everything started during that request.
   */
  private readonly outsideRequests = new AsyncResource('NotificationHub');

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationHub.name);
  }

  /**
   * The signals for one stream. Subscribing keeps the listener open; the
   * observable completes when the application shuts down.
   */
  subscribe(): Observable<NotificationSignal> {
    return new Observable<NotificationSignal>((subscriber) => {
      if (this.shuttingDown) {
        subscriber.complete();
        return undefined;
      }
      const signals = this.signals.subscribe(subscriber);
      const stopping = this.stopping.subscribe(() => subscriber.complete());
      this.acquire();
      return () => {
        signals.unsubscribe();
        stopping.unsubscribe();
        this.release();
      };
    });
  }

  /** True once the application has started shutting down. */
  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Emits once when the application starts shutting down, and at once for a
   * subscriber that comes later, so a whole stream, timers included, can end
   * with it.
   */
  shutdown(): Observable<void> {
    return new Observable<void>((subscriber) => {
      if (this.shuttingDown) {
        subscriber.next();
        subscriber.complete();
        return undefined;
      }
      const stopping = this.stopping.subscribe(() => {
        subscriber.next();
        subscriber.complete();
      });
      return () => stopping.unsubscribe();
    });
  }

  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
    this.stopping.next();
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.closeListener();
    await this.closing;
  }

  private acquire(): void {
    this.subscribers += 1;
    if (this.listener !== undefined) return;
    this.listener = this.outsideRequests.runInAsyncScope(() =>
      this.openListener(),
    );
  }

  private openListener(): NotificationListener {
    return createNotificationListener({
      connectionString: this.config.get('DATABASE_URL', { infer: true }),
      applicationName: 'merchantflow-api-notifications',
      channel: NOTIFICATION_CHANNEL,
      onNotification: (payload) => {
        if (UUID.test(payload)) {
          this.signals.next({ kind: 'NOTIFIED', id: payload });
        } else {
          this.logger.warn('notification payload is not an ID; ignored');
        }
      },
      onListening: () => {
        this.logger.info('notification listener listening');
        this.signals.next({ kind: 'RESYNC' });
      },
      onConnectionLost: (error, retryInMillis) => {
        this.logger.warn(
          { reason: describeDatabaseFailure(error), retryInMillis },
          'notification listener connection lost; reconnecting',
        );
      },
    });
  }

  private release(): void {
    this.subscribers -= 1;
    if (this.subscribers === 0) this.closeListener();
  }

  private closeListener(): void {
    const listener = this.listener;
    if (listener === undefined) return;
    this.listener = undefined;
    const previous = this.closing;
    this.closing = previous.then(async () => {
      await listener.close();
      this.logger.info('notification listener closed');
    });
  }
}
