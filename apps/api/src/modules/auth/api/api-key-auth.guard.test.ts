import { describe, expect, it } from 'vitest';
import { readBearerToken } from './api-key-auth.guard.js';

describe('readBearerToken', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['BEARER abc', 'abc'],
    ['Bearer abc def', 'abc def'],
  ])('reads the token of %j', (header, token) => {
    expect(readBearerToken(header)).toBe(token);
  });

  it.each([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['a scheme alone', 'Bearer'],
    ['a scheme and an empty token', 'Bearer '],
    ['another scheme', 'Basic abc'],
    ['a scheme that only starts with Bearer', 'Bearerx abc'],
    ['a leading space', ' Bearer abc'],
    ['a token with no scheme', 'abc'],
    ['a repeated header', ['Bearer a', 'Bearer b']],
  ])('returns nothing for %s', (_name, header) => {
    expect(readBearerToken(header)).toBeUndefined();
  });

  it('does not trim the token, so the key parser sees exactly what was sent', () => {
    expect(readBearerToken('Bearer abc ')).toBe('abc ');
  });
});
