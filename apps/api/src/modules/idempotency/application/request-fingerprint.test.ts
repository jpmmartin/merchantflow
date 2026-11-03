import { describe, expect, it } from 'vitest';
import {
  computeRequestFingerprint,
  type FingerprintValue,
} from './request-fingerprint.js';

const OPERATION = 'CREATE_PAYMENT_INTENT';

const REQUEST = {
  amount_minor: '10000',
  currency: 'USD',
  merchant_reference: 'order-1001',
  metadata: { channel: 'web', items: [1, 2.5, true, null] },
} as const satisfies FingerprintValue;

describe('computeRequestFingerprint', () => {
  describe('known vectors', () => {
    // Each expected digest was computed outside this code, with `sha256sum`
    // over the canonical text shown, written by hand.
    it('hashes the canonical text of a payment request', () => {
      // ["CREATE_PAYMENT_INTENT",{"amount_minor":"10000","currency":"USD","merchant_reference":"order-1001","metadata":{"channel":"web","items":[1,2.5,true,null]}}]
      expect(computeRequestFingerprint(OPERATION, REQUEST)).toBe(
        '070337f78bdd29fa514333c77213ce618b8132e607952cfdd2cc5c585af0efc0',
      );
    });

    it('hashes UTF-8 text, escaped quotes, an empty key, and an exponent', () => {
      // ["OP",{"":"é","b":"say \"hi\"","z":-1.5e-7}]
      expect(
        computeRequestFingerprint('OP', {
          z: -1.5e-7,
          b: 'say "hi"',
          '': 'é',
        }),
      ).toBe(
        'be8f014d6fd5829256f36e3e5cfb5613545cd31d11cd3a3a3deb6269771b10e3',
      );
    });

    it('is 64 lowercase hexadecimal characters', () => {
      expect(computeRequestFingerprint(OPERATION, REQUEST)).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });
  });

  describe('key order', () => {
    it('does not depend on the order in which keys were added', () => {
      const reordered = {
        metadata: { items: [1, 2.5, true, null], channel: 'web' },
        merchant_reference: 'order-1001',
        currency: 'USD',
        amount_minor: '10000',
      };

      expect(computeRequestFingerprint(OPERATION, reordered)).toBe(
        computeRequestFingerprint(OPERATION, REQUEST),
      );
    });

    it('does not depend on key order at any depth', () => {
      const built: Record<string, FingerprintValue> = {};
      for (const key of ['d', 'b', 'c', 'a']) {
        built[key] = { y: [{ q: 1, p: 2 }], x: key };
      }
      const literal = {
        a: { x: 'a', y: [{ p: 2, q: 1 }] },
        b: { x: 'b', y: [{ p: 2, q: 1 }] },
        c: { x: 'c', y: [{ p: 2, q: 1 }] },
        d: { x: 'd', y: [{ p: 2, q: 1 }] },
      };

      expect(computeRequestFingerprint('OP', built)).toBe(
        computeRequestFingerprint('OP', literal),
      );
    });

    it('treats an object without a prototype like a plain object', () => {
      const bare = Object.create(null) as Record<string, FingerprintValue>;
      bare.b = 2;
      bare.a = 1;

      expect(computeRequestFingerprint('OP', bare)).toBe(
        computeRequestFingerprint('OP', { a: 1, b: 2 }),
      );
    });
  });

  describe('sensitivity', () => {
    const base = computeRequestFingerprint(OPERATION, REQUEST);

    it.each<{ name: string; request: FingerprintValue }>([
      {
        name: 'another amount',
        request: { ...REQUEST, amount_minor: '10001' },
      },
      { name: 'another currency', request: { ...REQUEST, currency: 'usd' } },
      {
        name: 'another reference',
        request: { ...REQUEST, merchant_reference: 'order-1002' },
      },
      {
        name: 'another nested string',
        request: {
          ...REQUEST,
          metadata: { ...REQUEST.metadata, channel: 'app' },
        },
      },
      {
        name: 'another nested number',
        request: {
          ...REQUEST,
          metadata: { ...REQUEST.metadata, items: [1, 2.25, true, null] },
        },
      },
      {
        name: 'another boolean',
        request: {
          ...REQUEST,
          metadata: { ...REQUEST.metadata, items: [1, 2.5, false, null] },
        },
      },
      {
        name: 'a string instead of null',
        request: {
          ...REQUEST,
          metadata: { ...REQUEST.metadata, items: [1, 2.5, true, 'null'] },
        },
      },
      {
        name: 'reordered array items',
        request: {
          ...REQUEST,
          metadata: { ...REQUEST.metadata, items: [2.5, 1, true, null] },
        },
      },
      {
        name: 'an extra array item',
        request: {
          ...REQUEST,
          metadata: { ...REQUEST.metadata, items: [1, 2.5, true, null, null] },
        },
      },
      {
        name: 'a missing field',
        request: {
          amount_minor: '10000',
          currency: 'USD',
          merchant_reference: 'order-1001',
        },
      },
      {
        name: 'an extra field',
        request: { ...REQUEST, description: 'x' },
      },
      {
        name: 'a renamed field',
        request: {
          amount: '10000',
          currency: 'USD',
          merchant_reference: 'order-1001',
          metadata: REQUEST.metadata,
        },
      },
      {
        name: 'a number written as a string',
        request: {
          ...REQUEST,
          metadata: { ...REQUEST.metadata, items: ['1', 2.5, true, null] },
        },
      },
      {
        name: 'trailing whitespace in a value',
        request: { ...REQUEST, merchant_reference: 'order-1001 ' },
      },
    ])('changes for $name', ({ request }) => {
      expect(computeRequestFingerprint(OPERATION, request)).not.toBe(base);
    });

    it('changes when the operation changes', () => {
      expect(
        computeRequestFingerprint('CONFIRM_PAYMENT_INTENT', REQUEST),
      ).not.toBe(base);
    });

    it('keeps the operation and the request apart', () => {
      expect(computeRequestFingerprint('A', 'BC')).not.toBe(
        computeRequestFingerprint('AB', 'C'),
      );
    });

    it('distinguishes Unicode normalization forms', () => {
      // U+00E9 against U+0065 U+0301: the same text to a reader, different requests here.
      expect(computeRequestFingerprint('OP', { name: '\u00e9' })).not.toBe(
        computeRequestFingerprint('OP', { name: 'e\u0301' }),
      );
    });

    it('treats negative zero as zero, as JSON does', () => {
      expect(computeRequestFingerprint('OP', { n: -0 })).toBe(
        computeRequestFingerprint('OP', { n: 0 }),
      );
    });

    it('is the same for equal requests built separately', () => {
      expect(
        computeRequestFingerprint(OPERATION, structuredClone(REQUEST)),
      ).toBe(base);
    });
  });

  describe('rejected values', () => {
    // Each value is outside FingerprintValue, so the type system rejects it too;
    // the casts model a payload that reached the function as `unknown`.
    const reject = (request: unknown) => () =>
      computeRequestFingerprint('OP', request as FingerprintValue);

    it.each<{ name: string; request: unknown; path: string }>([
      { name: 'undefined', request: undefined, path: '$[1]' },
      { name: 'an undefined field', request: { a: undefined }, path: '$[1].a' },
      { name: 'a function', request: { a: () => 1 }, path: '$[1].a' },
      { name: 'a bigint', request: { amount: 10000n }, path: '$[1].amount' },
      { name: 'a symbol', request: { a: Symbol('x') }, path: '$[1].a' },
      { name: 'NaN', request: { a: Number.NaN }, path: '$[1].a' },
      { name: 'Infinity', request: { a: Infinity }, path: '$[1].a' },
      { name: '-Infinity', request: [1, -Infinity], path: '$[1][1]' },
      { name: 'a Date', request: { at: new Date(0) }, path: '$[1].at' },
      { name: 'a Map', request: { m: new Map() }, path: '$[1].m' },
      {
        name: 'a class instance',
        request: { c: new (class Point {})() },
        path: '$[1].c',
      },
      {
        name: 'a boxed string',
        request: { s: new String('x') },
        path: '$[1].s',
      },
      {
        name: 'a hole in a sparse array',
        // eslint-disable-next-line no-sparse-arrays -- the hole is the case under test
        request: { list: [1, , 3] },
        path: '$[1].list[1]',
      },
      {
        name: 'a nested bigint',
        request: { a: [{ b: { c: 1n } }] },
        path: '$[1].a[0].b.c',
      },
    ])('rejects $name with its path', ({ request, path }) => {
      expect(reject(request)).toThrow(TypeError);
      expect(reject(request)).toThrow(path);
    });

    it('rejects an object with symbol keys', () => {
      expect(reject({ a: 1, [Symbol('hidden')]: 2 })).toThrow(
        '$[1] has symbol keys',
      );
    });

    it('rejects a cycle', () => {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;

      expect(reject(cyclic)).toThrow(
        '$[1].self refers to one of its ancestors',
      );
    });

    it('accepts the same object twice when it is not its own ancestor', () => {
      const shared = { a: 1 };

      expect(computeRequestFingerprint('OP', { x: shared, y: shared })).toBe(
        computeRequestFingerprint('OP', { x: { a: 1 }, y: { a: 1 } }),
      );
    });

    it('accepts an amount converted to its integer string', () => {
      const amount = 9_223_372_036_854_775_807n;

      expect(
        computeRequestFingerprint('OP', { amount_minor: amount.toString() }),
      ).toBe(
        computeRequestFingerprint('OP', {
          amount_minor: '9223372036854775807',
        }),
      );
    });
  });
});
