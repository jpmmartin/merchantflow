import { z } from 'zod';
import {
  pageCursorQuerySchema,
  pageLimitQuerySchema,
} from '../../pagination/keyset-cursor.js';
import { NOTIFICATION_TYPES } from '../application/notification.js';

/** The ID of a notification the client received last; not sensitive. */
const afterQuerySchema = z
  .uuid()
  .optional()
  .describe(
    'The ID of the last notification the client received. The answer holds only notifications after it.',
  );

/**
 * The query of the notification list. Any other parameter, `merchant_id`
 * included, is refused: the merchant comes only from the principal.
 */
export const listNotificationsQuerySchema = z
  .strictObject({
    limit: pageLimitQuerySchema,
    cursor: pageCursorQuerySchema,
    after: afterQuerySchema,
  })
  .superRefine((query, context) => {
    if (query.cursor !== undefined && query.after !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['after'],
        input: query.after,
        message: 'after and cursor cannot be combined.',
      });
    }
  });

export type ListNotificationsQuery = z.infer<
  typeof listNotificationsQuerySchema
>;

/** The query of the notification stream. */
export const streamNotificationsQuerySchema = z.strictObject({
  after: afterQuerySchema,
});

export type StreamNotificationsQuery = z.infer<
  typeof streamNotificationsQuerySchema
>;

export const notificationIdParamSchema = z.uuid();

export const notificationResponseSchema = z.object({
  id: z.uuid(),
  merchant_id: z.uuid(),
  type: z.enum(NOTIFICATION_TYPES),
  payment_intent_id: z.uuid(),
  refund_id: z.uuid().nullable(),
  amount_minor: z
    .string()
    .describe(
      'The refund amount for a refund type, otherwise the payment amount, in minor units.',
    ),
  currency: z.string(),
  summary: z.string(),
  created_at: z.iso.datetime(),
  read_at: z.iso
    .datetime()
    .nullable()
    .describe('When the signed-in user read it, or null.'),
});

export type NotificationResponse = z.infer<typeof notificationResponseSchema>;

export const notificationListResponseSchema = z.object({
  data: z.array(notificationResponseSchema),
  next_cursor: z
    .string()
    .nullable()
    .describe(
      'Cursor of the next (older) page, or null. Always null with after.',
    ),
  unread_count: z
    .number()
    .int()
    .describe('Notifications of the merchant the signed-in user has not read.'),
});

export type NotificationListResponse = z.infer<
  typeof notificationListResponseSchema
>;

export const notificationsReadResponseSchema = z.object({
  marked: z.number().int().describe('Notifications this call marked as read.'),
  unread_count: z.number().int(),
});

export type NotificationsReadResponse = z.infer<
  typeof notificationsReadResponseSchema
>;
