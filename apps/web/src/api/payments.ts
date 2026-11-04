import {
  PAYMENT_INTENT_STATUSES,
  type PaymentIntentStatus,
} from '@merchantflow/domain';
import { apiRequest } from './client';

export { PAYMENT_INTENT_STATUSES, type PaymentIntentStatus };

/** A payment intent as the API returns it; `amount_minor` is an integer string. */
export interface PaymentIntent {
  readonly id: string;
  readonly merchant_id: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly merchant_reference: string;
  readonly status: PaymentIntentStatus;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PaymentIntentPage {
  readonly data: readonly PaymentIntent[];
  readonly next_cursor: string | null;
}

export interface NewPaymentIntent {
  readonly amount_minor: string;
  readonly currency: string;
  readonly merchant_reference: string;
}

/** Whether a text, such as a query parameter, is a payment intent status. */
export function isPaymentIntentStatus(
  value: string,
): value is PaymentIntentStatus {
  return (PAYMENT_INTENT_STATUSES as readonly string[]).includes(value);
}

/** One page of the merchant's intents, newest first, optionally of one status. */
export async function listPaymentIntents(page: {
  readonly cursor: string | undefined;
  readonly status: PaymentIntentStatus | undefined;
}): Promise<PaymentIntentPage> {
  const query = new URLSearchParams();
  if (page.status !== undefined) query.set('status', page.status);
  if (page.cursor !== undefined) query.set('cursor', page.cursor);
  const text = query.toString();
  const search = text === '' ? '' : `?${text}`;
  return (await apiRequest(
    'GET',
    `/payment-intents${search}`,
  )) as PaymentIntentPage;
}

/**
 * Creates an intent under `idempotencyKey`. Sending the same values with the
 * same key again returns the intent the first request created, if it did.
 */
export async function createPaymentIntent(
  intent: NewPaymentIntent,
  idempotencyKey: string,
): Promise<PaymentIntent> {
  return (await apiRequest('POST', '/payment-intents', {
    body: intent,
    headers: { 'Idempotency-Key': idempotencyKey },
  })) as PaymentIntent;
}

export async function getPaymentIntent(id: string): Promise<PaymentIntent> {
  return (await apiRequest(
    'GET',
    `/payment-intents/${encodeURIComponent(id)}`,
  )) as PaymentIntent;
}

/** Statuses of a payment attempt, as the API returns them. */
export type PaymentAttemptStatus =
  | 'EXECUTING'
  | 'REQUIRES_ACTION'
  | 'SUCCEEDED'
  | 'DECLINED'
  | 'FAILED'
  | 'UNKNOWN';

/** One execution of an intent against a processor account. */
export interface PaymentAttempt {
  readonly id: string;
  readonly payment_intent_id: string;
  readonly merchant_id: string;
  readonly processor_account_id: string;
  readonly status: PaymentAttemptStatus;
  readonly provider_transaction_id: string | null;
  readonly decline_code: string | null;
  readonly error_category: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * The answer of a confirmation or a completion. `next_action` is present only
 * while the customer must authenticate; its client secret goes to Stripe.js
 * and is never kept.
 */
export interface PaymentConfirmation {
  readonly payment_intent: PaymentIntent;
  readonly attempt: PaymentAttempt;
  readonly next_action: {
    readonly type: 'CUSTOMER_AUTHENTICATION';
    readonly client_secret: string;
  } | null;
}

export interface PaymentAttemptList {
  readonly payment_intent_id: string;
  readonly merchant_id: string;
  readonly data: readonly PaymentAttempt[];
}

/**
 * Pays an intent with a payment method created by Stripe.js, through the
 * account whose publishable key created it, under `idempotencyKey`. Sending
 * the same payment method with the same key again returns the stored answer
 * instead of charging twice.
 */
export async function confirmPaymentIntent(
  id: string,
  payment: {
    readonly payment_method: string;
    readonly processor_account_id: string;
  },
  idempotencyKey: string,
): Promise<PaymentConfirmation> {
  return (await apiRequest(
    'POST',
    `/payment-intents/${encodeURIComponent(id)}/confirm`,
    { body: payment, headers: { 'Idempotency-Key': idempotencyKey } },
  )) as PaymentConfirmation;
}

/**
 * Asks the API to read the result of the customer's action from Stripe and
 * apply it. Safe to call more than once.
 */
export async function completePaymentAction(
  id: string,
): Promise<PaymentConfirmation> {
  return (await apiRequest(
    'POST',
    `/payment-intents/${encodeURIComponent(id)}/complete-action`,
  )) as PaymentConfirmation;
}

export async function listPaymentAttempts(
  id: string,
): Promise<PaymentAttemptList> {
  return (await apiRequest(
    'GET',
    `/payment-intents/${encodeURIComponent(id)}/attempts`,
  )) as PaymentAttemptList;
}

/** Statuses of a refund, as the API returns them. */
export type RefundStatus =
  'EXECUTING' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';

/** One refund of a captured intent; `amount_minor` is an integer string. */
export interface Refund {
  readonly id: string;
  readonly payment_intent_id: string;
  readonly merchant_id: string;
  readonly payment_attempt_id: string;
  readonly processor_account_id: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly status: RefundStatus;
  readonly provider_refund_id: string | null;
  readonly failure_code: string | null;
  readonly error_category: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The refunds of one intent with its refund amounts, all integer strings. */
export interface RefundList {
  readonly payment_intent_id: string;
  readonly merchant_id: string;
  readonly currency: string;
  readonly captured_amount_minor: string;
  readonly refunded_amount_minor: string;
  readonly pending_amount_minor: string;
  readonly refundable_amount_minor: string;
  readonly data: readonly Refund[];
}

/** The answer of a refund request. */
export interface RefundCreation {
  readonly refund: Refund;
  readonly payment_intent: PaymentIntent & {
    readonly refunded_amount_minor: string;
    readonly refundable_amount_minor: string;
  };
}

/**
 * Refunds `amount_minor` of an intent under `idempotencyKey`. Sending the same
 * amount with the same key again returns the stored answer instead of a
 * second refund.
 */
export async function createRefund(
  id: string,
  amountMinor: string,
  idempotencyKey: string,
): Promise<RefundCreation> {
  return (await apiRequest(
    'POST',
    `/payment-intents/${encodeURIComponent(id)}/refunds`,
    {
      body: { amount_minor: amountMinor },
      headers: { 'Idempotency-Key': idempotencyKey },
    },
  )) as RefundCreation;
}

export async function listRefunds(id: string): Promise<RefundList> {
  return (await apiRequest(
    'GET',
    `/payment-intents/${encodeURIComponent(id)}/refunds`,
  )) as RefundList;
}

/** The answer of a refund check with Stripe. */
export interface RefundRefresh extends RefundCreation {
  readonly change:
    | 'REFUND_SUCCEEDED'
    | 'REFUND_FAILED'
    | 'REFUND_PENDING'
    | 'REFUND_REVERSED'
    | null;
}

/** Checks a refund with Stripe and applies what Stripe reports. */
export async function refreshRefund(
  id: string,
  refundId: string,
): Promise<RefundRefresh> {
  return (await apiRequest(
    'POST',
    `/payment-intents/${encodeURIComponent(id)}/refunds/${encodeURIComponent(refundId)}/refresh`,
  )) as RefundRefresh;
}
