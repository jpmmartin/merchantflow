import type { AppNotification, NotificationType } from '../api/notifications';
import { formatAmountMinor } from '../money/amount';

const TITLES: Record<NotificationType, string> = {
  REFUND_SUCCEEDED: 'Refund succeeded',
  REFUND_FAILED: 'Refund failed',
  REFUND_REVERSED: 'Refund reversed',
  REFUND_PENDING: 'Refund pending',
  PAYMENT_SUCCEEDED: 'Payment succeeded',
  PAYMENT_AUTHORIZED: 'Payment authorized',
  PAYMENT_UNSUCCESSFUL: 'Payment not successful',
  CAPTURE_SUCCEEDED: 'Capture succeeded',
  CAPTURE_FAILED: 'Capture did not take effect',
  VOID_SUCCEEDED: 'Hold voided',
  VOID_FAILED: 'Void did not take effect',
};

/** A short title for a notification type. */
export function notificationTitle(notification: AppNotification): string {
  return TITLES[notification.type];
}

/** The notification's amount in major units with its currency. */
export function notificationAmount(notification: AppNotification): string {
  return `${formatAmountMinor(notification.amount_minor, notification.currency)} ${notification.currency}`;
}

/** The page of the payment a notification is about. */
export function notificationPath(notification: AppNotification): string {
  return `/payments/${notification.payment_intent_id}`;
}
