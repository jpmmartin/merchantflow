import type { PositiveMoney } from '../money/money.js';

/**
 * Lifecycle statuses of a payment intent. An intent is the business intention
 * to collect an amount; each execution against a processor is a payment
 * attempt with its own lifecycle, modeled separately. `REQUIRES_ACTION` means
 * the customer must complete a step, such as 3D Secure, before the provider
 * decides the payment. `PARTIALLY_REFUNDED` and `REFUNDED` follow a captured
 * payment (`SUCCEEDED`) once part or all of its amount was refunded.
 * `REQUIRES_CAPTURE` means a manual-capture payment was authorized: the funds
 * are held on the customer's payment method and not captured. `CANCELED`
 * means that hold was released (voided) and nothing was captured.
 */
export const PAYMENT_INTENT_STATUSES = [
  'CREATED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'REQUIRES_ACTION',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'REQUIRES_CAPTURE',
  'CANCELED',
] as const;

export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/**
 * How a successful payment is captured, chosen when the intent is created:
 * `AUTOMATIC` authorizes and captures in one step; `MANUAL` only authorizes,
 * and the merchant captures or voids the hold afterwards.
 */
export const CAPTURE_MODES = ['AUTOMATIC', 'MANUAL'] as const;

export type CaptureMode = (typeof CAPTURE_MODES)[number];

/** A payment intent. Timestamps are supplied by the caller, never read here. */
export interface PaymentIntent {
  readonly id: string;
  /** The merchant that owns the intent; every query is scoped by it. */
  readonly merchantId: string;
  /** The amount to collect, greater than zero, with its currency. */
  readonly amount: PositiveMoney;
  /** The merchant's own order identifier, unique per merchant. */
  readonly merchantReference: string;
  /** How a successful payment of the intent is captured; it never changes. */
  readonly captureMode: CaptureMode;
  readonly status: PaymentIntentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
