import {
  createMoney,
  refundTotals,
  type CountedRefund,
  type CurrencyCode,
  type Money,
  type PaymentIntent,
  type PositiveMoney,
  type RefundStanding,
} from '@merchantflow/domain';
import {
  matchRefundResult,
  type ProcessorErrorCategory,
  type ProcessorRefundResult,
} from '@merchantflow/processor-contracts';

/**
 * Lifecycle statuses of a refund. `EXECUTING` is set before the provider is
 * called; `PENDING` means the provider accepted the refund and has not
 * finished it; `UNKNOWN` means the outcome could not be established.
 * `SUCCEEDED` and `FAILED` are final.
 */
export const REFUND_STATUSES = [
  'EXECUTING',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
] as const;

export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** A refund of a captured payment intent. Timestamps come from the injected clock. */
export interface Refund {
  readonly id: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  /** The successful attempt whose capture is refunded. */
  readonly paymentAttemptId: string;
  /** The account of that attempt, through which the refund goes. */
  readonly processorAccountId: string;
  /** The provider idempotency key of the refund, created before the call. */
  readonly operationId: string;
  /** The idempotency record of the request that started the refund. */
  readonly idempotencyRecordId: string;
  readonly amount: PositiveMoney;
  readonly status: RefundStatus;
  readonly providerRefundId: string | null;
  readonly failureCode: string | null;
  readonly errorCategory: ProcessorErrorCategory | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a provider refund result means for a refund row. */
export type RefundResolution =
  | {
      readonly status: 'SUCCEEDED' | 'PENDING';
      readonly providerRefundId: string;
      readonly failureCode: null;
      readonly errorCategory: null;
    }
  | {
      readonly status: 'FAILED';
      readonly providerRefundId: string | null;
      readonly failureCode: string | null;
      readonly errorCategory: ProcessorErrorCategory;
    }
  | {
      readonly status: 'UNKNOWN';
      readonly providerRefundId: string | null;
      readonly failureCode: null;
      readonly errorCategory: ProcessorErrorCategory;
    };

/**
 * Translates a normalized provider refund result into the change of the
 * refund. An unknown result is never read as a failure.
 */
export function refundResolutionOf(
  result: ProcessorRefundResult,
): RefundResolution {
  return matchRefundResult<RefundResolution>(result, {
    succeeded: (r) => ({
      status: 'SUCCEEDED',
      providerRefundId: r.providerRefundId,
      failureCode: null,
      errorCategory: null,
    }),
    pending: (r) => ({
      status: 'PENDING',
      providerRefundId: r.providerRefundId,
      failureCode: null,
      errorCategory: null,
    }),
    failed: (r) => ({
      status: 'FAILED',
      providerRefundId: r.providerRefundId,
      failureCode: r.failureCode,
      errorCategory: r.category,
    }),
    unknown: (r) => ({
      status: 'UNKNOWN',
      providerRefundId: r.providerRefundId,
      failureCode: null,
      errorCategory: r.category,
    }),
  });
}

/**
 * How the refund rule counts a refund: a success is refunded money; an
 * executing, pending, or unknown refund may still return money and stays
 * committed; a failed one returned nothing and is not counted.
 */
export function standingOf(status: RefundStatus): RefundStanding | undefined {
  switch (status) {
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'EXECUTING':
    case 'PENDING':
    case 'UNKNOWN':
      return 'IN_FLIGHT';
    case 'FAILED':
      return undefined;
  }
}

/** The refunds of a list as the refund rule counts them. */
export function countedRefunds(
  refunds: readonly Refund[],
): readonly CountedRefund[] {
  const counted: CountedRefund[] = [];
  for (const refund of refunds) {
    const standing = standingOf(refund.status);
    if (standing !== undefined) {
      counted.push({ amount: refund.amount, standing });
    }
  }
  return counted;
}

/** Statuses of an intent whose amount was captured. */
const CAPTURED_STATUSES: ReadonlySet<PaymentIntent['status']> = new Set([
  'SUCCEEDED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);

/**
 * The refund amounts of one intent, in its currency: what was captured, what
 * was refunded, what is still in flight (executing, pending, or unknown), and
 * what can still be refunded. An intent that was not captured has zero for
 * each.
 */
export interface RefundSummary {
  readonly currency: CurrencyCode;
  readonly captured: Money;
  readonly refunded: Money;
  readonly inFlight: Money;
  readonly refundable: Money;
}

function zero(currency: CurrencyCode): Money {
  const created = createMoney(0n, currency);
  if (!created.ok) throw new Error(`zero is not money in ${currency}`);
  return created.money;
}

/**
 * The summary of an intent and its refunds, by the domain's refund rule. Stored
 * refunds that break the rule are a defect and throw.
 */
export function refundSummaryOf(
  intent: PaymentIntent,
  refunds: readonly Refund[],
): RefundSummary {
  const { currency } = intent.amount;
  if (!CAPTURED_STATUSES.has(intent.status)) {
    const none = zero(currency);
    return {
      currency,
      captured: none,
      refunded: none,
      inFlight: none,
      refundable: none,
    };
  }
  const computed = refundTotals(intent.amount, countedRefunds(refunds));
  if (!computed.ok) {
    throw new Error(
      `refunds of payment intent ${intent.id} break the refund rule: ${computed.code}`,
    );
  }
  return { currency, ...computed.totals };
}
