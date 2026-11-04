import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import type { KeysetPosition } from '../../pagination/keyset-cursor.js';
import {
  countUnreadNotifications,
  findNotificationPosition,
  listNotifications,
} from '../infrastructure/notification-queries.js';
import type { NotificationView } from './notification.js';

export interface ListNotificationsCommand {
  readonly principal: Principal;
  /** Page size. The caller validates the bounds. */
  readonly limit: number;
  /** Continues the tray, newest first, after this position. */
  readonly cursor?: KeysetPosition | undefined;
  /**
   * The ID of the last notification a client has: the answer is what came
   * after it, oldest first, to refill a gap.
   */
  readonly after?: string | undefined;
}

/** Why a notification request is refused before anything is read. */
export type NotificationAccessFailure =
  /** An API key: notifications and their read state are per user. */
  | 'SESSION_REQUIRED'
  /** A platform principal: only merchant users receive notifications. */
  | 'FORBIDDEN';

export type ListNotificationsResult =
  | {
      readonly ok: true;
      readonly views: readonly NotificationView[];
      /** Where the tray continues; never set for a refill. */
      readonly next: KeysetPosition | undefined;
      readonly unreadCount: number;
    }
  | {
      readonly ok: false;
      readonly code: NotificationAccessFailure | 'AFTER_UNKNOWN';
    };

/** The merchant and user a notification request acts for. */
export function notificationReaderOf(
  principal: Principal,
):
  | { readonly ok: true; readonly merchantId: string; readonly userId: string }
  | { readonly ok: false; readonly code: NotificationAccessFailure } {
  if (principal.source !== 'USER') {
    return { ok: false, code: 'SESSION_REQUIRED' };
  }
  if (principal.kind !== 'MERCHANT') return { ok: false, code: 'FORBIDDEN' };
  return {
    ok: true,
    merchantId: principal.merchantId,
    userId: principal.userId,
  };
}

/**
 * Lists the notifications of the signed-in user's merchant with that user's
 * read state and unread count. The merchant comes only from the principal.
 * Without `after`, a page newest first (the tray, AD-54 keyset pagination);
 * with `after`, up to `limit` notifications after that one, oldest first, and
 * the client asks again from the last one while a full page comes back.
 */
@Injectable()
export class ListNotificationsService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(
    command: ListNotificationsCommand,
  ): Promise<ListNotificationsResult> {
    const reader = notificationReaderOf(command.principal);
    if (!reader.ok) return reader;
    const { merchantId, userId } = reader;

    let after: KeysetPosition | undefined;
    if (command.after !== undefined) {
      after = await findNotificationPosition(this.database, {
        merchantId,
        id: command.after,
      });
      if (after === undefined) return { ok: false, code: 'AFTER_UNKNOWN' };
    }
    // One extra row tells whether the tray has another page.
    const rows = await listNotifications(this.database, {
      merchantId,
      userId,
      limit: after === undefined ? command.limit + 1 : command.limit,
      before: command.cursor,
      after,
    });
    const hasMore = after === undefined && rows.length > command.limit;
    const views = hasMore ? rows.slice(0, command.limit) : rows;
    const last = views.at(-1);
    const unreadCount = await countUnreadNotifications(this.database, {
      merchantId,
      userId,
    });
    return {
      ok: true,
      views,
      next:
        hasMore && last !== undefined
          ? {
              createdAt: last.notification.createdAt,
              id: last.notification.id,
            }
          : undefined,
      unreadCount,
    };
  }
}
