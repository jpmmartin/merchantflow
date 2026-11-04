import type { PositiveMoney } from '@merchantflow/domain';

/**
 * The largest `amount` the Stripe API reference documents for a
 * PaymentIntent: eight digits, 99999999 in the smallest currency unit
 * (999,999.99 USD). Card networks may accept more, but this bound holds for
 * every network.
 */
export const STRIPE_MAX_AMOUNT_MINOR = 99_999_999n;

/** `Number.MAX_SAFE_INTEGER` as a `bigint`: above it a `number` rounds. */
const MAX_SAFE_AMOUNT_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Currencies the adapter sends to Stripe, with Stripe's code. For each of them
 * the platform's minor unit is Stripe's smallest currency unit, so the amount
 * is sent unchanged; a currency missing here is refused instead of being sent
 * in a unit Stripe may read differently.
 */
const STRIPE_CURRENCY_CODES: Readonly<Record<string, string>> = {
  USD: 'usd',
};

export type StripeAmountResult =
  | { readonly ok: true; readonly amount: number; readonly currency: string }
  | {
      readonly ok: false;
      readonly code:
        'UNSUPPORTED_CURRENCY' | 'ABOVE_SAFE_INTEGER' | 'ABOVE_STRIPE_MAXIMUM';
    };

/**
 * The one place where a payment amount leaves `bigint`: the Stripe API and
 * SDK take `amount` as a JSON number. The amount is converted only when it is
 * at most `Number.MAX_SAFE_INTEGER`, so the `number` is exact, and at most
 * `STRIPE_MAX_AMOUNT_MINOR`, so Stripe accepts it; anything above either bound
 * is refused before any call. The amount is already greater than zero
 * (`PositiveMoney`); Stripe's minimum charge (0.50 USD) is left to Stripe,
 * which refuses a smaller amount as an invalid request.
 */
export function toStripeAmount(amount: PositiveMoney): StripeAmountResult {
  const currency = Object.hasOwn(STRIPE_CURRENCY_CODES, amount.currency)
    ? STRIPE_CURRENCY_CODES[amount.currency]
    : undefined;
  if (currency === undefined) {
    return { ok: false, code: 'UNSUPPORTED_CURRENCY' };
  }
  if (amount.amountMinor > MAX_SAFE_AMOUNT_MINOR) {
    return { ok: false, code: 'ABOVE_SAFE_INTEGER' };
  }
  if (amount.amountMinor > STRIPE_MAX_AMOUNT_MINOR) {
    return { ok: false, code: 'ABOVE_STRIPE_MAXIMUM' };
  }
  return { ok: true, amount: Number(amount.amountMinor), currency };
}
