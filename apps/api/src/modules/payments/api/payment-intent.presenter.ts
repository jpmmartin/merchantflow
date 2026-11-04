import { toAmountMinorString, type PaymentIntent } from '@merchantflow/domain';
import type { IdempotentResponse } from '../../idempotency/application/idempotency-record.js';
import { encodeKeysetCursor } from '../../pagination/keyset-cursor.js';
import type { PaymentIntentPage } from '../application/list-payment-intents.service.js';
import type {
  PaymentIntentListResponse,
  PaymentIntentResponse,
} from './payment-intent.schemas.js';

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
    capture_mode: intent.captureMode,
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

/** One page of a merchant's intents, each with the body of a single read. */
export function toPaymentIntentListResponse(
  page: PaymentIntentPage,
): PaymentIntentListResponse {
  return {
    data: page.intents.map(toPaymentIntentResponse),
    next_cursor: page.next === undefined ? null : encodeKeysetCursor(page.next),
  };
}
