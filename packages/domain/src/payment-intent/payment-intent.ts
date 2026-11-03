import type { PositiveMoney } from '../money/money.js';

/**
 * Lifecycle statuses of a payment intent in the MVP. An intent is the business
 * intention to collect an amount; each execution against a processor is a
 * payment attempt with its own lifecycle, modeled separately.
 */
export const PAYMENT_INTENT_STATUSES = [
  'CREATED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
] as const;

export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/** A payment intent. Timestamps are supplied by the caller, never read here. */
export interface PaymentIntent {
  readonly id: string;
  /** The merchant that owns the intent; every query is scoped by it. */
  readonly merchantId: string;
  /** The amount to collect, greater than zero, with its currency. */
  readonly amount: PositiveMoney;
  /** The merchant's own order identifier, unique per merchant. */
  readonly merchantReference: string;
  readonly status: PaymentIntentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
