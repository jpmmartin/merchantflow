import {
  CURRENCY_EXPONENTS,
  PAYMENT_INTENT_STATUSES,
  isSupportedCurrency,
} from '@merchantflow/domain';
import { z } from 'zod';

// The currencies Money supports are the keys of its exponent table; the
// OpenAPI document lists exactly them, as for merchant creation (AD-58).
const SUPPORTED_CURRENCIES =
  Object.keys(CURRENCY_EXPONENTS).filter(isSupportedCurrency);

/**
 * The format of `payment_intents_merchant_reference_check`: 1 to 128 visible
 * ASCII characters. Nothing is trimmed, so the stored reference is the one
 * sent, and two references are the same only if every byte is.
 */
const MERCHANT_REFERENCE_FORMAT = /^[!-~]{1,128}$/;

/** The `:id` of a read request, validated before any tenant is consulted. */
export const paymentIntentIdParamSchema = z.uuid();

/**
 * The body of a create request. `amount_minor` is only typed here as a string:
 * its value is parsed by `parsePositiveMoney` from the domain, so a JSON number
 * is refused as `invalid_type` and never converted.
 */
export const createPaymentIntentSchema = z.strictObject({
  amount_minor: z
    .string()
    .describe(
      'Amount in minor units as a base-10 integer string greater than zero, for example "1000" for 10.00 USD. No sign, decimal point, spaces, or leading zeros; at most 9223372036854775807.',
    ),
  currency: z
    .enum(SUPPORTED_CURRENCIES)
    .describe(
      `ISO 4217 currency code. Supported: ${SUPPORTED_CURRENCIES.join(', ')}. It must be the merchant's default currency.`,
    ),
  merchant_reference: z
    .string()
    .regex(MERCHANT_REFERENCE_FORMAT)
    .describe(
      "The merchant's own order identifier: 1 to 128 visible ASCII characters, case-sensitive. A second intent with the same reference is refused.",
    ),
});

export type CreatePaymentIntentBody = z.infer<typeof createPaymentIntentSchema>;

export const paymentIntentResponseSchema = z.object({
  id: z.uuid(),
  merchant_id: z.uuid(),
  amount_minor: z
    .string()
    .describe('Amount in minor units as a base-10 integer string.'),
  currency: z.string(),
  merchant_reference: z.string(),
  status: z.enum(PAYMENT_INTENT_STATUSES),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

export type PaymentIntentResponse = z.infer<typeof paymentIntentResponseSchema>;
