import { PROCESSOR_ERROR_CATEGORIES } from '@merchantflow/processor-contracts';
import { z } from 'zod';
import { PAYMENT_ATTEMPT_STATUSES } from '../application/payment-attempt.js';
import { paymentIntentResponseSchema } from './payment-intent.schemas.js';

/**
 * A payment method token created in the browser by the provider's library: a
 * lower-case prefix, an underscore, and letters, digits, or underscores, such
 * as Stripe's `pm_...`. A card number cannot have this form, so card data sent
 * here by mistake is refused before anything uses it.
 */
const PAYMENT_METHOD_TOKEN_FORMAT = /^[a-z]{1,16}_[A-Za-z0-9_]{1,200}$/;

/** The body of a confirmation. */
export const confirmPaymentIntentSchema = z.strictObject({
  payment_method: z
    .string()
    .regex(PAYMENT_METHOD_TOKEN_FORMAT)
    .describe(
      "Payment method token created in the browser by the provider's library with the account's publishable key, for example a Stripe pm_ ID. Never card data.",
    ),
  processor_account_id: z
    .uuid()
    .describe(
      "The processor account whose publishable key created the payment method. It must be the merchant's enabled default account.",
    ),
});

export type ConfirmPaymentIntentBody = z.infer<
  typeof confirmPaymentIntentSchema
>;

export const paymentAttemptResponseSchema = z.object({
  id: z.uuid(),
  payment_intent_id: z.uuid(),
  merchant_id: z.uuid(),
  processor_account_id: z
    .uuid()
    .describe('The processor account the attempt was made with.'),
  status: z
    .enum(PAYMENT_ATTEMPT_STATUSES)
    .describe(
      'EXECUTING, REQUIRES_ACTION, and UNKNOWN are open and block a new attempt. AUTHORIZED holds the funds of a MANUAL payment until it is captured (SUCCEEDED) or voided (CANCELED). SUCCEEDED (captured), DECLINED, FAILED, and CANCELED are final.',
    ),
  provider_transaction_id: z
    .string()
    .nullable()
    .describe('The transaction at the provider, for example a Stripe pi_ ID.'),
  decline_code: z
    .string()
    .nullable()
    .describe("The provider's decline code of a DECLINED attempt, if any."),
  error_category: z
    .enum(PROCESSOR_ERROR_CATEGORIES)
    .nullable()
    .describe('Why a DECLINED, FAILED, or UNKNOWN attempt did not succeed.'),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type PaymentAttemptResponse = z.infer<
  typeof paymentAttemptResponseSchema
>;

export const paymentConfirmationResponseSchema = z.object({
  payment_intent: paymentIntentResponseSchema,
  attempt: paymentAttemptResponseSchema,
  next_action: z
    .object({
      type: z.literal('CUSTOMER_AUTHENTICATION'),
      client_secret: z
        .string()
        .describe(
          "Pass it to the provider's browser library (Stripe.js handleNextAction) to run the customer's step. Do not store or log it.",
        ),
    })
    .nullable()
    .describe(
      'Present only while the attempt is REQUIRES_ACTION; null otherwise.',
    ),
});

export type PaymentConfirmationResponse = z.infer<
  typeof paymentConfirmationResponseSchema
>;

export const paymentAttemptListResponseSchema = z.object({
  payment_intent_id: z.uuid(),
  merchant_id: z.uuid(),
  data: z.array(paymentAttemptResponseSchema).describe('Oldest first.'),
});

export type PaymentAttemptListResponse = z.infer<
  typeof paymentAttemptListResponseSchema
>;
