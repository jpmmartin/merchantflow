import type {
  Database,
  DatabaseTransaction,
  NotificationRow,
} from '@merchantflow/database';
import { createMoney } from '@merchantflow/domain';
import type { KeysetPosition } from '../../pagination/keyset-cursor.js';
import {
  NOTIFICATION_TYPES,
  type Notification,
  type NotificationType,
  type NotificationView,
} from '../application/notification.js';

function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

function toNotification(row: NotificationRow): Notification {
  if (!isNotificationType(row.type)) {
    throw new Error(`notifications row ${row.id} has an unknown type`);
  }
  const amount = createMoney(row.amount_minor, row.currency);
  if (!amount.ok) {
    throw new Error(
      `notifications row ${row.id} has an amount that Money rejects: ${amount.code}`,
    );
  }
  return {
    id: row.id,
    merchantId: row.merchant_id,
    type: row.type,
    paymentIntentId: row.payment_intent_id,
    refundId: row.refund_id,
    amount: amount.money,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

/** Inserts a notification. Pass the transaction of the change it reports. */
export async function insertNotification(
  trx: DatabaseTransaction,
  notification: Notification,
): Promise<void> {
  await trx
    .insertInto('notifications')
    .values({
      id: notification.id,
      merchant_id: notification.merchantId,
      type: notification.type,
      payment_intent_id: notification.paymentIntentId,
      refund_id: notification.refundId,
      amount_minor: notification.amount.amountMinor,
      currency: notification.amount.currency,
      summary: notification.summary,
      created_at: notification.createdAt,
    })
    .execute();
}

/**
 * The position of a notification of the merchant in the `(created_at, id)`
 * order, or `undefined` when the merchant has no notification with that ID,
 * which includes another merchant's.
 */
export async function findNotificationPosition(
  db: Database,
  key: { readonly merchantId: string; readonly id: string },
): Promise<KeysetPosition | undefined> {
  const row = await db
    .selectFrom('notifications')
    .select(['created_at', 'id'])
    .where('merchant_id', '=', key.merchantId)
    .where('id', '=', key.id)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { createdAt: row.created_at, id: row.id };
}

/** The position of the merchant's newest notification, if it has any. */
export async function findNewestNotificationPosition(
  db: Database,
  merchantId: string,
): Promise<KeysetPosition | undefined> {
  const row = await db
    .selectFrom('notifications')
    .select(['created_at', 'id'])
    .where('merchant_id', '=', merchantId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { createdAt: row.created_at, id: row.id };
}

/**
 * Notifications of the merchant with the read time of one user, either a page
 * newest first that starts after `before` (the tray), or oldest first after
 * `after` (a refill of what a disconnected client missed). With neither, the
 * newest page.
 */
export async function listNotifications(
  db: Database,
  page: {
    readonly merchantId: string;
    readonly userId: string;
    readonly limit: number;
    readonly before?: KeysetPosition | undefined;
    readonly after?: KeysetPosition | undefined;
  },
): Promise<NotificationView[]> {
  let query = db
    .selectFrom('notifications')
    .leftJoin('notification_reads', (join) =>
      join
        .onRef('notification_reads.notification_id', '=', 'notifications.id')
        .onRef(
          'notification_reads.merchant_id',
          '=',
          'notifications.merchant_id',
        )
        .on('notification_reads.user_id', '=', page.userId),
    )
    .selectAll('notifications')
    .select('notification_reads.read_at')
    .where('notifications.merchant_id', '=', page.merchantId);
  if (page.after !== undefined) {
    const { createdAt, id } = page.after;
    query = query
      .where((eb) =>
        eb(
          eb.refTuple('notifications.created_at', 'notifications.id'),
          '>',
          eb.tuple(createdAt, id),
        ),
      )
      .orderBy('notifications.created_at', 'asc')
      .orderBy('notifications.id', 'asc');
  } else {
    if (page.before !== undefined) {
      const { createdAt, id } = page.before;
      query = query.where((eb) =>
        eb(
          eb.refTuple('notifications.created_at', 'notifications.id'),
          '<',
          eb.tuple(createdAt, id),
        ),
      );
    }
    query = query
      .orderBy('notifications.created_at', 'desc')
      .orderBy('notifications.id', 'desc');
  }
  const rows = await query.limit(page.limit).execute();
  return rows.map(({ read_at, ...row }) => ({
    notification: toNotification(row),
    readAt: read_at,
  }));
}

/** One notification of the merchant, or `undefined` for any other ID. */
export async function findNotification(
  db: Database,
  key: { readonly merchantId: string; readonly id: string },
): Promise<Notification | undefined> {
  const row = await db
    .selectFrom('notifications')
    .selectAll()
    .where('merchant_id', '=', key.merchantId)
    .where('id', '=', key.id)
    .executeTakeFirst();
  return row === undefined ? undefined : toNotification(row);
}

/** How many notifications of the merchant the user has not read. */
export async function countUnreadNotifications(
  db: Database,
  key: { readonly merchantId: string; readonly userId: string },
): Promise<number> {
  const row = await db
    .selectFrom('notifications')
    .select((eb) => eb.fn.countAll<string>().as('unread'))
    .where('notifications.merchant_id', '=', key.merchantId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('notification_reads')
            .select('notification_reads.notification_id')
            .whereRef(
              'notification_reads.notification_id',
              '=',
              'notifications.id',
            )
            .where('notification_reads.merchant_id', '=', key.merchantId)
            .where('notification_reads.user_id', '=', key.userId),
        ),
      ),
    )
    .executeTakeFirstOrThrow();
  return Number(row.unread);
}

/**
 * Records that the user read one notification of the merchant. Reading it
 * again keeps the first read time.
 */
export async function markNotificationRead(
  db: Database,
  read: {
    readonly merchantId: string;
    readonly userId: string;
    readonly notificationId: string;
    readonly readAt: Date;
  },
): Promise<'MARKED' | 'ALREADY_READ' | 'NOT_FOUND'> {
  const result = await db
    .insertInto('notification_reads')
    .columns(['merchant_id', 'notification_id', 'user_id', 'read_at'])
    .expression((eb) =>
      eb
        .selectFrom('notifications')
        .select([
          'notifications.merchant_id',
          'notifications.id',
          eb.val(read.userId).as('user_id'),
          eb.val(read.readAt).as('read_at'),
        ])
        .where('notifications.merchant_id', '=', read.merchantId)
        .where('notifications.id', '=', read.notificationId),
    )
    .onConflict((oc) => oc.columns(['notification_id', 'user_id']).doNothing())
    .executeTakeFirst();
  if (result.numInsertedOrUpdatedRows === 1n) return 'MARKED';
  const exists = await findNotificationPosition(db, {
    merchantId: read.merchantId,
    id: read.notificationId,
  });
  return exists === undefined ? 'NOT_FOUND' : 'ALREADY_READ';
}

/**
 * Records that the user read every notification of the merchant created at
 * or before `readAt`, and returns how many were unread.
 */
export async function markAllNotificationsRead(
  db: Database,
  read: {
    readonly merchantId: string;
    readonly userId: string;
    readonly readAt: Date;
  },
): Promise<number> {
  const result = await db
    .insertInto('notification_reads')
    .columns(['merchant_id', 'notification_id', 'user_id', 'read_at'])
    .expression((eb) =>
      eb
        .selectFrom('notifications')
        .select([
          'notifications.merchant_id',
          'notifications.id',
          eb.val(read.userId).as('user_id'),
          eb.val(read.readAt).as('read_at'),
        ])
        .where('notifications.merchant_id', '=', read.merchantId)
        .where('notifications.created_at', '<=', read.readAt),
    )
    .onConflict((oc) => oc.columns(['notification_id', 'user_id']).doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0n);
}
