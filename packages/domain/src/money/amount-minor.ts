/** Largest amount in minor units: the maximum of PostgreSQL `BIGINT`, 2^63 - 1. */
export const MAX_AMOUNT_MINOR = 9223372036854775807n;

/** Smallest amount in minor units: the minimum of PostgreSQL `BIGINT`, -2^63. */
export const MIN_AMOUNT_MINOR = -9223372036854775808n;

export type AmountMinorParseFailure =
  | { readonly ok: false; readonly code: 'NOT_A_STRING' }
  | { readonly ok: false; readonly code: 'EMPTY' }
  | { readonly ok: false; readonly code: 'INVALID_FORMAT' }
  | { readonly ok: false; readonly code: 'LEADING_ZERO' }
  | { readonly ok: false; readonly code: 'OUT_OF_RANGE' };

export type AmountMinorParseResult =
  { readonly ok: true; readonly amountMinor: bigint } | AmountMinorParseFailure;

const ASCII_DIGITS = /^[0-9]+$/;
const MAX_DIGITS = MAX_AMOUNT_MINOR.toString().length;

/**
 * Parses the `amount_minor` string of the API into minor units. Only the
 * canonical text of a non-negative integer is accepted: `0`, or a digit from 1
 * to 9 followed by any number of digits, up to the `BIGINT` maximum. Nothing is
 * trimmed or normalized, and nothing passes through `number`.
 *
 * The format is checked before `BigInt` runs because `BigInt` alone accepts
 * `''` (as 0), surrounding whitespace, a sign, a `0x` prefix, and leading
 * zeros. The result carries a code instead of throwing for any invalid input,
 * including a value that is not a string.
 */
export function parseAmountMinor(input: unknown): AmountMinorParseResult {
  if (typeof input !== 'string') {
    return { ok: false, code: 'NOT_A_STRING' };
  }
  if (input.length === 0) {
    return { ok: false, code: 'EMPTY' };
  }
  if (!ASCII_DIGITS.test(input)) {
    return { ok: false, code: 'INVALID_FORMAT' };
  }
  if (input.length > 1 && input.startsWith('0')) {
    return { ok: false, code: 'LEADING_ZERO' };
  }
  // More digits than the maximum has can only be larger, and the length check
  // keeps `BigInt` from reading an arbitrarily long digit string.
  if (input.length > MAX_DIGITS) {
    return { ok: false, code: 'OUT_OF_RANGE' };
  }
  const amountMinor = BigInt(input);
  if (amountMinor > MAX_AMOUNT_MINOR) {
    return { ok: false, code: 'OUT_OF_RANGE' };
  }
  return { ok: true, amountMinor };
}
