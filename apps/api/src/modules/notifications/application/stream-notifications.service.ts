import {
  describeDatabaseFailure,
  isDatabaseBusy,
  type Database,
} from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  catchError,
  concatMap,
  defer,
  from,
  interval,
  map,
  merge,
  mergeMap,
  of,
  takeUntil,
  takeWhile,
  timer,
  type Observable,
} from 'rxjs';
import { CheckSessionService } from '../../auth/application/check-session.service.js';
import type { Principal } from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import type { KeysetPosition } from '../../pagination/keyset-cursor.js';
import {
  NotificationHub,
  type NotificationSignal,
} from '../infrastructure/notification-hub.js';
import {
  findNewestNotificationPosition,
  findNotification,
  findNotificationPosition,
  listNotifications,
} from '../infrastructure/notification-queries.js';
import type { Notification } from './notification.js';

/**
 * How often an open stream checks its session and sends a keep-alive comment.
 * A revoked session or a disabled user stops receiving within this bound
 * (plus one session read), and the stream ends at the session's expiry.
 */
export const NOTIFICATION_STREAM_CHECK_INTERVAL_MILLIS = 15_000;

/** Rows read per query when a stream refills what it missed. */
const REFILL_PAGE_SIZE = 100;

/** How many sent IDs a stream remembers to skip a notification it already sent. */
const SENT_IDS_KEPT = 500;

/** What an open stream sends. */
export type NotificationStreamEvent =
  | { readonly kind: 'NOTIFICATION'; readonly notification: Notification }
  | { readonly kind: 'KEEP_ALIVE' }
  /** A read failed; the stream ends after this event, and the client reconnects. */
  | {
      readonly kind: 'FAILED';
      readonly code: 'SERVICE_BUSY' | 'INTERNAL_ERROR';
    };

export interface OpenNotificationStreamCommand {
  readonly principal: Principal;
  readonly correlationId: string;
  /** The ID of the last notification the client received, to resume after it. */
  readonly after?: string | undefined;
}

export type OpenNotificationStreamResult =
  | {
      readonly ok: true;
      readonly events: Observable<NotificationStreamEvent>;
    }
  | {
      readonly ok: false;
      readonly code:
        /** An API key: notifications and their read state are per user. */
        | 'SESSION_REQUIRED'
        /** A platform principal: only merchant users receive notifications. */
        | 'FORBIDDEN'
        /** The session stopped authenticating before the stream opened. */
        | 'UNAUTHENTICATED'
        /** `after` names no notification of the merchant. */
        | 'AFTER_UNKNOWN'
        /** The application is shutting down; the client retries later. */
        | 'SHUTTING_DOWN';
    };

function isAfter(left: KeysetPosition, right: KeysetPosition): boolean {
  const leftTime = left.createdAt.getTime();
  const rightTime = right.createdAt.getTime();
  return leftTime === rightTime ? left.id > right.id : leftTime > rightTime;
}

/**
 * Opens the notification stream of a signed-in merchant user. The merchant
 * comes only from the principal, and every read is filtered by it, so a
 * stream carries only its own merchant's notifications.
 *
 * The stream starts at `after` (resume) or at the merchant's newest
 * notification, and keeps a position: on every `RESYNC` of the hub (and once
 * at the start) it reads what the merchant has after that position, and on a
 * `NOTIFIED` signal it reads that notification within the merchant, so a
 * notification of another merchant reads nothing. Reads run one at a time,
 * and a notification already sent is not sent again.
 *
 * Every `NOTIFICATION_STREAM_CHECK_INTERVAL_MILLIS` the session is read again
 * and a keep-alive is sent; a revoked or expired session or a disabled user
 * ends the stream, and so does the session's expiry time. The application's
 * shutdown ends every stream.
 */
@Injectable()
export class StreamNotificationsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly hub: NotificationHub,
    private readonly checkSession: CheckSessionService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StreamNotificationsService.name);
  }

  async execute(
    command: OpenNotificationStreamCommand,
  ): Promise<OpenNotificationStreamResult> {
    const { principal } = command;
    if (this.hub.isShuttingDown()) return { ok: false, code: 'SHUTTING_DOWN' };
    if (principal.source !== 'USER') {
      return { ok: false, code: 'SESSION_REQUIRED' };
    }
    if (principal.kind !== 'MERCHANT') return { ok: false, code: 'FORBIDDEN' };
    const { merchantId } = principal;
    const credential = {
      sessionId: principal.sessionId,
      userId: principal.userId,
    };
    const session = await this.checkSession.execute(credential);
    if (!session.active) return { ok: false, code: 'UNAUTHENTICATED' };

    let position: KeysetPosition | undefined;
    if (command.after !== undefined) {
      position = await findNotificationPosition(this.database, {
        merchantId,
        id: command.after,
      });
      if (position === undefined) return { ok: false, code: 'AFTER_UNKNOWN' };
    } else {
      position = await findNewestNotificationPosition(
        this.database,
        merchantId,
      );
    }

    // The notification named by `after` is the one the client has already.
    const sent = new Set<string>(
      command.after === undefined ? [] : [command.after],
    );
    const remember = (notification: Notification): boolean => {
      if (sent.has(notification.id)) return false;
      sent.add(notification.id);
      if (sent.size > SENT_IDS_KEPT) {
        const oldest = sent.values().next();
        if (oldest.done !== true) sent.delete(oldest.value);
      }
      const reached = {
        createdAt: notification.createdAt,
        id: notification.id,
      };
      if (position === undefined || isAfter(reached, position)) {
        position = reached;
      }
      return true;
    };

    const refill = async (): Promise<Notification[]> => {
      const found: Notification[] = [];
      for (;;) {
        const page = await listNotifications(this.database, {
          merchantId,
          userId: principal.userId,
          limit: REFILL_PAGE_SIZE,
          after: position,
        });
        for (const view of page) {
          if (remember(view.notification)) found.push(view.notification);
        }
        if (page.length < REFILL_PAGE_SIZE) return found;
      }
    };

    const readOne = async (id: string): Promise<Notification[]> => {
      const notification = await findNotification(this.database, {
        merchantId,
        id,
      });
      return notification !== undefined && remember(notification)
        ? [notification]
        : [];
    };

    const triggers: Observable<NotificationSignal> = merge(
      of<NotificationSignal>({ kind: 'RESYNC' }),
      this.hub.subscribe(),
    );
    const notifications = triggers.pipe(
      concatMap((signal) =>
        defer(() =>
          signal.kind === 'NOTIFIED' ? readOne(signal.id) : refill(),
        ),
      ),
      mergeMap((found) => from(found)),
      map((notification): NotificationStreamEvent => ({
        kind: 'NOTIFICATION',
        notification,
      })),
    );
    const checks = interval(NOTIFICATION_STREAM_CHECK_INTERVAL_MILLIS).pipe(
      concatMap(() => defer(() => this.checkSession.execute(credential))),
      map((check): NotificationStreamEvent | 'SESSION_ENDED' =>
        check.active ? { kind: 'KEEP_ALIVE' } : 'SESSION_ENDED',
      ),
    );
    const untilExpiry = Math.max(
      0,
      session.expiresAt.getTime() - this.clock.now().getTime(),
    );

    // The first keep-alive tells the client at once that the stream is open.
    const events = merge(
      of<NotificationStreamEvent>({ kind: 'KEEP_ALIVE' }),
      notifications,
      checks,
    ).pipe(
      takeWhile(
        (event): event is NotificationStreamEvent => event !== 'SESSION_ENDED',
      ),
      takeUntil(timer(untilExpiry)),
      // The session checks would keep the stream open for good; shutdown
      // ends it, so the HTTP server can close.
      takeUntil(this.hub.shutdown()),
      catchError((error: unknown) => {
        // Only a database or connection failure ends the stream with an event;
        // anything else is a defect and goes to Nest, which logs it.
        const fromDatabase =
          isDatabaseBusy(error) ||
          (typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string');
        if (!fromDatabase) throw error;
        this.logger.warn(
          {
            reason: describeDatabaseFailure(error),
            correlationId: command.correlationId,
          },
          'notification stream read failed; the stream ends',
        );
        return of<NotificationStreamEvent>({
          kind: 'FAILED',
          code: isDatabaseBusy(error) ? 'SERVICE_BUSY' : 'INTERNAL_ERROR',
        });
      }),
    );
    return { ok: true, events };
  }
}
