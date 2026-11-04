import type { PaymentIntent } from '@merchantflow/domain';
import type { IdempotentResponse } from '../../idempotency/application/idempotency-record.js';
import type { PaymentConfirmationView } from '../application/apply-attempt-resolution.service.js';
import type { PaymentAttempt } from '../application/payment-attempt.js';
import type {
  PaymentAttemptListResponse,
  PaymentAttemptResponse,
  PaymentConfirmationResponse,
} from './payment-confirmation.schemas.js';
import { toPaymentIntentResponse } from './payment-intent.presenter.js';

/** HTTP status of a confirmation or completion whose outcome is known or pending on the customer. */
export const PAYMENT_CONFIRMATION_STATUS = 200;

/**
 * HTTP status of a confirmation or completion whose outcome is unknown: the
 * request was accepted, and the payment may or may not have been charged.
 */
export const PAYMENT_CONFIRMATION_UNKNOWN_STATUS = 202;

/** The response body of an attempt, built field by field. */
export function toPaymentAttemptResponse(
  attempt: PaymentAttempt,
): PaymentAttemptResponse {
  return {
    id: attempt.id,
    payment_intent_id: attempt.paymentIntentId,
    merchant_id: attempt.merchantId,
    processor_account_id: attempt.processorAccountId,
    status: attempt.status,
    provider_transaction_id: attempt.providerTransactionId,
    decline_code: attempt.declineCode,
    error_category: attempt.errorCategory,
    created_at: attempt.createdAt.toISOString(),
    updated_at: attempt.updatedAt.toISOString(),
  };
}

/**
 * The answer of a confirmation or a completion. A conclusive answer is stored
 * under the confirmation's key; it never carries a client secret, because
 * `next_action` is set only while the attempt is `REQUIRES_ACTION`, which is
 * never stored.
 */
export function toPaymentConfirmationResponse(
  view: PaymentConfirmationView,
): IdempotentResponse {
  const body: PaymentConfirmationResponse = {
    payment_intent: toPaymentIntentResponse(view.intent),
    attempt: toPaymentAttemptResponse(view.attempt),
    next_action:
      view.nextAction === null
        ? null
        : {
            type: 'CUSTOMER_AUTHENTICATION',
            client_secret: view.nextAction.clientSecret,
          },
  };
  return {
    statusCode:
      view.attempt.status === 'UNKNOWN'
        ? PAYMENT_CONFIRMATION_UNKNOWN_STATUS
        : PAYMENT_CONFIRMATION_STATUS,
    body: { ...body },
  };
}

/** The attempts of one intent, oldest first. */
export function toPaymentAttemptListResponse(
  intent: PaymentIntent,
  attempts: readonly PaymentAttempt[],
): PaymentAttemptListResponse {
  return {
    payment_intent_id: intent.id,
    merchant_id: intent.merchantId,
    data: attempts.map(toPaymentAttemptResponse),
  };
}
