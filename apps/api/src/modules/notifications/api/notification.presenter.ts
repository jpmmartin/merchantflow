import { toAmountMinorString } from '@merchantflow/domain';
import { encodeKeysetCursor } from '../../pagination/keyset-cursor.js';
import type { ListNotificationsResult } from '../application/list-notifications.service.js';
import type {
  Notification,
  NotificationView,
} from '../application/notification.js';
import type {
  NotificationListResponse,
  NotificationResponse,
} from './notifications.schemas.js';

export function toNotificationResponse(
  notification: Notification,
  readAt: Date | null,
): NotificationResponse {
  return {
    id: notification.id,
    merchant_id: notification.merchantId,
    type: notification.type,
    payment_intent_id: notification.paymentIntentId,
    refund_id: notification.refundId,
    amount_minor: toAmountMinorString(notification.amount),
    currency: notification.amount.currency,
    summary: notification.summary,
    created_at: notification.createdAt.toISOString(),
    read_at: readAt === null ? null : readAt.toISOString(),
  };
}

export function toNotificationListResponse(
  page: Extract<ListNotificationsResult, { ok: true }>,
): NotificationListResponse {
  return {
    data: page.views.map((view: NotificationView) =>
      toNotificationResponse(view.notification, view.readAt),
    ),
    next_cursor: page.next === undefined ? null : encodeKeysetCursor(page.next),
    unread_count: page.unreadCount,
  };
}
