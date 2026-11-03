import { types } from 'pg';
import { describe, expect, it } from 'vitest';
import { bigintTypes, getTypeParserWithBigint } from './bigint-types.js';

const INT8 = 20;
const INT4 = 23;
const NUMERIC = 1700;
const TEXT = 25;
const MAX_BIGINT = '9223372036854775807';

// `pg-types` declares its parsers as returning `any`.
function pgParser(oid: number, format: 'text' | 'binary'): unknown {
  return types.getTypeParser(oid, format);
}

describe('getTypeParserWithBigint', () => {
  it('parses int8 text into an exact bigint above Number.MAX_SAFE_INTEGER', () => {
    const parse = getTypeParserWithBigint(INT8, 'text');

    expect(parse(MAX_BIGINT)).toBe(9223372036854775807n);
    expect(parse('9007199254740993')).toBe(9007199254740993n);
    expect(parse('-9223372036854775808')).toBe(-9223372036854775808n);
  });

  it('parses int8 text into a bigint when no format is given', () => {
    expect(getTypeParserWithBigint(INT8)('42')).toBe(42n);
  });

  it('leaves the parsers of every other type to pg', () => {
    expect(getTypeParserWithBigint(INT4, 'text')('42')).toBe(42);
    expect(getTypeParserWithBigint(TEXT, 'text')('42')).toBe('42');
    expect(getTypeParserWithBigint(NUMERIC, 'text')(MAX_BIGINT)).toBe(
      MAX_BIGINT,
    );
  });

  it('leaves the binary format of int8 to pg', () => {
    expect(getTypeParserWithBigint(INT8, 'binary')).toBe(
      pgParser(INT8, 'binary'),
    );
  });

  it('does not change the parser that pg uses by default', () => {
    const globalParse = pgParser(INT8, 'text') as (value: string) => unknown;

    expect(globalParse(MAX_BIGINT)).toBe(MAX_BIGINT);
    expect(typeof globalParse(MAX_BIGINT)).toBe('string');
  });
});

describe('bigintTypes', () => {
  it('exposes the same parser selection to the pool', () => {
    expect(bigintTypes.getTypeParser).toBe(getTypeParserWithBigint);
  });
});
