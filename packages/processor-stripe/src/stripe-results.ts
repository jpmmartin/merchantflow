import type {
  ProcessorAuthorizationActionResult,
  ProcessorErrorCategory,
  ProcessorPaymentResult,
  ProcessorRefundResult,
  ProcessorTransactionLookup,
} from '@merchantflow/processor-contracts';
import Stripe from 'stripe';

/** Stripe object IDs: a prefix such as `pi_` and letters, digits, or `_`. */
const STRIPE_ID = /^[a-z]{1,8}_[A-Za-z0-9_]{1,240}$/;

/** A PaymentIntent ID, such as the one a lookup names. */
export const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,240}$/;

/** A PaymentMethod ID created by Stripe.js, such as `pm_1Q...`. */
export const PAYMENT_METHOD_ID = /^pm_[A-Za-z0-9_]{1,240}$/;

/** The form of a decline code the platform stores. */
const DECLINE_CODE = /^[a-z0-9_]{1,64}$/;

function stripeIdOf(value: unknown): string | null {
  return typeof value === 'string' && STRIPE_ID.test(value) ? value : null;
}

function declineCodeOf(...candidates: readonly unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && DECLINE_CODE.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

const UNKNOWN_OUTCOME = {
  status: 'unknown',
  category: 'UNKNOWN',
} as const;

/**
 * Normalizes a PaymentIntent that Stripe returned. Only what the PaymentIntent
 * proves becomes a business outcome:
 *
 * - `succeeded`: the payment was captured, at once (automatic capture) or by
 *   a capture of its hold (manual capture);
 * - `requires_capture` of a PaymentIntent whose `capture_method` is `manual`:
 *   `authorized`, the funds are held and not captured;
 * - `canceled`: `canceled`, the PaymentIntent can no longer charge, and a hold
 *   it had was released;
 * - `requires_action` with a client secret: the customer must authenticate,
 *   and the secret lets Stripe.js run the step;
 * - `requires_payment_method` after a failed confirmation (with a
 *   `last_payment_error`): the payment failed and nothing was charged, which is
 *   a decline, with Stripe's decline code or error code.
 *
 * Every other status (`processing`, `requires_confirmation`, and
 * `requires_capture` of a PaymentIntent that is not manual-capture), a
 * PaymentIntent without the data its status needs, and any object in live
 * mode are `unknown`, never a decline.
 */
export function paymentIntentResult(
  intent: Stripe.PaymentIntent,
): ProcessorPaymentResult {
  const providerTransactionId = stripeIdOf(intent.id);
  if (intent.livemode) {
    return {
      status: 'unknown',
      category: 'CONFIGURATION',
      providerTransactionId,
    };
  }
  if (providerTransactionId === null) {
    return { ...UNKNOWN_OUTCOME, providerTransactionId: null };
  }
  switch (intent.status) {
    case 'succeeded':
      return { status: 'succeeded', providerTransactionId };
    case 'requires_capture':
      return intent.capture_method === 'manual'
        ? { status: 'authorized', providerTransactionId }
        : { ...UNKNOWN_OUTCOME, providerTransactionId };
    case 'canceled':
      return { status: 'canceled', providerTransactionId };
    case 'requires_action':
      if (
        typeof intent.client_secret === 'string' &&
        intent.client_secret !== ''
      ) {
        return {
          status: 'requires_action',
          providerTransactionId,
          clientSecret: intent.client_secret,
        };
      }
      return { ...UNKNOWN_OUTCOME, providerTransactionId };
    case 'requires_payment_method': {
      const failure = intent.last_payment_error;
      if (failure === null || failure === undefined) {
        return { ...UNKNOWN_OUTCOME, providerTransactionId };
      }
      return {
        status: 'declined',
        providerTransactionId,
        declineCode: declineCodeOf(failure.decline_code, failure.code),
      };
    }
    default:
      return { ...UNKNOWN_OUTCOME, providerTransactionId };
  }
}

/**
 * Normalizes an error of the create-and-confirm call by its class, never by
 * its message:
 *
 * - a card error (HTTP 402) is a decline: the payment failed and nothing was
 *   charged;
 * - an authentication or permission error (401, 403) and an invalid request
 *   (400, 404) are refusals before execution: Stripe saves no result for a
 *   request it refused, so nothing was charged;
 * - a broken connection or timeout, a server error, a conflict, a rate limit,
 *   an idempotency error, and any other Stripe error are `unknown`: the
 *   request, or a retry of it, may have been executed.
 *
 * An error that is not a Stripe error is a defect and is thrown again.
 */
export function saleErrorResult(error: unknown): ProcessorPaymentResult {
  if (error instanceof Stripe.errors.StripeCardError) {
    return {
      status: 'declined',
      providerTransactionId: stripeIdOf(error.payment_intent?.id),
      declineCode: declineCodeOf(error.decline_code, error.code),
    };
  }
  if (error instanceof Stripe.errors.StripeIdempotencyError) {
    return { ...UNKNOWN_OUTCOME, providerTransactionId: null };
  }
  if (
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError
  ) {
    return { status: 'failed_before_execution', category: 'CONFIGURATION' };
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return { status: 'failed_before_execution', category: 'INVALID_REQUEST' };
  }
  if (error instanceof Stripe.errors.StripeConnectionError) {
    return {
      status: 'unknown',
      category: 'NETWORK',
      providerTransactionId: null,
    };
  }
  if (
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    return {
      status: 'unknown',
      category: 'GATEWAY',
      providerTransactionId: null,
    };
  }
  if (error instanceof Stripe.errors.StripeError) {
    return { ...UNKNOWN_OUTCOME, providerTransactionId: null };
  }
  throw error;
}

/**
 * Normalizes an error of a PaymentIntent lookup by its class. A failed lookup
 * says nothing about the payment, so every Stripe error is `unavailable` with
 * its category; an error that is not a Stripe error is thrown again.
 */
export function lookupErrorResult(error: unknown): ProcessorTransactionLookup {
  return { outcome: 'unavailable', category: unavailableCategoryOf(error) };
}

/** A category of a provider answer that is not usable. */
export type UnavailableCategory = Exclude<
  ProcessorErrorCategory,
  'ISSUER_DECLINE'
>;

/**
 * The category of an error of a call whose failure says nothing about the
 * object it reads or changes, by the error's class alone; an error that is
 * not a Stripe error is a defect and is thrown again.
 */
export function unavailableCategoryOf(error: unknown): UnavailableCategory {
  if (
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError
  ) {
    return 'CONFIGURATION';
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return 'INVALID_REQUEST';
  }
  if (error instanceof Stripe.errors.StripeConnectionError) {
    return 'NETWORK';
  }
  if (
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    return 'GATEWAY';
  }
  if (error instanceof Stripe.errors.StripeError) {
    return 'UNKNOWN';
  }
  throw error;
}

/** What a refund response must match: the PaymentIntent and the amount sent. */
export interface ExpectedRefund {
  readonly paymentIntentId: string;
  readonly amount: number;
  readonly currency: string;
}

const REFUND_UNKNOWN = { status: 'unknown', category: 'UNKNOWN' } as const;

/**
 * Normalizes a Refund that Stripe returned for `refunds.create` or
 * `refunds.retrieve` with the PaymentIntent expanded. The Refund object carries no `livemode`, so the
 * mode is read from the expanded PaymentIntent: a PaymentIntent in live mode,
 * or one that is not expanded, is `unknown` (the refund may have moved real
 * money, or the mode cannot be proven). A refund of another PaymentIntent,
 * another amount, or another currency than the one sent, or without an ID,
 * is `unknown` too. Then, by Stripe's refund status:
 *
 * - `succeeded` → `succeeded`;
 * - `pending`, and `requires_action` (Stripe waits for the customer's
 *   instructions; not used by cards) → `pending`: the refund exists and has
 *   not finished;
 * - `failed` → `failed` with category `ISSUER_DECLINE` and Stripe's
 *   `failure_reason`; `canceled` → `failed` with category `UNKNOWN` and the
 *   code `canceled`: in both cases no money was returned;
 * - any other status, or none → `unknown`.
 */
export function refundResult(
  refund: Stripe.Refund,
  expected: ExpectedRefund,
): ProcessorRefundResult {
  const providerRefundId = stripeIdOf(refund.id);
  const intent = refund.payment_intent;
  if (intent === null || typeof intent === 'string') {
    return { ...REFUND_UNKNOWN, providerRefundId };
  }
  if (intent.livemode) {
    return { status: 'unknown', category: 'CONFIGURATION', providerRefundId };
  }
  if (
    providerRefundId === null ||
    intent.id !== expected.paymentIntentId ||
    refund.amount !== expected.amount ||
    refund.currency !== expected.currency
  ) {
    return { ...REFUND_UNKNOWN, providerRefundId };
  }
  switch (refund.status) {
    case 'succeeded':
      return { status: 'succeeded', providerRefundId };
    case 'pending':
    case 'requires_action':
      return { status: 'pending', providerRefundId };
    case 'failed':
      return {
        status: 'failed',
        providerRefundId,
        category: 'ISSUER_DECLINE',
        failureCode: declineCodeOf(refund.failure_reason),
      };
    case 'canceled':
      return {
        status: 'failed',
        providerRefundId,
        category: 'UNKNOWN',
        failureCode: 'canceled',
      };
    default:
      return { ...REFUND_UNKNOWN, providerRefundId };
  }
}

/**
 * Normalizes an error of `refunds.create` by its class, never by its message:
 *
 * - an authentication or permission error (401, 403) is `failed` with the
 *   category `CONFIGURATION`, and an invalid request (400, 404; for example an
 *   amount above what Stripe can still refund, or a PaymentIntent already
 *   refunded) is `failed` with `INVALID_REQUEST`: Stripe refused the request
 *   and created no refund;
 * - a broken connection or timeout, a server error, a conflict, a rate limit,
 *   an idempotency error, a card error (not documented for refunds), and any
 *   other Stripe error are `unknown`: the request, or a retry of it, may have
 *   been executed.
 *
 * An error that is not a Stripe error is a defect and is thrown again.
 */
export function refundErrorResult(error: unknown): ProcessorRefundResult {
  if (
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError
  ) {
    return {
      status: 'failed',
      providerRefundId: null,
      category: 'CONFIGURATION',
      failureCode: null,
    };
  }
  if (error instanceof Stripe.errors.StripeIdempotencyError) {
    return { ...REFUND_UNKNOWN, providerRefundId: null };
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return {
      status: 'failed',
      providerRefundId: null,
      category: 'INVALID_REQUEST',
      failureCode: declineCodeOf(error.code),
    };
  }
  if (error instanceof Stripe.errors.StripeConnectionError) {
    return { status: 'unknown', category: 'NETWORK', providerRefundId: null };
  }
  if (
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    return { status: 'unknown', category: 'GATEWAY', providerRefundId: null };
  }
  if (error instanceof Stripe.errors.StripeError) {
    return { ...REFUND_UNKNOWN, providerRefundId: null };
  }
  throw error;
}

/** What a capture or void answer must match: the PaymentIntent acted on. */
export interface ExpectedAuthorizationAction {
  readonly paymentIntentId: string;
  /** For a capture: the amount captured and its currency, as sent. */
  readonly captured?: { readonly amount: number; readonly currency: string };
}

const ACTION_UNKNOWN = { status: 'unknown', category: 'UNKNOWN' } as const;

/**
 * Normalizes the PaymentIntent that `paymentIntents.capture` returned. Only a
 * test-mode PaymentIntent with the ID sent, `capture_method` `manual`, status
 * `succeeded`, and `amount_received` and `currency` equal to what was sent
 * proves the capture: `succeeded`. Live mode is `unknown` with the category
 * `CONFIGURATION`, and any other answer is `unknown`.
 */
export function captureResult(
  intent: Stripe.PaymentIntent,
  expected: ExpectedAuthorizationAction,
): ProcessorAuthorizationActionResult {
  if (intent.livemode) return { status: 'unknown', category: 'CONFIGURATION' };
  const captured = expected.captured;
  if (
    captured !== undefined &&
    intent.id === expected.paymentIntentId &&
    intent.capture_method === 'manual' &&
    intent.status === 'succeeded' &&
    intent.amount_received === captured.amount &&
    intent.currency === captured.currency
  ) {
    return { status: 'succeeded' };
  }
  return ACTION_UNKNOWN;
}

/**
 * Normalizes the PaymentIntent that `paymentIntents.cancel` returned. Only a
 * test-mode PaymentIntent with the ID sent and status `canceled` proves the
 * hold was released: `succeeded`. Live mode is `unknown` with the category
 * `CONFIGURATION`, and any other answer is `unknown`.
 */
export function voidResult(
  intent: Stripe.PaymentIntent,
  expected: ExpectedAuthorizationAction,
): ProcessorAuthorizationActionResult {
  if (intent.livemode) return { status: 'unknown', category: 'CONFIGURATION' };
  if (intent.id === expected.paymentIntentId && intent.status === 'canceled') {
    return { status: 'succeeded' };
  }
  return ACTION_UNKNOWN;
}

/**
 * Normalizes an error of `paymentIntents.capture` or `paymentIntents.cancel`
 * by its class, never by its message:
 *
 * - an authentication or permission error (401, 403) is `failed` with the
 *   category `CONFIGURATION`, and an invalid request (400, 404; for example a
 *   PaymentIntent whose authorization expired or that is no longer
 *   `requires_capture`) is `failed` with `INVALID_REQUEST` and Stripe's error
 *   code: Stripe refused the request and changed nothing;
 * - a broken connection or timeout, a server error, a conflict, a rate limit,
 *   an idempotency error, a card error, and any other Stripe error are
 *   `unknown`: the request, or a retry of it, may have been executed.
 *
 * An error that is not a Stripe error is a defect and is thrown again.
 */
export function authorizationActionErrorResult(
  error: unknown,
): ProcessorAuthorizationActionResult {
  if (
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError
  ) {
    return { status: 'failed', category: 'CONFIGURATION', failureCode: null };
  }
  if (error instanceof Stripe.errors.StripeIdempotencyError) {
    return ACTION_UNKNOWN;
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return {
      status: 'failed',
      category: 'INVALID_REQUEST',
      failureCode: declineCodeOf(error.code),
    };
  }
  if (error instanceof Stripe.errors.StripeConnectionError) {
    return { status: 'unknown', category: 'NETWORK' };
  }
  if (
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    return { status: 'unknown', category: 'GATEWAY' };
  }
  if (error instanceof Stripe.errors.StripeError) {
    return ACTION_UNKNOWN;
  }
  throw error;
}
