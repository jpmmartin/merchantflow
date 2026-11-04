import type {
  ProcessorPaymentResult,
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
 * - `succeeded`: the payment was captured (automatic capture);
 * - `requires_action` with a client secret: the customer must authenticate,
 *   and the secret lets Stripe.js run the step;
 * - `requires_payment_method` after a failed confirmation (with a
 *   `last_payment_error`): the payment failed and nothing was charged, which is
 *   a decline, with Stripe's decline code or error code.
 *
 * Every other status (`processing`, `requires_confirmation`,
 * `requires_capture`, `canceled`), a PaymentIntent without the data its status
 * needs, and any object in live mode are `unknown`, never a decline.
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
  if (
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripePermissionError
  ) {
    return { outcome: 'unavailable', category: 'CONFIGURATION' };
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return { outcome: 'unavailable', category: 'INVALID_REQUEST' };
  }
  if (error instanceof Stripe.errors.StripeConnectionError) {
    return { outcome: 'unavailable', category: 'NETWORK' };
  }
  if (
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    return { outcome: 'unavailable', category: 'GATEWAY' };
  }
  if (error instanceof Stripe.errors.StripeError) {
    return { outcome: 'unavailable', category: 'UNKNOWN' };
  }
  throw error;
}
