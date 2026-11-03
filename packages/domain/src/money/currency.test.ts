import { describe, expect, it } from 'vitest';
import {
  CURRENCY_EXPONENTS,
  currencyExponent,
  isSupportedCurrency,
} from './currency.js';

describe('currency table', () => {
  it('gives USD an exponent of 2', () => {
    expect(CURRENCY_EXPONENTS.USD).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
  });
});

describe('isSupportedCurrency', () => {
  it('accepts the exact code of a supported currency', () => {
    expect(isSupportedCurrency('USD')).toBe(true);
  });

  it.each([
    { name: 'a currency outside the table', value: 'EUR' },
    { name: 'a currency with no minor unit outside the table', value: 'JPY' },
    { name: 'lowercase', value: 'usd' },
    { name: 'mixed case', value: 'Usd' },
    { name: 'leading whitespace', value: ' USD' },
    { name: 'trailing whitespace', value: 'USD ' },
    { name: 'a trailing newline', value: 'USD\n' },
    { name: 'a longer code', value: 'USDX' },
    { name: 'a shorter code', value: 'US' },
    { name: 'the empty string', value: '' },
    { name: 'the numeric ISO code', value: '840' },
    { name: 'the name of an inherited property', value: 'constructor' },
    { name: 'the prototype accessor', value: '__proto__' },
    { name: 'toString', value: 'toString' },
    { name: 'hasOwnProperty', value: 'hasOwnProperty' },
    { name: 'a number', value: 840 },
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
    { name: 'an object that prints as USD', value: { toString: () => 'USD' } },
  ])('rejects $name', ({ value }) => {
    expect(isSupportedCurrency(value)).toBe(false);
  });
});
