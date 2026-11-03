import { describe, expect, it } from 'vitest';
import {
  MAX_AMOUNT_MINOR,
  MIN_AMOUNT_MINOR,
  parseAmountMinor,
  type AmountMinorParseResult,
} from './amount-minor.js';

describe('amount bounds', () => {
  it('are the limits of PostgreSQL BIGINT', () => {
    expect(MAX_AMOUNT_MINOR).toBe(9223372036854775807n);
    expect(MIN_AMOUNT_MINOR).toBe(-9223372036854775808n);
    expect(MAX_AMOUNT_MINOR).toBe(2n ** 63n - 1n);
    expect(MIN_AMOUNT_MINOR).toBe(-(2n ** 63n));
  });
});

describe('parseAmountMinor', () => {
  it.each([
    { name: 'zero', input: '0', expected: 0n },
    { name: 'one', input: '1', expected: 1n },
    { name: 'a single digit', input: '9', expected: 9n },
    { name: 'ten thousand', input: '10000', expected: 10000n },
    {
      name: 'the largest safe integer',
      input: '9007199254740991',
      expected: 9007199254740991n,
    },
    {
      name: 'the first integer past the safe range',
      input: '9007199254740992',
      expected: 9007199254740992n,
    },
    {
      name: 'an integer that has no number representation',
      input: '9007199254740993',
      expected: 9007199254740993n,
    },
    {
      name: 'the next integer after that one',
      input: '9007199254740994',
      expected: 9007199254740994n,
    },
    {
      name: 'one below the BIGINT maximum',
      input: '9223372036854775806',
      expected: 9223372036854775806n,
    },
    {
      name: 'the BIGINT maximum',
      input: '9223372036854775807',
      expected: 9223372036854775807n,
    },
    {
      name: 'a nineteen-digit value below the maximum',
      input: '1000000000000000000',
      expected: 1000000000000000000n,
    },
  ])('accepts $name', ({ input, expected }) => {
    const result = parseAmountMinor(input);
    expect(result).toEqual({ ok: true, amountMinor: expected });
    if (result.ok) {
      expect(typeof result.amountMinor).toBe('bigint');
      expect(result.amountMinor.toString()).toBe(input);
    }
  });

  it.each([
    { name: 'a number', input: 10000 },
    { name: 'a bigint', input: 10000n },
    { name: 'a boolean', input: true },
    { name: 'null', input: null },
    { name: 'undefined', input: undefined },
    { name: 'an object', input: {} },
    { name: 'an array holding a digit string', input: ['1'] },
    { name: 'a String object', input: new String('1') },
  ])('rejects $name as not a string', ({ input }) => {
    expect(parseAmountMinor(input)).toEqual({
      ok: false,
      code: 'NOT_A_STRING',
    });
  });

  it('rejects the empty string', () => {
    expect(parseAmountMinor('')).toEqual({ ok: false, code: 'EMPTY' });
  });

  it.each([
    { name: 'a single space', input: ' ' },
    { name: 'leading whitespace', input: ' 1' },
    { name: 'trailing whitespace', input: '1 ' },
    { name: 'surrounding whitespace', input: ' 1 ' },
    { name: 'a leading tab', input: '\t1' },
    { name: 'a trailing newline', input: '1\n' },
    { name: 'a leading newline', input: '\n1' },
    { name: 'a carriage return', input: '1\r' },
    { name: 'a trailing non-breaking space', input: '1 ' },
    { name: 'a zero-width space between digits', input: '1​2' },
    { name: 'a trailing null character', input: '1\u0000' },
    { name: 'a plus sign', input: '+1' },
    { name: 'a minus sign', input: '-1' },
    { name: 'a negative zero', input: '-0' },
    { name: 'a plus sign before zero', input: '+0' },
    { name: 'a sign alone', input: '-' },
    { name: 'a sign after the digits', input: '1-' },
    {
      name: 'a minus sign before a value above the BIGINT range',
      input: `-${'9'.repeat(30)}`,
    },
    { name: 'a decimal point', input: '1.0' },
    { name: 'a fraction', input: '100.50' },
    { name: 'a trailing decimal point', input: '1.' },
    { name: 'a leading decimal point', input: '.5' },
    { name: 'a decimal comma', input: '1,5' },
    { name: 'a thousands separator', input: '1,000' },
    { name: 'an underscore separator', input: '1_000' },
    { name: 'a lowercase exponent', input: '1e3' },
    { name: 'an uppercase exponent', input: '1E3' },
    { name: 'a signed exponent', input: '1e+3' },
    { name: 'a hexadecimal prefix', input: '0x10' },
    { name: 'a binary prefix', input: '0b1' },
    { name: 'an octal prefix', input: '0o7' },
    { name: 'a bigint suffix', input: '1n' },
    { name: 'Infinity', input: 'Infinity' },
    { name: 'NaN', input: 'NaN' },
    { name: 'letters', input: 'abc' },
    { name: 'a digit followed by a letter', input: '12a' },
    { name: 'an Arabic-Indic digit', input: '٣' },
    { name: 'fullwidth digits', input: '１２' },
    { name: 'a superscript digit', input: '²' },
    { name: 'a Devanagari digit among ASCII digits', input: '1१' },
  ])('rejects $name as an invalid format', ({ input }) => {
    expect(parseAmountMinor(input)).toEqual({
      ok: false,
      code: 'INVALID_FORMAT',
    });
  });

  it.each([
    { name: 'two zeros', input: '00' },
    { name: 'a zero before one digit', input: '01' },
    { name: 'a zero before several digits', input: '007' },
    { name: 'a zero before a typical amount', input: '010000' },
    { name: 'thirty zeros', input: '0'.repeat(30) },
    { name: 'a zero before the BIGINT maximum', input: '09223372036854775807' },
    {
      name: 'a zero before a value above the BIGINT maximum',
      input: '09223372036854775808',
    },
  ])('rejects $name as a leading zero', ({ input }) => {
    expect(parseAmountMinor(input)).toEqual({
      ok: false,
      code: 'LEADING_ZERO',
    });
  });

  it.each([
    { name: 'one above the BIGINT maximum', input: '9223372036854775808' },
    {
      name: 'the BIGINT maximum with a digit appended',
      input: '92233720368547758070',
    },
    { name: 'twenty digits', input: '10000000000000000000' },
    { name: 'twenty nines', input: '9'.repeat(20) },
    { name: '2^64', input: '18446744073709551616' },
    { name: 'a ten thousand digit value', input: '9'.repeat(10_000) },
    { name: 'a million digit value', input: '1'.repeat(1_000_000) },
  ])('rejects $name as out of range', ({ input }) => {
    expect(parseAmountMinor(input)).toEqual({
      ok: false,
      code: 'OUT_OF_RANGE',
    });
  });

  it('can be handled exhaustively', () => {
    const explain = (result: AmountMinorParseResult): string => {
      if (result.ok) return 'parsed';
      switch (result.code) {
        case 'NOT_A_STRING':
          return 'not a string';
        case 'EMPTY':
          return 'empty';
        case 'INVALID_FORMAT':
          return 'invalid format';
        case 'LEADING_ZERO':
          return 'leading zero';
        case 'OUT_OF_RANGE':
          return 'out of range';
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    };
    expect(explain(parseAmountMinor('01'))).toBe('leading zero');
    expect(explain(parseAmountMinor('1'))).toBe('parsed');
  });
});
