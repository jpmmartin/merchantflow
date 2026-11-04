import { toAmountMinorString, type PaymentIntent } from '@merchantflow/domain';
import type { IdempotentResponse } from '../../idempotency/application/idempotency-record.js';
import type { RefundView } from '../application/refund-payment-intent.service.js';
import type { Refund, RefundSummary } from '../application/refund.js';
import { toPaymentIntentResponse } from './payment-intent.presenter.js';
import type { RefundResolutionDetail } from '../application/resolve-refund.service.js';
import type {
  RefundCreationResponse,
  RefundListResponse,
  RefundRefreshResponse,
  RefundResponse,
} from './refund.schemas.js';

/** HTTP status of a refund whose outcome is known: succeeded, pending, or failed. */
export const REFUND_CREATED_STATUS = 201;

/**
 * HTTP status of a refund whose outcome is unknown: the request was accepted,
 * and money may or may not have been returned.
 */
export const REFUND_UNKNOWN_STATUS = 202;

/** The response body of a refund, built field by field. */
export function toRefundResponse(refund: Refund): RefundResponse {
  return {
    id: refund.id,
    payment_intent_id: refund.paymentIntentId,
    merchant_id: refund.merchantId,
    payment_attempt_id: refund.paymentAttemptId,
    processor_account_id: refund.processorAccountId,
    amount_minor: toAmountMinorString(refund.amount),
    currency: refund.amount.currency,
    status: refund.status,
    provider_refund_id: refund.providerRefundId,
    failure_code: refund.failureCode,
    error_category: refund.errorCategory,
    created_at: refund.createdAt.toISOString(),
    updated_at: refund.updatedAt.toISOString(),
  };
}

/**
 * The answer of a refund request. A conclusive answer is stored under the
 * request's key and replayed unchanged, amounts included.
 */
export function toRefundCreationResponse(view: RefundView): IdempotentResponse {
  const body: RefundCreationResponse = {
    refund: toRefundResponse(view.refund),
    payment_intent: {
      ...toPaymentIntentResponse(view.intent),
      refunded_amount_minor: toAmountMinorString(view.summary.refunded),
      refundable_amount_minor: toAmountMinorString(view.summary.refundable),
    },
  };
  return {
    statusCode:
      view.refund.status === 'UNKNOWN'
        ? REFUND_UNKNOWN_STATUS
        : REFUND_CREATED_STATUS,
    body: { ...body },
  };
}

/** The refunds of one intent, oldest first, with its refund amounts. */
export function toRefundListResponse(
  intent: PaymentIntent,
  refunds: readonly Refund[],
  summary: RefundSummary,
): RefundListResponse {
  return {
    payment_intent_id: intent.id,
    merchant_id: intent.merchantId,
    currency: summary.currency,
    captured_amount_minor: toAmountMinorString(summary.captured),
    refunded_amount_minor: toAmountMinorString(summary.refunded),
    pending_amount_minor: toAmountMinorString(summary.inFlight),
    refundable_amount_minor: toAmountMinorString(summary.refundable),
    data: refunds.map(toRefundResponse),
  };
}

/** The answer of a refund check: the refund, its intent, and what changed. */
export function toRefundRefreshResponse(
  view: RefundView,
  change: RefundResolutionDetail | null,
): RefundRefreshResponse {
  return {
    refund: toRefundResponse(view.refund),
    payment_intent: {
      ...toPaymentIntentResponse(view.intent),
      refunded_amount_minor: toAmountMinorString(view.summary.refunded),
      refundable_amount_minor: toAmountMinorString(view.summary.refundable),
    },
    change,
  };
}
