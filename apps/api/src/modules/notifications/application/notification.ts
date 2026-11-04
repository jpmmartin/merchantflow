import type { Money } from '@merchantflow/domain';

/**
 * The changes a merchant's users are notified of. Each one happens without a
 * request of the user, or through a check with the provider ("Check with
 * Stripe"); a user's own payment, refund, capture, or void request does not
 * notify, because its answer already shows the outcome.
 *
 * - `REFUND_SUCCEEDED`, `REFUND_FAILED`: a pending or unknown refund finished;
 * - `REFUND_REVERSED`: a succeeded refund failed afterwards and was reversed;
 * - `REFUND_PENDING`: a refund whose outcome was unknown turned out pending;
 * - `PAYMENT_SUCCEEDED`, `PAYMENT_AUTHORIZED`, `PAYMENT_UNSUCCESSFUL`: an
 *   attempt that waited for 3D Secure or had an unknown outcome was resolved
 *   from a provider event;
 * - `CAPTURE_SUCCEEDED`, `CAPTURE_FAILED`, `VOID_SUCCEEDED`, `VOID_FAILED`: a
 *   capture or void whose outcome was unknown was resolved from a provider
 *   event or a check.
 */
export const NOTIFICATION_TYPES = [
  'REFUND_SUCCEEDED',
  'REFUND_FAILED',
  'REFUND_REVERSED',
  'REFUND_PENDING',
  'PAYMENT_SUCCEEDED',
  'PAYMENT_AUTHORIZED',
  'PAYMENT_UNSUCCESSFUL',
  'CAPTURE_SUCCEEDED',
  'CAPTURE_FAILED',
  'VOID_SUCCEEDED',
  'VOID_FAILED',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** The notification types that are about a refund. */
export type RefundNotificationType = Extract<
  NotificationType,
  `REFUND_${string}`
>;

/** A stored notification of one merchant. */
export interface Notification {
  readonly id: string;
  readonly merchantId: string;
  readonly type: NotificationType;
  readonly paymentIntentId: string;
  readonly refundId: string | null;
  /** The refund's amount for a refund type, otherwise the payment's. */
  readonly amount: Money;
  readonly summary: string;
  readonly createdAt: Date;
}

/** A notification together with whether the reading user has read it. */
export interface NotificationView {
  readonly notification: Notification;
  readonly readAt: Date | null;
}

/**
 * The short text of a notification, built only from its type and the
 * merchant's own order reference, so it carries nothing a provider returned.
 */
export function notificationSummaryOf(
  type: NotificationType,
  merchantReference: string,
): string {
  const order = `order ${merchantReference}`;
  switch (type) {
    case 'REFUND_SUCCEEDED':
      return `A refund of ${order} succeeded.`;
    case 'REFUND_FAILED':
      return `A refund of ${order} failed.`;
    case 'REFUND_REVERSED':
      return `A refund of ${order} failed after succeeding and was reversed.`;
    case 'REFUND_PENDING':
      return `A refund of ${order} is pending at the processor.`;
    case 'PAYMENT_SUCCEEDED':
      return `The payment of ${order} succeeded.`;
    case 'PAYMENT_AUTHORIZED':
      return `The payment of ${order} was authorized and awaits capture.`;
    case 'PAYMENT_UNSUCCESSFUL':
      return `The payment of ${order} was not successful.`;
    case 'CAPTURE_SUCCEEDED':
      return `The capture of ${order} succeeded.`;
    case 'CAPTURE_FAILED':
      return `The capture of ${order} did not take effect.`;
    case 'VOID_SUCCEEDED':
      return `The hold of ${order} was voided.`;
    case 'VOID_FAILED':
      return `The void of ${order} did not take effect.`;
  }
}

/** Name of the PostgreSQL channel whose payload is a notification ID. */
export const NOTIFICATION_CHANNEL = 'merchantflow_notifications';
