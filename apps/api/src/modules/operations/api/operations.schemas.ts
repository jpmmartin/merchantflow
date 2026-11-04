import { z } from 'zod';
import { AUDIT_ACTIONS } from '../../audit/application/audit-actions.js';
import {
  pageCursorQuerySchema,
  pageLimitQuerySchema,
} from '../../pagination/keyset-cursor.js';
import { TIMELINE_ITEM_KINDS } from '../application/get-payment-timeline.service.js';

/**
 * An ISO 8601 instant with `Z` or an explicit offset (`+02:00`), turned into a
 * `Date`. A text that matches the format but names no real instant (such as
 * 31 February) is refused, not repaired.
 */
const instantQuerySchema = z.iso
  .datetime({ offset: true })
  .transform((value, context) => {
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) {
      context.issues.push({
        code: 'custom',
        input: value,
        message: 'Invalid instant.',
      });
      return z.NEVER;
    }
    return instant;
  });

/**
 * The query of the audit list. Any other parameter, `merchant_id` included,
 * is refused: the merchant comes only from the principal.
 */
export const listAuditEventsQuerySchema = z
  .strictObject({
    limit: pageLimitQuerySchema,
    cursor: pageCursorQuerySchema,
    action: z
      .enum(AUDIT_ACTIONS)
      .optional()
      .describe('Only events with this action. Without it, every action.'),
    from: instantQuerySchema
      .optional()
      .describe(
        'Only events at or after this ISO 8601 instant, with Z or an offset (inclusive).',
      ),
    to: instantQuerySchema
      .optional()
      .describe(
        'Only events before this ISO 8601 instant, with Z or an offset (exclusive). It must be after from.',
      ),
  })
  .superRefine((query, context) => {
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      query.from.getTime() >= query.to.getTime()
    ) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        input: query.to,
        message: 'to must be after from.',
      });
    }
  });

export type ListAuditEventsQuery = z.infer<typeof listAuditEventsQuerySchema>;

export const actorResponseSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('USER'),
      label: z.string(),
      user_id: z.uuid(),
      display_name: z.string(),
      email: z.string(),
    }),
    z.object({
      type: z.literal('API_KEY'),
      label: z.string(),
      api_key_id: z.uuid(),
      role: z.enum(['PLATFORM_ADMIN', 'MERCHANT_ADMIN', 'MERCHANT_READ_ONLY']),
    }),
    z.object({
      type: z.literal('SYSTEM'),
      label: z.string(),
      component: z.string(),
    }),
    z.object({
      type: z.literal('PLATFORM_ADMINISTRATOR'),
      label: z.string(),
    }),
    z.object({
      type: z.literal('UNKNOWN'),
      label: z.string(),
      actor_type: z.enum(['API_KEY', 'SYSTEM', 'USER']),
      actor_id: z
        .string()
        .nullable()
        .describe('Shown to the platform administrator only.'),
    }),
  ])
  .describe(
    'Who acted. A user shows its display name and email, an API key its ID and role, SYSTEM its component. For a merchant user, an action of the platform shows as PLATFORM_ADMINISTRATOR with no email or ID. UNKNOWN is a user or key that no longer exists.',
  );

export type ActorResponse = z.infer<typeof actorResponseSchema>;

const metadataValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()).readonly(),
  z.record(z.string(), z.string()).readonly(),
]);

export const auditEventResponseSchema = z.object({
  id: z.uuid(),
  occurred_at: z.iso.datetime(),
  action: z.string(),
  target_type: z.string(),
  target_id: z.string(),
  merchant_id: z.uuid().nullable(),
  correlation_id: z.string(),
  actor: actorResponseSchema,
  summary: z.string().describe('A short sentence built from the safe fields.'),
  metadata: z
    .record(z.string(), metadataValueSchema)
    .describe(
      'Only reviewed fields: identifiers, statuses, codes, and amount_minor as an integer string with currency. Secrets, tokens, key lookup ids, and provider payloads are never stored or returned.',
    ),
});

export type AuditEventResponse = z.infer<typeof auditEventResponseSchema>;

export const auditEventListResponseSchema = z.object({
  data: z.array(auditEventResponseSchema),
  next_cursor: z
    .string()
    .nullable()
    .describe('Pass it as cursor for the next page; null on the last page.'),
});

export type AuditEventListResponse = z.infer<
  typeof auditEventListResponseSchema
>;

export const timelineItemResponseSchema = z.object({
  kind: z.enum(TIMELINE_ITEM_KINDS),
  source_id: z
    .uuid()
    .describe(
      'ID of the intent, attempt, capture or void, refund, journal entry, or audit event.',
    ),
  occurred_at: z.iso
    .datetime()
    .describe(
      'Stored time of the source row: creation, posting, or occurrence.',
    ),
  summary: z.string(),
  status: z.string().nullable(),
  amount_minor: z
    .string()
    .nullable()
    .describe('Amount in minor units as a base-10 integer string.'),
  currency: z.string().nullable(),
  actor: actorResponseSchema.nullable(),
  audit_action: z.string().nullable(),
});

export type TimelineItemResponse = z.infer<typeof timelineItemResponseSchema>;

export const paymentTimelineResponseSchema = z.object({
  payment_intent_id: z.uuid(),
  merchant_id: z.uuid(),
  data: z
    .array(timelineItemResponseSchema)
    .describe(
      'Oldest first by occurred_at; items of the same instant by kind in the order of the kind enum, then by source_id.',
    ),
});

export type PaymentTimelineResponse = z.infer<
  typeof paymentTimelineResponseSchema
>;
