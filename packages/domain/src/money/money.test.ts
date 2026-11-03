import { describe, expect, it } from 'vitest';
import { parseAmountMinor } from './amount-minor.js';
import {
  addMoney,
  compareMoney,
  createMoney,
  equalsMoney,
  parseMoney,
  parsePositiveMoney,
  subtractMoney,
  toAmountMinorString,
  toPositiveMoney,
  type CreateMoneyResult,
  type Money,
  type MoneyArithmeticResult,
  type MoneyComparisonResult,
  type MoneyEqualityResult,
  type ParsePositiveMoneyResult,
  type PositiveMoney,
} from './money.js';

// Written out as literals, so a change to the exported bounds fails these tests.
const BIGINT_MAX = 9223372036854775807n;
const BIGINT_MIN = -9223372036854775808n;
// 2^53 + 1: the smallest positive integer that has no `number` representation.
const FIRST_UNSAFE = 9007199254740993n;

/** Valid USD money for a fixture; a bad fixture fails loudly. */
function usd(amountMinor: bigint): Money {
  const result = createMoney(amountMinor, 'USD');
  if (!result.ok) {
    throw new Error(`fixture is not valid money: ${result.code}`);
  }
  return result.money;
}

/** The result expected from an operation that succeeds with USD money. */
function okUsd(amountMinor: bigint) {
  return { ok: true, money: { amountMinor, currency: 'USD' } };
}

/** The result expected from an operation whose exact outcome is `exact`. */
function expectedFor(exact: bigint) {
  if (exact > BIGINT_MAX) return { ok: false, code: 'OVERFLOW' };
  if (exact < BIGINT_MIN) return { ok: false, code: 'UNDERFLOW' };
  return okUsd(exact);
}

// USD is the only supported currency, so money in another currency cannot be
// built; it is forged here to exercise the guard against mixing currencies.
const forgedEur = { amountMinor: 100n, currency: 'EUR' } as unknown as Money;

/** Deterministic 64-bit signed pairs from a linear congruential generator. */
function signedPairs(count: number, seed: bigint): [bigint, bigint][] {
  const modulus = 2n ** 64n;
  const offset = 2n ** 63n;
  let state = seed;
  const next = (): bigint => {
    state = (state * 6364136223846793005n + 1442695040888963407n) % modulus;
    return state - offset;
  };
  return Array.from({ length: count }, (): [bigint, bigint] => [
    next(),
    next(),
  ]);
}

describe('createMoney', () => {
  it.each([
    { name: 'zero', amountMinor: 0n },
    { name: 'a positive amount', amountMinor: 10000n },
    { name: 'a negative amount', amountMinor: -10000n },
    { name: 'the largest safe integer', amountMinor: 9007199254740991n },
    { name: 'the first unsafe integer', amountMinor: FIRST_UNSAFE },
    { name: 'the BIGINT maximum', amountMinor: BIGINT_MAX },
    { name: 'the BIGINT minimum', amountMinor: BIGINT_MIN },
  ])('accepts $name', ({ amountMinor }) => {
    expect(createMoney(amountMinor, 'USD')).toEqual(okUsd(amountMinor));
  });

  it.each([
    { name: 'one above the BIGINT maximum', amountMinor: BIGINT_MAX + 1n },
    { name: 'one below the BIGINT minimum', amountMinor: BIGINT_MIN - 1n },
    { name: '2^64', amountMinor: 2n ** 64n },
    { name: '-2^64', amountMinor: -(2n ** 64n) },
  ])('rejects $name', ({ amountMinor }) => {
    expect(createMoney(amountMinor, 'USD')).toEqual({
      ok: false,
      code: 'OUT_OF_RANGE',
    });
  });

  it.each([
    { name: 'a number', value: 100 },
    { name: 'a numeric string', value: '100' },
    { name: 'null', value: null },
    { name: 'undefined', value: undefined },
  ])('rejects $name passed by an untyped caller', ({ value }) => {
    expect(createMoney(value as unknown as bigint, 'USD')).toEqual({
      ok: false,
      code: 'NOT_A_BIGINT',
    });
  });

  it.each([
    'EUR',
    'JPY',
    'usd',
    'US',
    'USDX',
    '',
    ' USD',
    'USD ',
    'constructor',
    '__proto__',
    'toString',
  ])('rejects the currency %j', (currency) => {
    expect(createMoney(100n, currency)).toEqual({
      ok: false,
      code: 'UNSUPPORTED_CURRENCY',
    });
  });

  it('rejects a currency that is not a string', () => {
    expect(createMoney(100n, undefined as unknown as string)).toEqual({
      ok: false,
      code: 'UNSUPPORTED_CURRENCY',
    });
  });

  it('checks the amount before the currency', () => {
    expect(createMoney(BIGINT_MAX + 1n, 'EUR')).toEqual({
      ok: false,
      code: 'OUT_OF_RANGE',
    });
  });

  it('returns a frozen value that cannot be changed', () => {
    const money = usd(100n);
    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as { amountMinor: bigint }).amountMinor = 1n;
    }).toThrow(TypeError);
    expect(money.amountMinor).toBe(100n);
  });

  it('returns a new value for each call', () => {
    const first = usd(100n);
    const second = usd(100n);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

describe('parseMoney', () => {
  it.each([
    { name: 'a typical amount', amountMinor: '10000', expected: 10000n },
    { name: 'zero', amountMinor: '0', expected: 0n },
    {
      name: 'the first unsafe integer',
      amountMinor: '9007199254740993',
      expected: FIRST_UNSAFE,
    },
    {
      name: 'the BIGINT maximum',
      amountMinor: '9223372036854775807',
      expected: BIGINT_MAX,
    },
  ])('accepts $name', ({ amountMinor, expected }) => {
    expect(parseMoney(amountMinor, 'USD')).toEqual(okUsd(expected));
  });

  it.each([
    { name: 'a number', amountMinor: 10000, code: 'NOT_A_STRING' },
    { name: 'the empty string', amountMinor: '', code: 'EMPTY' },
    { name: 'a decimal point', amountMinor: '100.00', code: 'INVALID_FORMAT' },
    { name: 'a minus sign', amountMinor: '-1', code: 'INVALID_FORMAT' },
    { name: 'a plus sign', amountMinor: '+1', code: 'INVALID_FORMAT' },
    { name: 'a leading zero', amountMinor: '01', code: 'LEADING_ZERO' },
    {
      name: 'one above the BIGINT maximum',
      amountMinor: '9223372036854775808',
      code: 'OUT_OF_RANGE',
    },
  ])('fails on $name with the code of the amount parser', (row) => {
    expect(parseMoney(row.amountMinor, 'USD')).toEqual({
      ok: false,
      code: row.code,
    });
  });

  it('gives the same failure as the amount parser', () => {
    for (const input of ['', '1.5', '-1', '01', '9'.repeat(40), 7, null]) {
      const parsed = parseAmountMinor(input);
      expect(parsed.ok).toBe(false);
      expect(parseMoney(input, 'USD')).toEqual(parsed);
    }
  });

  it.each([
    { name: 'a currency outside the table', currency: 'EUR' },
    { name: 'a lowercase code', currency: 'usd' },
    { name: 'the empty string', currency: '' },
    { name: 'an inherited property name', currency: 'constructor' },
    { name: 'a number', currency: 840 },
    { name: 'null', currency: null },
    { name: 'undefined', currency: undefined },
  ])('rejects $name as the currency', ({ currency }) => {
    expect(parseMoney('100', currency)).toEqual({
      ok: false,
      code: 'UNSUPPORTED_CURRENCY',
    });
  });

  it('checks the amount before the currency', () => {
    expect(parseMoney('01', 'EUR')).toEqual({
      ok: false,
      code: 'LEADING_ZERO',
    });
  });
});

describe('payment amounts', () => {
  it.each([
    { name: 'zero', amountMinor: 0n },
    { name: 'minus one', amountMinor: -1n },
    { name: 'a negative amount', amountMinor: -10000n },
    { name: 'the BIGINT minimum', amountMinor: BIGINT_MIN },
  ])('toPositiveMoney rejects $name', ({ amountMinor }) => {
    expect(toPositiveMoney(usd(amountMinor))).toEqual({
      ok: false,
      code: 'NOT_POSITIVE',
    });
  });

  it.each([
    { name: 'one minor unit', amountMinor: 1n },
    { name: 'a typical amount', amountMinor: 10000n },
    { name: 'the first unsafe integer', amountMinor: FIRST_UNSAFE },
    { name: 'the BIGINT maximum', amountMinor: BIGINT_MAX },
  ])('toPositiveMoney accepts $name', ({ amountMinor }) => {
    expect(toPositiveMoney(usd(amountMinor))).toEqual(okUsd(amountMinor));
  });

  it.each([
    { name: 'a typical amount', amountMinor: '10000', expected: 10000n },
    { name: 'one minor unit', amountMinor: '1', expected: 1n },
    {
      name: 'the BIGINT maximum',
      amountMinor: '9223372036854775807',
      expected: BIGINT_MAX,
    },
  ])('parsePositiveMoney accepts $name', ({ amountMinor, expected }) => {
    expect(parsePositiveMoney(amountMinor, 'USD')).toEqual(okUsd(expected));
  });

  it('parsePositiveMoney rejects zero', () => {
    expect(parsePositiveMoney('0', 'USD')).toEqual({
      ok: false,
      code: 'NOT_POSITIVE',
    });
  });

  it.each(['-1', '-10000', '-0', '-9223372036854775808', '+1'])(
    'parsePositiveMoney rejects the signed text %j',
    (amountMinor) => {
      expect(parsePositiveMoney(amountMinor, 'USD')).toEqual({
        ok: false,
        code: 'INVALID_FORMAT',
      });
    },
  );

  it.each([
    {
      name: 'a malformed amount',
      amountMinor: '1.5',
      currency: 'USD',
      code: 'INVALID_FORMAT',
    },
    {
      name: 'a leading zero',
      amountMinor: '01',
      currency: 'USD',
      code: 'LEADING_ZERO',
    },
    {
      name: 'an empty amount',
      amountMinor: '',
      currency: 'USD',
      code: 'EMPTY',
    },
    {
      name: 'a number',
      amountMinor: 100,
      currency: 'USD',
      code: 'NOT_A_STRING',
    },
    {
      name: 'one above the BIGINT maximum',
      amountMinor: '9223372036854775808',
      currency: 'USD',
      code: 'OUT_OF_RANGE',
    },
    {
      name: 'an unsupported currency',
      amountMinor: '100',
      currency: 'EUR',
      code: 'UNSUPPORTED_CURRENCY',
    },
    {
      name: 'zero in an unsupported currency',
      amountMinor: '0',
      currency: 'EUR',
      code: 'UNSUPPORTED_CURRENCY',
    },
  ])('parsePositiveMoney rejects $name', ({ amountMinor, currency, code }) => {
    expect(parsePositiveMoney(amountMinor, currency)).toEqual({
      ok: false,
      code,
    });
  });

  it('keeps the amount exact', () => {
    const result = parsePositiveMoney('9007199254740993', 'USD');
    expect(result).toEqual(okUsd(FIRST_UNSAFE));
  });
});

describe('addMoney', () => {
  it.each([
    { name: '1 + 2', left: 1n, right: 2n, sum: 3n },
    { name: '0 + 0', left: 0n, right: 0n, sum: 0n },
    { name: '5 + -3', left: 5n, right: -3n, sum: 2n },
    { name: '-5 + -3', left: -5n, right: -3n, sum: -8n },
    { name: '5 + -5', left: 5n, right: -5n, sum: 0n },
    {
      name: '2^53 + 1, where a number would stay at 2^53',
      left: 9007199254740992n,
      right: 1n,
      sum: FIRST_UNSAFE,
    },
    {
      name: '2^53 + 1 plus 1',
      left: FIRST_UNSAFE,
      right: 1n,
      sum: 9007199254740994n,
    },
    {
      name: 'the maximum minus one plus one',
      left: BIGINT_MAX - 1n,
      right: 1n,
      sum: BIGINT_MAX,
    },
    {
      name: 'the minimum plus one',
      left: BIGINT_MIN,
      right: 1n,
      sum: -9223372036854775807n,
    },
    {
      name: 'the maximum plus the minimum',
      left: BIGINT_MAX,
      right: BIGINT_MIN,
      sum: -1n,
    },
    {
      name: 'two halves that reach exactly the minimum',
      left: -4611686018427387904n,
      right: -4611686018427387904n,
      sum: BIGINT_MIN,
    },
  ])('adds $name', ({ left, right, sum }) => {
    expect(addMoney(usd(left), usd(right))).toEqual(okUsd(sum));
  });

  it.each([
    { name: 'the maximum plus one', left: BIGINT_MAX, right: 1n },
    { name: 'one plus the maximum', left: 1n, right: BIGINT_MAX },
    { name: 'the maximum plus itself', left: BIGINT_MAX, right: BIGINT_MAX },
    {
      name: 'two halves that reach 2^63',
      left: 4611686018427387904n,
      right: 4611686018427387904n,
    },
  ])('reports overflow for $name', ({ left, right }) => {
    expect(addMoney(usd(left), usd(right))).toEqual({
      ok: false,
      code: 'OVERFLOW',
    });
  });

  it.each([
    { name: 'the minimum plus minus one', left: BIGINT_MIN, right: -1n },
    { name: 'minus one plus the minimum', left: -1n, right: BIGINT_MIN },
    { name: 'the minimum plus itself', left: BIGINT_MIN, right: BIGINT_MIN },
    {
      name: 'two amounts that fall one short of the minimum',
      left: -4611686018427387904n,
      right: -4611686018427387905n,
    },
  ])('reports underflow for $name', ({ left, right }) => {
    expect(addMoney(usd(left), usd(right))).toEqual({
      ok: false,
      code: 'UNDERFLOW',
    });
  });

  it('changes neither operand', () => {
    const left = usd(7n);
    const right = usd(5n);
    addMoney(left, right);
    expect(left).toEqual({ amountMinor: 7n, currency: 'USD' });
    expect(right).toEqual({ amountMinor: 5n, currency: 'USD' });
  });

  it('returns frozen money', () => {
    const result = addMoney(usd(1n), usd(2n));
    expect(result.ok && Object.isFrozen(result.money)).toBe(true);
  });
});

describe('subtractMoney', () => {
  it.each([
    { name: '5 - 3', left: 5n, right: 3n, difference: 2n },
    { name: '3 - 5, which is negative', left: 3n, right: 5n, difference: -2n },
    { name: '7 - 7', left: 7n, right: 7n, difference: 0n },
    { name: 'an amount minus zero', left: 42n, right: 0n, difference: 42n },
    { name: 'zero minus an amount', left: 0n, right: 42n, difference: -42n },
    { name: '-5 - -3', left: -5n, right: -3n, difference: -2n },
    {
      name: '2^53 + 2 minus 1, where a number would stay at 2^53 + 2',
      left: 9007199254740994n,
      right: 1n,
      difference: FIRST_UNSAFE,
    },
    {
      name: '2^53 + 1 minus 1',
      left: FIRST_UNSAFE,
      right: 1n,
      difference: 9007199254740992n,
    },
    {
      name: 'zero minus the maximum',
      left: 0n,
      right: BIGINT_MAX,
      difference: -9223372036854775807n,
    },
    {
      name: 'minus one minus the maximum, which is exactly the minimum',
      left: -1n,
      right: BIGINT_MAX,
      difference: BIGINT_MIN,
    },
    {
      name: 'the minimum minus itself',
      left: BIGINT_MIN,
      right: BIGINT_MIN,
      difference: 0n,
    },
    {
      name: 'the maximum minus itself',
      left: BIGINT_MAX,
      right: BIGINT_MAX,
      difference: 0n,
    },
  ])('subtracts $name', ({ left, right, difference }) => {
    expect(subtractMoney(usd(left), usd(right))).toEqual(okUsd(difference));
  });

  it.each([
    { name: 'the maximum minus minus one', left: BIGINT_MAX, right: -1n },
    {
      name: 'zero minus the minimum, whose negation does not fit',
      left: 0n,
      right: BIGINT_MIN,
    },
    {
      name: 'the maximum minus the minimum',
      left: BIGINT_MAX,
      right: BIGINT_MIN,
    },
  ])('reports overflow for $name', ({ left, right }) => {
    expect(subtractMoney(usd(left), usd(right))).toEqual({
      ok: false,
      code: 'OVERFLOW',
    });
  });

  it.each([
    { name: 'the minimum minus one', left: BIGINT_MIN, right: 1n },
    {
      name: 'minus two minus the maximum, one below the minimum',
      left: -2n,
      right: BIGINT_MAX,
    },
    {
      name: 'the minimum minus the maximum',
      left: BIGINT_MIN,
      right: BIGINT_MAX,
    },
  ])('reports underflow for $name', ({ left, right }) => {
    expect(subtractMoney(usd(left), usd(right))).toEqual({
      ok: false,
      code: 'UNDERFLOW',
    });
  });

  it('changes neither operand', () => {
    const left = usd(7n);
    const right = usd(5n);
    subtractMoney(left, right);
    expect(left).toEqual({ amountMinor: 7n, currency: 'USD' });
    expect(right).toEqual({ amountMinor: 5n, currency: 'USD' });
  });
});

describe('compareMoney', () => {
  it.each([
    { name: '1 against 2', left: 1n, right: 2n, order: 'LESS' },
    { name: '2 against 1', left: 2n, right: 1n, order: 'GREATER' },
    { name: '2 against 2', left: 2n, right: 2n, order: 'EQUAL' },
    {
      name: 'a negative against a positive',
      left: -1n,
      right: 1n,
      order: 'LESS',
    },
    { name: 'zero against a negative', left: 0n, right: -1n, order: 'GREATER' },
    {
      name: 'the minimum against the maximum',
      left: BIGINT_MIN,
      right: BIGINT_MAX,
      order: 'LESS',
    },
    {
      name: 'the maximum against the minimum',
      left: BIGINT_MAX,
      right: BIGINT_MIN,
      order: 'GREATER',
    },
    {
      name: 'the maximum against itself',
      left: BIGINT_MAX,
      right: BIGINT_MAX,
      order: 'EQUAL',
    },
    {
      name: 'the minimum against itself',
      left: BIGINT_MIN,
      right: BIGINT_MIN,
      order: 'EQUAL',
    },
    {
      name: '2^53 + 1 against 2^53, which numbers cannot tell apart',
      left: FIRST_UNSAFE,
      right: 9007199254740992n,
      order: 'GREATER',
    },
    {
      name: '2^53 against 2^53 + 1',
      left: 9007199254740992n,
      right: FIRST_UNSAFE,
      order: 'LESS',
    },
    {
      name: 'the maximum against one below it, which numbers cannot tell apart',
      left: BIGINT_MAX,
      right: BIGINT_MAX - 1n,
      order: 'GREATER',
    },
  ])('orders $name', ({ left, right, order }) => {
    expect(compareMoney(usd(left), usd(right))).toEqual({ ok: true, order });
  });
});

describe('equalsMoney', () => {
  it.each([
    { name: 'the same amount', left: 5n, right: 5n, equal: true },
    { name: 'zero and zero', left: 0n, right: 0n, equal: true },
    { name: 'different amounts', left: 5n, right: 6n, equal: false },
    { name: 'opposite signs', left: -5n, right: 5n, equal: false },
    {
      name: 'the maximum and itself',
      left: BIGINT_MAX,
      right: BIGINT_MAX,
      equal: true,
    },
    {
      name: '2^53 + 1 and 2^53, which numbers cannot tell apart',
      left: FIRST_UNSAFE,
      right: 9007199254740992n,
      equal: false,
    },
  ])('finds $name', ({ left, right, equal }) => {
    expect(equalsMoney(usd(left), usd(right))).toEqual({ ok: true, equal });
  });

  it('compares values, not identity', () => {
    const first = usd(100n);
    const second = usd(100n);
    expect(first).not.toBe(second);
    expect(equalsMoney(first, second)).toEqual({ ok: true, equal: true });
  });
});

describe('currency mismatch', () => {
  const mismatch = {
    ok: false,
    code: 'CURRENCY_MISMATCH',
    left: 'USD',
    right: 'EUR',
  };

  it('is reported by addition', () => {
    expect(addMoney(usd(1n), forgedEur)).toEqual(mismatch);
  });

  it('is reported by subtraction', () => {
    expect(subtractMoney(usd(1n), forgedEur)).toEqual(mismatch);
  });

  it('is reported by comparison', () => {
    expect(compareMoney(usd(1n), forgedEur)).toEqual(mismatch);
  });

  it('is reported by equality instead of an answer of unequal', () => {
    expect(equalsMoney(usd(1n), forgedEur)).toEqual(mismatch);
  });

  it('names the currencies in the order of the operands', () => {
    expect(addMoney(forgedEur, usd(1n))).toEqual({
      ok: false,
      code: 'CURRENCY_MISMATCH',
      left: 'EUR',
      right: 'USD',
    });
  });

  it('is reported before an overflow or an underflow', () => {
    expect(addMoney(usd(BIGINT_MAX), forgedEur)).toEqual(mismatch);
    expect(subtractMoney(usd(BIGINT_MIN), forgedEur)).toEqual(mismatch);
  });

  it('is not reported for the same currency', () => {
    expect(addMoney(usd(1n), usd(1n)).ok).toBe(true);
  });
});

describe('toAmountMinorString', () => {
  it.each([
    { name: 'zero', amountMinor: 0n, text: '0' },
    { name: 'a typical amount', amountMinor: 10000n, text: '10000' },
    {
      name: 'the largest safe integer',
      amountMinor: 9007199254740991n,
      text: '9007199254740991',
    },
    {
      name: 'the first unsafe integer',
      amountMinor: FIRST_UNSAFE,
      text: '9007199254740993',
    },
    {
      name: 'the BIGINT maximum',
      amountMinor: BIGINT_MAX,
      text: '9223372036854775807',
    },
  ])('writes $name as an integer string', ({ amountMinor, text }) => {
    expect(toAmountMinorString(usd(amountMinor))).toBe(text);
  });

  it('round-trips through the amount parser', () => {
    for (const text of [
      '0',
      '1',
      '99',
      '10000',
      '9007199254740991',
      '9007199254740992',
      '9007199254740993',
      '9223372036854775806',
      '9223372036854775807',
    ]) {
      const parsed = parseMoney(text, 'USD');
      expect(parsed.ok && toAmountMinorString(parsed.money)).toBe(text);
    }
  });

  it('writes a minus sign for a negative amount, which the parser then rejects', () => {
    const text = toAmountMinorString(usd(-5n));
    expect(text).toBe('-5');
    expect(parseAmountMinor(text)).toEqual({
      ok: false,
      code: 'INVALID_FORMAT',
    });
  });

  it('adds no decimal point or currency symbol', () => {
    expect(toAmountMinorString(usd(12345n))).toBe('12345');
  });
});

describe('exactness over the whole range', () => {
  const edges = [
    BIGINT_MIN,
    BIGINT_MIN + 1n,
    BIGINT_MIN + 2n,
    -1n,
    0n,
    1n,
    BIGINT_MAX - 2n,
    BIGINT_MAX - 1n,
    BIGINT_MAX,
  ];
  const wide = signedPairs(2000, 20261103n);
  const narrow = wide.map(([left, right]): [bigint, bigint] => [
    left % 1_000_000_000_000n,
    right % 1_000_000_000_000n,
  ]);

  it('adds every pair of values next to the bounds as exact arithmetic says', () => {
    for (const left of edges) {
      for (const right of edges) {
        expect(addMoney(usd(left), usd(right))).toEqual(
          expectedFor(left + right),
        );
      }
    }
  });

  it('subtracts every pair of values next to the bounds as exact arithmetic says', () => {
    for (const left of edges) {
      for (const right of edges) {
        expect(subtractMoney(usd(left), usd(right))).toEqual(
          expectedFor(left - right),
        );
      }
    }
  });

  it('adds and subtracts values drawn from the whole range as exact arithmetic says', () => {
    for (const [left, right] of wide) {
      expect(addMoney(usd(left), usd(right))).toEqual(
        expectedFor(left + right),
      );
      expect(subtractMoney(usd(left), usd(right))).toEqual(
        expectedFor(left - right),
      );
    }
  });

  it('reaches success, overflow, and underflow in the draws from the whole range', () => {
    const outcomes = new Set(
      wide.map(([left, right]) => {
        const result = addMoney(usd(left), usd(right));
        return result.ok ? 'ok' : result.code;
      }),
    );
    expect(outcomes).toEqual(new Set(['ok', 'OVERFLOW', 'UNDERFLOW']));
  });

  it('keeps addition commutative and subtraction its inverse', () => {
    for (const [left, right] of narrow) {
      const forward = addMoney(usd(left), usd(right));
      expect(addMoney(usd(right), usd(left))).toEqual(forward);
      if (forward.ok) {
        expect(subtractMoney(forward.money, usd(right))).toEqual(okUsd(left));
      }
    }
  });

  it('orders values as the integers they hold', () => {
    const reversed = { LESS: 'GREATER', GREATER: 'LESS', EQUAL: 'EQUAL' };
    for (const [left, right] of [...wide, ...narrow]) {
      const expected =
        left < right ? 'LESS' : left > right ? 'GREATER' : 'EQUAL';
      const result = compareMoney(usd(left), usd(right));
      expect(result).toEqual({ ok: true, order: expected });
      expect(compareMoney(usd(right), usd(left))).toEqual({
        ok: true,
        order: reversed[expected],
      });
      expect(equalsMoney(usd(left), usd(right))).toEqual({
        ok: true,
        equal: left === right,
      });
    }
  });

  it('round-trips every non-negative value through its integer string', () => {
    for (const [left, right] of wide) {
      for (const amountMinor of [left, right]) {
        if (amountMinor < 0n) continue;
        const text = toAmountMinorString(usd(amountMinor));
        expect(text).toBe(amountMinor.toString());
        expect(parseMoney(text, 'USD')).toEqual(okUsd(amountMinor));
      }
    }
  });
});

describe('typed results', () => {
  it('can be handled exhaustively', () => {
    const explainCreate = (result: CreateMoneyResult): string => {
      if (result.ok) return 'created';
      switch (result.code) {
        case 'NOT_A_BIGINT':
          return 'not a bigint';
        case 'OUT_OF_RANGE':
          return 'out of range';
        case 'UNSUPPORTED_CURRENCY':
          return 'unsupported currency';
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    };
    const explainPositive = (result: ParsePositiveMoneyResult): string => {
      if (result.ok) return 'parsed';
      switch (result.code) {
        case 'NOT_A_STRING':
        case 'EMPTY':
        case 'INVALID_FORMAT':
        case 'LEADING_ZERO':
        case 'OUT_OF_RANGE':
          return 'invalid amount';
        case 'UNSUPPORTED_CURRENCY':
          return 'unsupported currency';
        case 'NOT_POSITIVE':
          return 'not positive';
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    };
    const explainArithmetic = (result: MoneyArithmeticResult): string => {
      if (result.ok) return 'computed';
      switch (result.code) {
        case 'CURRENCY_MISMATCH':
          return 'currency mismatch';
        case 'OVERFLOW':
          return 'overflow';
        case 'UNDERFLOW':
          return 'underflow';
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    };
    const explainComparison = (
      result: MoneyComparisonResult | MoneyEqualityResult,
    ): string => (result.ok ? 'compared' : result.code);

    expect(explainCreate(createMoney(1n, 'EUR'))).toBe('unsupported currency');
    expect(explainPositive(parsePositiveMoney('0', 'USD'))).toBe(
      'not positive',
    );
    expect(explainArithmetic(addMoney(usd(BIGINT_MAX), usd(1n)))).toBe(
      'overflow',
    );
    expect(explainComparison(compareMoney(usd(1n), forgedEur))).toBe(
      'CURRENCY_MISMATCH',
    );
  });
});

describe('type safety', () => {
  it('takes a bigint amount, never a number', () => {
    // @ts-expect-error a number is not assignable to the bigint parameter
    const result = createMoney(100, 'USD');
    expect(result).toEqual({ ok: false, code: 'NOT_A_BIGINT' });
  });

  it('cannot be built from an object literal', () => {
    // @ts-expect-error a plain object lacks the Money brand
    const forged: Money = { amountMinor: 1n, currency: 'USD' };
    expect(forged.amountMinor).toBe(1n);
  });

  it('does not take unchecked money as a payment amount', () => {
    // @ts-expect-error money that was not checked for being positive is not PositiveMoney
    const unchecked: PositiveMoney = usd(1n);
    expect(unchecked.amountMinor).toBe(1n);
  });

  it('takes a payment amount wherever money is expected', () => {
    const parsed = parsePositiveMoney('100', 'USD');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const asMoney: Money = parsed.money;
      expect(addMoney(asMoney, usd(1n))).toEqual(okUsd(101n));
    }
  });
});
