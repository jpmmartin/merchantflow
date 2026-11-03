import { describe, expect, it } from 'vitest';
import type { DatabaseTransaction } from './schema.js';
import { isLockNotAvailable, setLocalLockTimeout } from './lock-timeout.js';

function withCode(code: unknown): Error {
  return Object.assign(new Error('failed'), { code });
}

describe('isLockNotAvailable', () => {
  it('matches the SQLSTATE of lock_not_available', () => {
    expect(isLockNotAvailable(withCode('55P03'))).toBe(true);
  });

  it.each([
    ['a statement timeout', withCode('57014')],
    ['a deadlock', withCode('40P01')],
    ['a unique violation', withCode('23505')],
    ['a client timeout', new Error('Query read timeout')],
    ['a code that is not a string', withCode(55)],
    ['a string', '55P03'],
    ['null', null],
    ['undefined', undefined],
  ])('does not match %s', (_label, error) => {
    expect(isLockNotAvailable(error)).toBe(false);
  });
});

describe('setLocalLockTimeout', () => {
  // The value is checked before any statement is built, so no transaction is
  // needed to reach the check.
  const noTransaction = {} as DatabaseTransaction;

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'refuses %s milliseconds',
    async (milliseconds) => {
      await expect(
        setLocalLockTimeout(noTransaction, milliseconds),
      ).rejects.toThrow(RangeError);
    },
  );
});
