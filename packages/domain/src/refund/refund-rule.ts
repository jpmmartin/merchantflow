import type { CurrencyCode } from '../money/currency.js';
import {
  addMoney,
  compareMoney,
  createMoney,
  subtractMoney,
  type Money,
  type PositiveMoney,
} from '../money/money.js';

/**
 * Where a refund of a captured payment stands, for the refund rule:
 *
 * - `SUCCEEDED`: the provider refunded the amount.
 * - `IN_FLIGHT`: the refund may still return money: it is executing, pending
 *   at the provider, or its outcome is unknown. Its amount stays committed.
 *
 * A refund that failed returned nothing and does not take part in the rule.
 */
export type RefundStanding = 'SUCCEEDED' | 'IN_FLIGHT';

/** One earlier refund of a payment, as the rule counts it. */
export interface CountedRefund {
  readonly amount: PositiveMoney;
  readonly standing: RefundStanding;
}

/** The amounts of a captured payment and its refunds, all in its currency. */
export interface RefundTotals {
  /** The captured amount of the payment. */
  readonly captured: PositiveMoney;
  /** The sum of the refunds that succeeded. */
  readonly refunded: Money;
  /** The sum of the refunds that are executing, pending, or unknown. */
  readonly inFlight: Money;
  /** What can still be refunded: captured minus refunded minus in flight. */
  readonly refundable: Money;
}

export type RefundTotalsFailure =
  /** A refund has another currency than the payment. */
  | { readonly ok: false; readonly code: 'CURRENCY_MISMATCH' }
  /**
   * The refunds already exceed the captured amount, or their sum leaves the
   * `BIGINT` range. Stored refunds can never reach this; it is a defect.
   */
  | { readonly ok: false; readonly code: 'REFUNDS_EXCEED_CAPTURED' };

export type RefundTotalsResult =
  { readonly ok: true; readonly totals: RefundTotals } | RefundTotalsFailure;

export type RefundRequestResult =
  | {
      readonly ok: true;
      readonly totals: RefundTotals;
      /** What can still be refunded once this refund is counted. */
      readonly refundableAfter: Money;
    }
  | RefundTotalsFailure
  /**
   * The requested amount is above the refundable amount, which counts every
   * refund that succeeded or is still in flight.
   */
  | {
      readonly ok: false;
      readonly code: 'AMOUNT_EXCEEDS_REFUNDABLE';
      readonly refundable: Money;
    };

function zero(currency: CurrencyCode): Money {
  const created = createMoney(0n, currency);
  if (!created.ok) {
    throw new Error(`zero is not money in ${currency}: ${created.code}`);
  }
  return created.money;
}

/**
 * The totals of a captured payment's refunds: the refunded amount, the amount
 * still in flight, and the refundable amount, which is the captured amount
 * minus both. Every amount must have the payment's currency. Exact `bigint`
 * arithmetic only.
 */
export function refundTotals(
  captured: PositiveMoney,
  refunds: readonly CountedRefund[],
): RefundTotalsResult {
  let refunded = zero(captured.currency);
  let inFlight = zero(captured.currency);
  for (const refund of refunds) {
    if (refund.amount.currency !== captured.currency) {
      return { ok: false, code: 'CURRENCY_MISMATCH' };
    }
    const sum = addMoney(
      refund.standing === 'SUCCEEDED' ? refunded : inFlight,
      refund.amount,
    );
    if (!sum.ok) return { ok: false, code: 'REFUNDS_EXCEED_CAPTURED' };
    if (refund.standing === 'SUCCEEDED') {
      refunded = sum.money;
    } else {
      inFlight = sum.money;
    }
  }
  const committed = addMoney(refunded, inFlight);
  if (!committed.ok) return { ok: false, code: 'REFUNDS_EXCEED_CAPTURED' };
  const refundable = subtractMoney(captured, committed.money);
  if (!refundable.ok || refundable.money.amountMinor < 0n) {
    return { ok: false, code: 'REFUNDS_EXCEED_CAPTURED' };
  }
  return {
    ok: true,
    totals: { captured, refunded, inFlight, refundable: refundable.money },
  };
}

/**
 * Decides whether a new refund of `requested` may be made against a captured
 * payment and its earlier refunds. The requested amount must have the
 * payment's currency and be at most the refundable amount, which already
 * subtracts every refund that succeeded or is still in flight.
 */
export function evaluateRefundRequest(
  captured: PositiveMoney,
  refunds: readonly CountedRefund[],
  requested: PositiveMoney,
): RefundRequestResult {
  if (requested.currency !== captured.currency) {
    return { ok: false, code: 'CURRENCY_MISMATCH' };
  }
  const computed = refundTotals(captured, refunds);
  if (!computed.ok) return computed;
  const { totals } = computed;
  const order = compareMoney(requested, totals.refundable);
  if (!order.ok) return { ok: false, code: 'CURRENCY_MISMATCH' };
  if (order.order === 'GREATER') {
    return {
      ok: false,
      code: 'AMOUNT_EXCEEDS_REFUNDABLE',
      refundable: totals.refundable,
    };
  }
  const after = subtractMoney(totals.refundable, requested);
  if (!after.ok) return { ok: false, code: 'REFUNDS_EXCEED_CAPTURED' };
  return { ok: true, totals, refundableAfter: after.money };
}

/**
 * The status a captured payment has after its successful refunds:
 * `REFUNDED` once they add up to the captured amount, `PARTIALLY_REFUNDED`
 * when they add up to less, and `SUCCEEDED` while none has succeeded. Refunds
 * in flight do not change it: only money proven returned does.
 */
export function refundedStatusOf(
  totals: RefundTotals,
): 'SUCCEEDED' | 'PARTIALLY_REFUNDED' | 'REFUNDED' {
  if (totals.refunded.amountMinor === 0n) return 'SUCCEEDED';
  return totals.refunded.amountMinor === totals.captured.amountMinor
    ? 'REFUNDED'
    : 'PARTIALLY_REFUNDED';
}
