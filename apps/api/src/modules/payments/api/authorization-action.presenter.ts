import { toAmountMinorString, type PaymentIntent } from '@merchantflow/domain';
import type { IdempotentResponse } from '../../idempotency/application/idempotency-record.js';
import type { AuthorizationActionView } from '../application/apply-authorization-action.service.js';
import type { AuthorizationAction } from '../application/authorization-action.js';
import type { AuthorizationActionChange } from '../application/resolve-authorization-action.service.js';
import type {
  AuthorizationActionListResponse,
  AuthorizationActionRefreshResponse,
  AuthorizationActionResponse,
  AuthorizationActionResultResponse,
} from './authorization-action.schemas.js';
import { toPaymentAttemptResponse } from './payment-confirmation.presenter.js';
import { toPaymentIntentResponse } from './payment-intent.presenter.js';

/** HTTP status of a capture or void whose outcome is known. */
export const AUTHORIZATION_ACTION_STATUS = 200;

/**
 * HTTP status of a capture or void whose outcome is unknown: the request was
 * accepted, and the hold may or may not have changed.
 */
export const AUTHORIZATION_ACTION_UNKNOWN_STATUS = 202;

/** The response body of an action, built field by field. */
export function toAuthorizationActionResponse(
  action: AuthorizationAction,
): AuthorizationActionResponse {
  return {
    id: action.id,
    payment_intent_id: action.paymentIntentId,
    merchant_id: action.merchantId,
    payment_attempt_id: action.paymentAttemptId,
    processor_account_id: action.processorAccountId,
    action: action.action,
    amount_minor: toAmountMinorString(action.amount),
    currency: action.amount.currency,
    status: action.status,
    failure_code: action.failureCode,
    error_category: action.errorCategory,
    created_at: action.createdAt.toISOString(),
    updated_at: action.updatedAt.toISOString(),
  };
}

function toResultBody(
  view: AuthorizationActionView,
): AuthorizationActionResultResponse {
  return {
    authorization_action: toAuthorizationActionResponse(view.action),
    payment_intent: toPaymentIntentResponse(view.intent),
    attempt: toPaymentAttemptResponse(view.attempt),
  };
}

/**
 * The answer of a capture or void, as it is returned and, for a known
 * outcome, stored under the request's key.
 */
export function toAuthorizationActionResult(
  view: AuthorizationActionView,
): IdempotentResponse {
  return {
    statusCode:
      view.action.status === 'UNKNOWN'
        ? AUTHORIZATION_ACTION_UNKNOWN_STATUS
        : AUTHORIZATION_ACTION_STATUS,
    body: { ...toResultBody(view) },
  };
}

/** The captures and voids of one intent, oldest first. */
export function toAuthorizationActionListResponse(
  intent: PaymentIntent,
  actions: readonly AuthorizationAction[],
): AuthorizationActionListResponse {
  return {
    payment_intent_id: intent.id,
    merchant_id: intent.merchantId,
    data: actions.map(toAuthorizationActionResponse),
  };
}

/** The answer of an action check. */
export function toAuthorizationActionRefreshResponse(
  view: AuthorizationActionView,
  change: AuthorizationActionChange | null,
): AuthorizationActionRefreshResponse {
  return { ...toResultBody(view), change };
}
