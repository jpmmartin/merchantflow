import { describe, expect, it } from 'vitest';
import { describeDatabaseFailure } from './describe-failure.js';

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('describeDatabaseFailure', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', '57P01', '28P01'])(
    'returns the code %s',
    (code) => {
      expect(describeDatabaseFailure(withCode('failed', code))).toBe(code);
    },
  );

  it.each([
    'timeout exceeded when trying to connect',
    'Connection terminated due to connection timeout',
    'Query read timeout',
    'The operation timed out',
  ])('labels the message %j as a timeout', (message) => {
    expect(describeDatabaseFailure(new Error(message))).toBe('TIMEOUT');
  });

  it.each([
    ['a plain error', new Error('Connection terminated unexpectedly')],
    ['a string', 'postgres://user:secret@db.internal:5432/payments'],
    ['undefined', undefined],
    ['a number', 42],
  ])('labels %s as unknown', (_label, value) => {
    expect(describeDatabaseFailure(value)).toBe('UNKNOWN');
  });

  it('ignores a code that is not shaped like an error code', () => {
    const error = withCode('failed', 'postgres://user:secret@db.internal/x');

    expect(describeDatabaseFailure(error)).toBe('UNKNOWN');
  });

  it('never returns the message, which can carry connection details', () => {
    const message =
      'connect ECONNREFUSED 10.1.2.3:5432 for user payments_rw on database ledger';

    expect(describeDatabaseFailure(new Error(message))).toBe('UNKNOWN');
    expect(describeDatabaseFailure(withCode(message, 'ECONNREFUSED'))).toBe(
      'ECONNREFUSED',
    );
  });
});
