import {
  currencyExponent,
  isSupportedCurrency,
  parseAmountMinor,
  parsePositiveMoney,
  toAmountMinorString,
  type CurrencyCode,
} from '@merchantflow/domain';

/** Why a typed amount cannot be sent. */
export type DecimalAmountFailureCode =
  | 'EMPTY'
  | 'NEGATIVE'
  | 'INVALID_FORMAT'
  | 'TOO_MANY_DECIMALS'
  | 'NOT_POSITIVE'
  | 'OUT_OF_RANGE';

export type DecimalAmountResult =
  | { readonly ok: true; readonly amountMinor: string }
  | { readonly ok: false; readonly code: DecimalAmountFailureCode };

/**
 * A whole part without leading zeros (a single `0` is allowed, as in `0.01`)
 * and an optional decimal point followed by at least one digit. Only ASCII
 * digits; no sign, spaces, separators, or exponent.
 */
const DECIMAL_AMOUNT = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** Leading zeros of a digit string that keep at least one digit. */
const LEADING_ZEROS = /^0+(?=[0-9])/;

/**
 * Converts an amount typed in major units, such as `100.50`, to the integer
 * string of minor units the API takes, such as `"10050"`, with text operations
 * only: the decimal part is padded to the currency's exponent and joined to
 * the whole part, and leading zeros are removed. The result is then checked by
 * the domain's own `parsePositiveMoney`, the parser the API applies, so an
 * amount accepted here is accepted there. Nothing is trimmed or corrected: a
 * value that needs repair is refused.
 */
export function decimalToAmountMinor(
  input: string,
  currency: CurrencyCode,
): DecimalAmountResult {
  if (input.length === 0) return { ok: false, code: 'EMPTY' };
  if (input.startsWith('-')) return { ok: false, code: 'NEGATIVE' };
  const match = DECIMAL_AMOUNT.exec(input);
  if (match === null) return { ok: false, code: 'INVALID_FORMAT' };
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  const exponent = currencyExponent(currency);
  if (fraction.length > exponent) {
    return { ok: false, code: 'TOO_MANY_DECIMALS' };
  }
  const digits = `${whole}${fraction.padEnd(exponent, '0')}`.replace(
    LEADING_ZEROS,
    '',
  );
  const parsed = parsePositiveMoney(digits, currency);
  if (parsed.ok) {
    return { ok: true, amountMinor: toAmountMinorString(parsed.money) };
  }
  switch (parsed.code) {
    case 'NOT_POSITIVE':
      return { ok: false, code: 'NOT_POSITIVE' };
    case 'OUT_OF_RANGE':
      return { ok: false, code: 'OUT_OF_RANGE' };
    case 'NOT_A_STRING':
    case 'EMPTY':
    case 'INVALID_FORMAT':
    case 'LEADING_ZERO':
    case 'UNSUPPORTED_CURRENCY':
      // The digits were built above from a checked format and a supported
      // currency, so the domain parser cannot refuse them for these reasons.
      return { ok: false, code: 'INVALID_FORMAT' };
  }
}

/** A message for a refused amount, safe to show next to the field. */
export function decimalAmountMessage(
  code: DecimalAmountFailureCode,
  currency: CurrencyCode,
): string {
  switch (code) {
    case 'EMPTY':
      return 'Enter an amount.';
    case 'NEGATIVE':
      return 'The amount cannot be negative.';
    case 'INVALID_FORMAT':
      return 'Enter digits with an optional decimal point, for example 100.50, without a sign, spaces, separators, or leading zeros.';
    case 'TOO_MANY_DECIMALS': {
      const exponent = currencyExponent(currency);
      return exponent === 0
        ? `${currency} amounts have no decimal places.`
        : `${currency} amounts have at most ${exponent} decimal places.`;
    }
    case 'NOT_POSITIVE':
      return 'The amount must be greater than zero.';
    case 'OUT_OF_RANGE':
      return 'The amount is too large.';
  }
}

/**
 * Formats an API amount in minor units, such as `"10050"`, in major units, such
 * as `100.50`, by inserting the decimal point with text operations: the digits
 * are padded on the left to more than the exponent, and the last `exponent`
 * digits become the decimal part. An amount that is not a valid integer
 * string, or a currency the domain does not support, is shown as it came, with
 * a note, rather than guessed.
 */
export function formatAmountMinor(
  amountMinor: string,
  currency: string,
): string {
  if (!isSupportedCurrency(currency) || !parseAmountMinor(amountMinor).ok) {
    return `${amountMinor} (minor units)`;
  }
  const exponent = currencyExponent(currency);
  if (exponent === 0) return amountMinor;
  const padded = amountMinor.padStart(exponent + 1, '0');
  return `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

/**
 * Formats a signed API amount in minor units, such as a balance `"-10050"`,
 * as `-100.50`: the sign is kept as text and the digits are formatted by
 * `formatAmountMinor`.
 */
export function formatSignedAmountMinor(
  amountMinor: string,
  currency: string,
): string {
  if (amountMinor.startsWith('-')) {
    const digits = amountMinor.slice(1);
    return parseAmountMinor(digits).ok && digits !== '0'
      ? `-${formatAmountMinor(digits, currency)}`
      : `${amountMinor} (minor units)`;
  }
  return formatAmountMinor(amountMinor, currency);
}
