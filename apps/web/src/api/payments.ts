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
