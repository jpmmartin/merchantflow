import { toAmountMinorString, type PaymentIntent } from '@merchantflow/domain';
import type { IdempotentResponse } from '../../idempotency/application/idempotency-record.js';
import type { PaymentIntentResponse } from './payment-intent.schemas.js';

/** HTTP status of a created intent, stored with its body under the key. */
export const PAYMENT_INTENT_CREATED_STATUS = 201;

/** The response body of an intent, built field by field. */
export function toPaymentIntentResponse(
  intent: PaymentIntent,
): PaymentIntentResponse {
  return {
    id: intent.id,
    merchant_id: intent.merchantId,
    amount_minor: toAmountMinorString(intent.amount),
    currency: intent.amount.currency,
    merchant_reference: intent.merchantReference,
    status: intent.status,
    created_at: intent.createdAt.toISOString(),
    updated_at: intent.updatedAt.toISOString(),
  };
}

/** The response of a created intent, as it is returned and stored. */
export function toCreatedPaymentIntentResponse(
  intent: PaymentIntent,
): IdempotentResponse {
  return {
    statusCode: PAYMENT_INTENT_CREATED_STATUS,
    body: { ...toPaymentIntentResponse(intent) },
  };
}
