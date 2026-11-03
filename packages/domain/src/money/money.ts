import {
  MAX_AMOUNT_MINOR,
  MIN_AMOUNT_MINOR,
  parseAmountMinor,
  type AmountMinorParseFailure,
} from './amount-minor.js';
import { isSupportedCurrency, type CurrencyCode } from './currency.js';

declare const moneyBrand: unique symbol;
declare const positiveMoneyBrand: unique symbol;

/**
 * An exact amount of money: a whole number of minor units of a supported
 * currency, within the range of PostgreSQL `BIGINT` (-2^63 to 2^63 - 1). Zero
 * and negative amounts are valid money, because balances and differences are
 * signed; an amount that must be greater than zero is a `PositiveMoney`.
 *
 * The brand leaves the constructors in this module as the only way to obtain
 * a `Money`, so every value in circulation has been checked. Values are frozen.
 */
export interface Money {
  readonly [moneyBrand]: true;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

/** Money that is greater than zero, as the amount of a payment must be. */
export interface PositiveMoney extends Money {
  readonly [positiveMoneyBrand]: true;
}

export type CurrencyMismatchFailure = {
  readonly ok: false;
  readonly code: 'CURRENCY_MISMATCH';
  readonly left: CurrencyCode;
  readonly right: CurrencyCode;
};

export type CreateMoneyFailure =
  | { readonly ok: false; readonly code: 'NOT_A_BIGINT' }
  | { readonly ok: false; readonly code: 'OUT_OF_RANGE' }
  | { readonly ok: false; readonly code: 'UNSUPPORTED_CURRENCY' };

export type CreateMoneyResult =
  { readonly ok: true; readonly money: Money } | CreateMoneyFailure;

export type ParseMoneyFailure =
  | AmountMinorParseFailure
  | { readonly ok: false; readonly code: 'UNSUPPORTED_CURRENCY' };

export type ParseMoneyResult =
  { readonly ok: true; readonly money: Money } | ParseMoneyFailure;

export type ToPositiveMoneyFailure = {
  readonly ok: false;
  readonly code: 'NOT_POSITIVE';
};

export type ToPositiveMoneyResult =
  { readonly ok: true; readonly money: PositiveMoney } | ToPositiveMoneyFailure;

export type ParsePositiveMoneyFailure =
  ParseMoneyFailure | ToPositiveMoneyFailure;

export type ParsePositiveMoneyResult =
  | { readonly ok: true; readonly money: PositiveMoney }
  | ParsePositiveMoneyFailure;

export type MoneyArithmeticFailure =
  | CurrencyMismatchFailure
  | { readonly ok: false; readonly code: 'OVERFLOW' }
  | { readonly ok: false; readonly code: 'UNDERFLOW' };

export type MoneyArithmeticResult =
  { readonly ok: true; readonly money: Money } | MoneyArithmeticFailure;

/** How the left operand of a comparison relates to the right one. */
export type MoneyOrder = 'LESS' | 'EQUAL' | 'GREATER';

export type MoneyComparisonResult =
  { readonly ok: true; readonly order: MoneyOrder } | CurrencyMismatchFailure;

export type MoneyEqualityResult =
  { readonly ok: true; readonly equal: boolean } | CurrencyMismatchFailure;

function makeMoney(amountMinor: bigint, currency: CurrencyCode): Money {
  return Object.freeze({ amountMinor, currency }) as Money;
}

function currencyMismatch(left: Money, right: Money): CurrencyMismatchFailure {
  return {
    ok: false,
    code: 'CURRENCY_MISMATCH',
    left: left.currency,
    right: right.currency,
  };
}

/**
 * Builds money from minor units and a currency code, as they come from a typed
 * source such as a database row. The amount is checked first: it must be a
 * `bigint` within the `BIGINT` range. Then the currency must be supported.
 */
export function createMoney(
  amountMinor: bigint,
  currency: string,
): CreateMoneyResult {
  // The parameter type already says `bigint`; the check covers a caller whose
  // value was typed wrongly, such as a driver that returned text.
  if (typeof amountMinor !== 'bigint') {
    return { ok: false, code: 'NOT_A_BIGINT' };
  }
  if (amountMinor < MIN_AMOUNT_MINOR || amountMinor > MAX_AMOUNT_MINOR) {
    return { ok: false, code: 'OUT_OF_RANGE' };
  }
  if (!isSupportedCurrency(currency)) {
    return { ok: false, code: 'UNSUPPORTED_CURRENCY' };
  }
  return { ok: true, money: makeMoney(amountMinor, currency) };
}

/**
 * Builds money from the `amount_minor` string and the `currency` of an API
 * payload. The amount is parsed strictly by `parseAmountMinor` and checked
 * first, then the currency. Zero is valid; a sign never is, so the result is
 * never negative.
 */
export function parseMoney(
  amountMinor: unknown,
  currency: unknown,
): ParseMoneyResult {
  const parsed = parseAmountMinor(amountMinor);
  if (!parsed.ok) {
    return parsed;
  }
  if (!isSupportedCurrency(currency)) {
    return { ok: false, code: 'UNSUPPORTED_CURRENCY' };
  }
  return { ok: true, money: makeMoney(parsed.amountMinor, currency) };
}

/** Accepts money only when it is greater than zero. */
export function toPositiveMoney(money: Money): ToPositiveMoneyResult {
  if (money.amountMinor <= 0n) {
    return { ok: false, code: 'NOT_POSITIVE' };
  }
  return { ok: true, money: money as PositiveMoney };
}

/**
 * Builds the amount of a payment from an API payload: `parseMoney`, then a
 * check that the amount is greater than zero. A zero amount fails with
 * `NOT_POSITIVE`, and a negative one cannot be written because the parser
 * rejects signs.
 */
export function parsePositiveMoney(
  amountMinor: unknown,
  currency: unknown,
): ParsePositiveMoneyResult {
  const parsed = parseMoney(amountMinor, currency);
  if (!parsed.ok) {
    return parsed;
  }
  return toPositiveMoney(parsed.money);
}

/**
 * Turns the exact result of an operation into money. `bigint` arithmetic never
 * wraps, so a result outside the `BIGINT` range is reported, not truncated.
 */
function settle(currency: CurrencyCode, exact: bigint): MoneyArithmeticResult {
  if (exact > MAX_AMOUNT_MINOR) {
    return { ok: false, code: 'OVERFLOW' };
  }
  if (exact < MIN_AMOUNT_MINOR) {
    return { ok: false, code: 'UNDERFLOW' };
  }
  return { ok: true, money: makeMoney(exact, currency) };
}

/** Adds two amounts of the same currency. */
export function addMoney(left: Money, right: Money): MoneyArithmeticResult {
  if (left.currency !== right.currency) {
    return currencyMismatch(left, right);
  }
  return settle(left.currency, left.amountMinor + right.amountMinor);
}

/**
 * Subtracts the right amount from the left one, both of the same currency. The
 * difference may be negative.
 */
export function subtractMoney(
  left: Money,
  right: Money,
): MoneyArithmeticResult {
  if (left.currency !== right.currency) {
    return currencyMismatch(left, right);
  }
  return settle(left.currency, left.amountMinor - right.amountMinor);
}

/** Compares two amounts of the same currency. */
export function compareMoney(left: Money, right: Money): MoneyComparisonResult {
  if (left.currency !== right.currency) {
    return currencyMismatch(left, right);
  }
  if (left.amountMinor < right.amountMinor) {
    return { ok: true, order: 'LESS' };
  }
  if (left.amountMinor > right.amountMinor) {
    return { ok: true, order: 'GREATER' };
  }
  return { ok: true, order: 'EQUAL' };
}

/**
 * Tells whether two amounts of the same currency are equal. Amounts of
 * different currencies are not reported as unequal: they cannot be compared.
 */
export function equalsMoney(left: Money, right: Money): MoneyEqualityResult {
  const comparison = compareMoney(left, right);
  if (!comparison.ok) {
    return comparison;
  }
  return { ok: true, equal: comparison.order === 'EQUAL' };
}

/**
 * The integer string of the API for an amount: its minor units in base 10,
 * for example `"10000"` for $100.00. It adds no decimal point or symbol. The
 * text of a negative amount starts with `-`, which `parseAmountMinor` rejects,
 * because the input of a payment is never negative.
 */
export function toAmountMinorString(money: Money): string {
  return money.amountMinor.toString();
}
