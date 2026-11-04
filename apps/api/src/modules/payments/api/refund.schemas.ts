import { PROCESSOR_ERROR_CATEGORIES } from '@merchantflow/processor-contracts';
import { z } from 'zod';
import { REFUND_STATUSES } from '../application/refund.js';
import { paymentIntentResponseSchema } from './payment-intent.schemas.js';

/**
 * The body of a refund request. `amount_minor` is only typed here as a
 * string: its value is parsed by the domain's `parseAmountMinor`, so a JSON
 * number is refused as `invalid_type` and never converted. The currency is
 * the intent's.
 */
export const createRefundSchema = z.strictObject({
  amount_minor: z
    .string()
    .describe(
      'Amount to refund in minor units of the payment\'s currency, as a base-10 integer string greater than zero, for example "500" for 5.00 USD. No sign, decimal point, spaces, or leading zeros. At most the refundable amount.',
    ),
});

export type CreateRefundBody = z.infer<typeof createRefundSchema>;

const amountMinorSchema = z
  .string()
  .describe('Amount in minor units as a base-10 integer string.');

/** The refund amounts of one intent, all in its currency. */
const refundAmountsShape = {
  currency: z.string(),
  captured_amount_minor: amountMinorSchema.describe(
    'The captured amount; "0" for an intent that was not captured.',
  ),
  refunded_amount_minor: amountMinorSchema.describe(
    'The sum of the refunds that SUCCEEDED.',
  ),
  pending_amount_minor: amountMinorSchema.describe(
    'The sum of the refunds that are EXECUTING, PENDING, or UNKNOWN: they may still return money, so their amount cannot be refunded again.',
  ),
  refundable_amount_minor: amountMinorSchema.describe(
    'What can still be refunded: captured minus refunded minus pending.',
  ),
};

export const refundResponseSchema = z.object({
  id: z.uuid(),
  payment_intent_id: z.uuid(),
  merchant_id: z.uuid(),
  payment_attempt_id: z
    .uuid()
    .describe('The successful attempt whose capture is refunded.'),
  processor_account_id: z
    .uuid()
    .describe('The processor account the refund goes through.'),
  amount_minor: amountMinorSchema,
  currency: z.string(),
  status: z
    .enum(REFUND_STATUSES)
    .describe(
      'EXECUTING: sent to the provider. PENDING: accepted by the provider, not finished; its amount stays reserved. SUCCEEDED: refunded. FAILED: no money was returned. UNKNOWN: the outcome could not be established; its amount stays reserved and no new refund of the payment is accepted until it is resolved.',
    ),
  provider_refund_id: z
    .string()
    .nullable()
    .describe('The refund at the provider, for example a Stripe re_ ID.'),
  failure_code: z
    .string()
    .nullable()
    .describe("The provider's failure reason of a FAILED refund, if any."),
  error_category: z
    .enum(PROCESSOR_ERROR_CATEGORIES)
    .nullable()
    .describe('Why a FAILED or UNKNOWN refund did not succeed.'),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type RefundResponse = z.infer<typeof refundResponseSchema>;

/** An intent as a refund answer shows it: its body plus its refund amounts. */
export const refundedPaymentIntentResponseSchema =
  paymentIntentResponseSchema.extend({
    refunded_amount_minor: refundAmountsShape.refunded_amount_minor,
    refundable_amount_minor: refundAmountsShape.refundable_amount_minor,
  });

export const refundCreationResponseSchema = z.object({
  refund: refundResponseSchema,
  payment_intent: refundedPaymentIntentResponseSchema,
});

export type RefundCreationResponse = z.infer<
  typeof refundCreationResponseSchema
>;

export const refundListResponseSchema = z.object({
  payment_intent_id: z.uuid(),
  merchant_id: z.uuid(),
  ...refundAmountsShape,
  data: z.array(refundResponseSchema).describe('Oldest first.'),
});

export type RefundListResponse = z.infer<typeof refundListResponseSchema>;

export const refundIdParamSchema = z.uuid();

/** The answer of a refund check with the processor. */
export const refundRefreshResponseSchema = refundCreationResponseSchema.extend({
  change: z
    .enum([
      'REFUND_SUCCEEDED',
      'REFUND_FAILED',
      'REFUND_PENDING',
      'REFUND_REVERSED',
    ])
    .nullable()
    .describe(
      'What the check changed: a pending or unknown refund succeeded, failed, or turned out pending, or a succeeded refund failed afterwards and was reversed; null when the processor confirmed the status.',
    ),
});

export type RefundRefreshResponse = z.infer<typeof refundRefreshResponseSchema>;
