import { randomUUID } from 'node:crypto';
import {
  notifyInTransaction,
  type DatabaseTransaction,
} from '@merchantflow/database';
import type { Money } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { insertNotification } from '../infrastructure/notification-queries.js';
import {
  NOTIFICATION_CHANNEL,
  notificationSummaryOf,
  type Notification,
  type NotificationType,
  type RefundNotificationType,
} from './notification.js';

/** What changed, as the module that made the change describes it. */
export type RecordNotificationCommand = {
  readonly merchantId: string;
  readonly paymentIntentId: string;
  /** The merchant's own order reference, the only text the summary quotes. */
  readonly merchantReference: string;
  /** The refund's amount for a refund type, otherwise the payment's. */
  readonly amount: Money;
} & (
  | {
      readonly type: RefundNotificationType;
      readonly refundId: string;
    }
  | {
      readonly type: Exclude<NotificationType, RefundNotificationType>;
      readonly refundId?: never;
    }
);

/**
 * Records a notification for every user of a merchant, inside the caller's
 * transaction, which must be the transaction of the change it reports. It
 * inserts the row, with the creation time from the injected clock, and queues
 * a `NOTIFY` whose payload is the notification ID only. PostgreSQL delivers
 * the `NOTIFY` only when the transaction commits, so a change that rolls back
 * leaves neither a row nor a delivery. Nothing from the provider is stored.
 *
 * This is the only way other modules write a notification.
 */
@Injectable()
export class RecordNotificationService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async execute(
    trx: DatabaseTransaction,
    command: RecordNotificationCommand,
  ): Promise<Notification> {
    const notification: Notification = {
      id: randomUUID(),
      merchantId: command.merchantId,
      type: command.type,
      paymentIntentId: command.paymentIntentId,
      refundId: command.refundId ?? null,
      amount: command.amount,
      summary: notificationSummaryOf(command.type, command.merchantReference),
      createdAt: this.clock.now(),
    };
    await insertNotification(trx, notification);
    await notifyInTransaction(trx, NOTIFICATION_CHANNEL, notification.id);
    return notification;
  }
}
