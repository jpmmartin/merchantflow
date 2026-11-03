/**
 * Supported currencies, each with the exponent of its minor unit: the number
 * of decimal places between the major unit and the minor unit (100 cents make
 * one dollar, so the exponent of USD is 2). A currency is added by adding a
 * row; no other money code names a currency.
 */
export const CURRENCY_EXPONENTS = {
  USD: 2,
} as const satisfies Readonly<Record<string, number>>;

/** ISO 4217 code of a supported currency. */
export type CurrencyCode = keyof typeof CURRENCY_EXPONENTS;

/**
 * Tells whether a value is exactly the code of a supported currency. Codes are
 * matched as written: `usd` and ` USD` are not supported, and neither is a
 * property name inherited from `Object.prototype`.
 */
export function isSupportedCurrency(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && Object.hasOwn(CURRENCY_EXPONENTS, value);
}

/** Number of decimal places of the minor unit of a supported currency. */
export function currencyExponent(currency: CurrencyCode): number {
  return CURRENCY_EXPONENTS[currency];
}
