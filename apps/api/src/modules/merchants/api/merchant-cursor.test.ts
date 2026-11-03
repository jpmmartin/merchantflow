import { describe, expect, it } from 'vitest';
import {
  decodeMerchantCursor,
  encodeMerchantCursor,
} from './merchant-cursor.js';

const ID = '4c1f6a52-7d0e-4f0a-9d53-2f2b6a1c9e10';
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('merchant list cursor', () => {
  it('round-trips a position', () => {
    const position = {
      createdAt: new Date('2026-11-03T12:00:00.123Z'),
      id: ID,
    };

    expect(decodeMerchantCursor(encodeMerchantCursor(position))).toEqual(
      position,
    );
  });

  it('uses only characters that are safe in a URL', () => {
    const cursor = encodeMerchantCursor({ createdAt: new Date(0), id: ID });

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not show the position in clear text', () => {
    const cursor = encodeMerchantCursor({ createdAt: new Date(0), id: ID });

    expect(cursor).not.toContain(ID);
  });

  it.each([
    ['empty text', ''],
    ['characters outside the alphabet', 'a b'],
    ['padding', `${encode({ c: '2026-11-03T12:00:00.000Z', i: ID })}==`],
    ['text that is not JSON', Buffer.from('nope').toString('base64url')],
    ['null', encode(null)],
    ['an array', encode([])],
    ['a missing time', encode({ i: ID })],
    ['a missing id', encode({ c: '2026-11-03T12:00:00.000Z' })],
    [
      'an id that is not a UUID',
      encode({ c: '2026-11-03T12:00:00.000Z', i: 'x' }),
    ],
    [
      'a time without milliseconds',
      encode({ c: '2026-11-03T12:00:00Z', i: ID }),
    ],
    [
      'a time with microseconds',
      encode({ c: '2026-11-03T12:00:00.123456Z', i: ID }),
    ],
    [
      'a time with an offset',
      encode({ c: '2026-11-03T12:00:00.000+01:00', i: ID }),
    ],
    ['a time that is not a date', encode({ c: 'soon', i: ID })],
    ['a numeric time', encode({ c: 1_762_171_200_000, i: ID })],
  ])('rejects %s', (_name, value) => {
    expect(decodeMerchantCursor(value)).toBeUndefined();
  });

  it('ignores fields it did not write', () => {
    const position = decodeMerchantCursor(
      encode({ c: '2026-11-03T12:00:00.000Z', i: ID, extra: true }),
    );

    expect(position).toEqual({
      createdAt: new Date('2026-11-03T12:00:00.000Z'),
      id: ID,
    });
  });
});
