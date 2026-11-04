import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import {
  countUnreadNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../infrastructure/notification-queries.js';
import {
  notificationReaderOf,
  type NotificationAccessFailure,
} from './list-notifications.service.js';

export type MarkNotificationsReadResult =
  | {
      readonly ok: true;
      /** How many notifications this call marked as read. */
      readonly marked: number;
      readonly unreadCount: number;
    }
  | {
      readonly ok: false;
      /** `NOT_FOUND`: no notification of the merchant has that ID. */
      readonly code: NotificationAccessFailure | 'NOT_FOUND';
    };

/**
 * Marks notifications as read for the signed-in user only: one notification
 * of the user's merchant, or every one created until now. Other users of the
 * merchant keep their own read state. Marking a read notification again
 * changes nothing and keeps its first read time. The read time comes from the
 * injected clock.
 */
@Injectable()
export class MarkNotificationsReadService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async markOne(command: {
    readonly principal: Principal;
    readonly notificationId: string;
  }): Promise<MarkNotificationsReadResult> {
    const reader = notificationReaderOf(command.principal);
    if (!reader.ok) return reader;
    const outcome = await markNotificationRead(this.database, {
      merchantId: reader.merchantId,
      userId: reader.userId,
      notificationId: command.notificationId,
      readAt: this.clock.now(),
    });
    if (outcome === 'NOT_FOUND') return { ok: false, code: 'NOT_FOUND' };
    const unreadCount = await countUnreadNotifications(this.database, reader);
    return { ok: true, marked: outcome === 'MARKED' ? 1 : 0, unreadCount };
  }

  async markAll(command: {
    readonly principal: Principal;
  }): Promise<MarkNotificationsReadResult> {
    const reader = notificationReaderOf(command.principal);
    if (!reader.ok) return reader;
    const marked = await markAllNotificationsRead(this.database, {
      merchantId: reader.merchantId,
      userId: reader.userId,
      readAt: this.clock.now(),
    });
    const unreadCount = await countUnreadNotifications(this.database, reader);
    return { ok: true, marked, unreadCount };
  }
}
