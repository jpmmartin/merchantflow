import { describe, expect, it } from 'vitest';
import {
  PAYMENT_INTENT_STATUSES,
  type PaymentIntentStatus,
} from './payment-intent.js';
import {
  MAX_UNSUCCESSFUL_ATTEMPTS,
  evaluatePaymentIntentTransition,
  type PaymentIntentTransitionFailure,
  type PaymentIntentTransitionResult,
} from './payment-intent-transition.js';

/**
 * What the policy must answer for a pair of statuses, written independently of
 * the implementation:
 * - ALLOWED: succeeds whatever the attempt count.
 * - RETRY: succeeds below the attempt limit only (back to CREATED).
 * - EXHAUSTED: succeeds at the attempt limit only (to FAILED).
 * - SAME / TERMINAL / NOT_ALLOWED: always fails with that code.
 * The record type makes a new status a compile error until its row is added.
 */
type Expectation =
  'ALLOWED' | 'RETRY' | 'EXHAUSTED' | 'SAME' | 'TERMINAL' | 'NOT_ALLOWED';

const EXPECTED: Readonly<
  Record<
    PaymentIntentStatus,
    Readonly<Record<PaymentIntentStatus, Expectation>>
  >
> = {
  CREATED: {
    CREATED: 'SAME',
    PROCESSING: 'ALLOWED',
    SUCCEEDED: 'NOT_ALLOWED',
    FAILED: 'NOT_ALLOWED',
    UNKNOWN: 'NOT_ALLOWED',
    REQUIRES_ACTION: 'NOT_ALLOWED',
    PARTIALLY_REFUNDED: 'NOT_ALLOWED',
    REFUNDED: 'NOT_ALLOWED',
  },
  PROCESSING: {
    CREATED: 'RETRY',
    PROCESSING: 'SAME',
    SUCCEEDED: 'ALLOWED',
    FAILED: 'EXHAUSTED',
    UNKNOWN: 'ALLOWED',
    REQUIRES_ACTION: 'ALLOWED',
    PARTIALLY_REFUNDED: 'NOT_ALLOWED',
    REFUNDED: 'NOT_ALLOWED',
  },
  SUCCEEDED: {
    CREATED: 'TERMINAL',
    PROCESSING: 'TERMINAL',
    SUCCEEDED: 'SAME',
    FAILED: 'TERMINAL',
    UNKNOWN: 'TERMINAL',
    REQUIRES_ACTION: 'TERMINAL',
    PARTIALLY_REFUNDED: 'ALLOWED',
    REFUNDED: 'ALLOWED',
  },
  FAILED: {
    CREATED: 'TERMINAL',
    PROCESSING: 'TERMINAL',
    SUCCEEDED: 'TERMINAL',
    FAILED: 'SAME',
    UNKNOWN: 'TERMINAL',
    REQUIRES_ACTION: 'TERMINAL',
    PARTIALLY_REFUNDED: 'TERMINAL',
    REFUNDED: 'TERMINAL',
  },
  UNKNOWN: {
    CREATED: 'RETRY',
    PROCESSING: 'NOT_ALLOWED',
    SUCCEEDED: 'ALLOWED',
    FAILED: 'EXHAUSTED',
    UNKNOWN: 'SAME',
    REQUIRES_ACTION: 'NOT_ALLOWED',
    PARTIALLY_REFUNDED: 'NOT_ALLOWED',
    REFUNDED: 'NOT_ALLOWED',
  },
  REQUIRES_ACTION: {
    CREATED: 'RETRY',
    PROCESSING: 'NOT_ALLOWED',
    SUCCEEDED: 'ALLOWED',
    FAILED: 'EXHAUSTED',
    UNKNOWN: 'ALLOWED',
    REQUIRES_ACTION: 'SAME',
    PARTIALLY_REFUNDED: 'NOT_ALLOWED',
    REFUNDED: 'NOT_ALLOWED',
  },
  PARTIALLY_REFUNDED: {
    CREATED: 'TERMINAL',
    PROCESSING: 'TERMINAL',
    SUCCEEDED: 'TERMINAL',
    FAILED: 'TERMINAL',
    UNKNOWN: 'TERMINAL',
    REQUIRES_ACTION: 'TERMINAL',
    PARTIALLY_REFUNDED: 'ALLOWED',
    REFUNDED: 'ALLOWED',
  },
  REFUNDED: {
    CREATED: 'TERMINAL',
    PROCESSING: 'TERMINAL',
    SUCCEEDED: 'TERMINAL',
    FAILED: 'TERMINAL',
    UNKNOWN: 'TERMINAL',
    REQUIRES_ACTION: 'TERMINAL',
    PARTIALLY_REFUNDED: 'TERMINAL',
    REFUNDED: 'SAME',
  },
};

type Pair = {
  readonly from: PaymentIntentStatus;
  readonly to: PaymentIntentStatus;
};

const ALL_PAIRS: readonly Pair[] = PAYMENT_INTENT_STATUSES.flatMap((from) =>
  PAYMENT_INTENT_STATUSES.map((to) => ({ from, to })),
);

function expectedOf({ from, to }: Pair): Expectation | undefined {
  const row: Partial<Record<PaymentIntentStatus, Expectation>> | undefined =
    EXPECTED[from];
  return row?.[to];
}

function pairsExpecting(...expectations: Expectation[]): readonly Pair[] {
  return ALL_PAIRS.filter((pair) => {
    const expected = expectedOf(pair);
    return expected !== undefined && expectations.includes(expected);
  });
}

const FAILURE_CODE: Readonly<
  Record<
    'SAME' | 'TERMINAL' | 'NOT_ALLOWED',
    PaymentIntentTransitionFailure['code']
  >
> = {
  SAME: 'SAME_STATUS',
  TERMINAL: 'TERMINAL_STATUS',
  NOT_ALLOWED: 'TRANSITION_NOT_ALLOWED',
};

const COUNTS_BELOW_LIMIT = [1, 2] as const;
const COUNTS_AT_OR_ABOVE_LIMIT = [3, 4, 100] as const;
const INVALID_COUNTS: readonly (number | undefined)[] = [
  undefined,
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

describe('attempt limit', () => {
  it('is three unsuccessful attempts', () => {
    expect(MAX_UNSUCCESSFUL_ATTEMPTS).toBe(3);
  });
});

describe('transition table', () => {
  it('has an expectation for every ordered pair of statuses', () => {
    const missing = ALL_PAIRS.filter((pair) => expectedOf(pair) === undefined);
    expect(missing).toEqual([]);
    expect(ALL_PAIRS).toHaveLength(
      PAYMENT_INTENT_STATUSES.length * PAYMENT_INTENT_STATUSES.length,
    );
  });

  it('allows exactly the documented transitions', () => {
    const allowed = pairsExpecting('ALLOWED', 'RETRY', 'EXHAUSTED').map(
      ({ from, to }) => `${from}->${to}`,
    );
    expect(allowed.sort()).toEqual(
      [
        'CREATED->PROCESSING',
        'PROCESSING->SUCCEEDED',
        'PROCESSING->UNKNOWN',
        'PROCESSING->CREATED',
        'PROCESSING->FAILED',
        'UNKNOWN->SUCCEEDED',
        'UNKNOWN->CREATED',
        'UNKNOWN->FAILED',
        'PROCESSING->REQUIRES_ACTION',
        'REQUIRES_ACTION->SUCCEEDED',
        'REQUIRES_ACTION->CREATED',
        'REQUIRES_ACTION->FAILED',
        'REQUIRES_ACTION->UNKNOWN',
        'SUCCEEDED->PARTIALLY_REFUNDED',
        'SUCCEEDED->REFUNDED',
        'PARTIALLY_REFUNDED->PARTIALLY_REFUNDED',
        'PARTIALLY_REFUNDED->REFUNDED',
      ].sort(),
    );
  });

  describe('transitions without a guard', () => {
    it.each(pairsExpecting('ALLOWED'))(
      'allows $from to $to whatever the attempt count',
      ({ from, to }) => {
        for (const unsuccessfulAttempts of [undefined, 1, 2, 3, 4]) {
          const context =
            unsuccessfulAttempts === undefined ? {} : { unsuccessfulAttempts };
          expect(evaluatePaymentIntentTransition(from, to, context)).toEqual({
            ok: true,
            from,
            to,
          });
        }
      },
    );
  });

  describe('transitions back to CREATED', () => {
    it.each(pairsExpecting('RETRY'))(
      'allows $from to $to below the attempt limit',
      ({ from, to }) => {
        for (const unsuccessfulAttempts of COUNTS_BELOW_LIMIT) {
          expect(
            evaluatePaymentIntentTransition(from, to, { unsuccessfulAttempts }),
          ).toEqual({ ok: true, from, to });
        }
      },
    );

    it.each(pairsExpecting('RETRY'))(
      'rejects $from to $to at or above the attempt limit',
      ({ from, to }) => {
        for (const unsuccessfulAttempts of COUNTS_AT_OR_ABOVE_LIMIT) {
          expect(
            evaluatePaymentIntentTransition(from, to, { unsuccessfulAttempts }),
          ).toEqual({ ok: false, code: 'ATTEMPT_LIMIT_REACHED', from, to });
        }
      },
    );
  });

  describe('transitions to FAILED', () => {
    it.each(pairsExpecting('EXHAUSTED'))(
      'allows $from to $to at or above the attempt limit',
      ({ from, to }) => {
        for (const unsuccessfulAttempts of COUNTS_AT_OR_ABOVE_LIMIT) {
          expect(
            evaluatePaymentIntentTransition(from, to, { unsuccessfulAttempts }),
          ).toEqual({ ok: true, from, to });
        }
      },
    );

    it.each(pairsExpecting('EXHAUSTED'))(
      'rejects $from to $to below the attempt limit',
      ({ from, to }) => {
        for (const unsuccessfulAttempts of COUNTS_BELOW_LIMIT) {
          expect(
            evaluatePaymentIntentTransition(from, to, { unsuccessfulAttempts }),
          ).toEqual({ ok: false, code: 'ATTEMPT_LIMIT_NOT_REACHED', from, to });
        }
      },
    );
  });

  describe('guarded transitions with an unusable attempt count', () => {
    it.each(pairsExpecting('RETRY', 'EXHAUSTED'))(
      'rejects $from to $to without a whole count of at least one',
      ({ from, to }) => {
        for (const unsuccessfulAttempts of INVALID_COUNTS) {
          const context =
            unsuccessfulAttempts === undefined ? {} : { unsuccessfulAttempts };
          expect(evaluatePaymentIntentTransition(from, to, context)).toEqual({
            ok: false,
            code: 'INVALID_ATTEMPT_COUNT',
            from,
            to,
          });
        }
      },
    );
  });

  describe('rejected pairs', () => {
    it.each(pairsExpecting('SAME', 'TERMINAL', 'NOT_ALLOWED'))(
      'rejects $from to $to with a typed failure whatever the attempt count',
      ({ from, to }) => {
        const kind = EXPECTED[from][to] as 'SAME' | 'TERMINAL' | 'NOT_ALLOWED';
        for (const unsuccessfulAttempts of [undefined, 1, 2, 3]) {
          const context =
            unsuccessfulAttempts === undefined ? {} : { unsuccessfulAttempts };
          expect(evaluatePaymentIntentTransition(from, to, context)).toEqual({
            ok: false,
            code: FAILURE_CODE[kind],
            from,
            to,
          });
        }
      },
    );
  });

  describe('terminal statuses', () => {
    it.each(['SUCCEEDED', 'FAILED'] as const)(
      '%s allows no transition to a status of the payment lifecycle',
      (from) => {
        for (const to of PAYMENT_INTENT_STATUSES.filter(
          (status) => status !== 'PARTIALLY_REFUNDED' && status !== 'REFUNDED',
        )) {
          for (const unsuccessfulAttempts of [1, 2, 3]) {
            expect(
              evaluatePaymentIntentTransition(from, to, {
                unsuccessfulAttempts,
              }).ok,
            ).toBe(false);
          }
        }
      },
    );

    it('keeps SUCCEEDED and FAILED terminal even at the attempt limit', () => {
      expect(
        evaluatePaymentIntentTransition('SUCCEEDED', 'FAILED', {
          unsuccessfulAttempts: 3,
        }),
      ).toEqual({
        ok: false,
        code: 'TERMINAL_STATUS',
        from: 'SUCCEEDED',
        to: 'FAILED',
      });
      expect(
        evaluatePaymentIntentTransition('FAILED', 'CREATED', {
          unsuccessfulAttempts: 1,
        }),
      ).toEqual({
        ok: false,
        code: 'TERMINAL_STATUS',
        from: 'FAILED',
        to: 'CREATED',
      });
    });
  });

  describe('attempt limit', () => {
    it('returns the intent to CREATED after the second unsuccessful attempt', () => {
      expect(
        evaluatePaymentIntentTransition('PROCESSING', 'CREATED', {
          unsuccessfulAttempts: 2,
        }).ok,
      ).toBe(true);
      expect(
        evaluatePaymentIntentTransition('PROCESSING', 'FAILED', {
          unsuccessfulAttempts: 2,
        }),
      ).toMatchObject({ ok: false, code: 'ATTEMPT_LIMIT_NOT_REACHED' });
    });

    it('fails the intent at the third unsuccessful attempt', () => {
      expect(
        evaluatePaymentIntentTransition('PROCESSING', 'FAILED', {
          unsuccessfulAttempts: 3,
        }).ok,
      ).toBe(true);
      expect(
        evaluatePaymentIntentTransition('PROCESSING', 'CREATED', {
          unsuccessfulAttempts: 3,
        }),
      ).toMatchObject({ ok: false, code: 'ATTEMPT_LIMIT_REACHED' });
    });
  });

  describe('exits from UNKNOWN', () => {
    it('allows SUCCEEDED once the provider confirms the charge', () => {
      expect(evaluatePaymentIntentTransition('UNKNOWN', 'SUCCEEDED')).toEqual({
        ok: true,
        from: 'UNKNOWN',
        to: 'SUCCEEDED',
      });
    });

    it('allows CREATED when non-execution is proven and retries remain', () => {
      for (const unsuccessfulAttempts of [1, 2]) {
        expect(
          evaluatePaymentIntentTransition('UNKNOWN', 'CREATED', {
            unsuccessfulAttempts,
          }).ok,
        ).toBe(true);
      }
    });

    it('allows FAILED when non-execution is proven at the attempt limit', () => {
      expect(
        evaluatePaymentIntentTransition('UNKNOWN', 'FAILED', {
          unsuccessfulAttempts: 3,
        }).ok,
      ).toBe(true);
    });

    it('does not allow PROCESSING, so a new attempt cannot start from UNKNOWN', () => {
      expect(evaluatePaymentIntentTransition('UNKNOWN', 'PROCESSING')).toEqual({
        ok: false,
        code: 'TRANSITION_NOT_ALLOWED',
        from: 'UNKNOWN',
        to: 'PROCESSING',
      });
    });

    it('treats an inconclusive lookup (staying UNKNOWN) as a rejected same-status move', () => {
      expect(evaluatePaymentIntentTransition('UNKNOWN', 'UNKNOWN')).toEqual({
        ok: false,
        code: 'SAME_STATUS',
        from: 'UNKNOWN',
        to: 'UNKNOWN',
      });
    });

    it('never reaches UNKNOWN from CREATED, since an outcome is uncertain only after a reservation', () => {
      expect(
        evaluatePaymentIntentTransition('CREATED', 'UNKNOWN'),
      ).toMatchObject({ ok: false, code: 'TRANSITION_NOT_ALLOWED' });
    });
  });

  it('rejects an inherited property name used as a target at run time', () => {
    const to = 'constructor' as unknown as PaymentIntentStatus;
    expect(evaluatePaymentIntentTransition('CREATED', to)).toEqual({
      ok: false,
      code: 'TRANSITION_NOT_ALLOWED',
      from: 'CREATED',
      to,
    });
  });
});

describe('PaymentIntentTransitionResult', () => {
  it('can be handled exhaustively', () => {
    const describeResult = (result: PaymentIntentTransitionResult): string => {
      if (result.ok) return 'allowed';
      switch (result.code) {
        case 'SAME_STATUS':
          return 'same';
        case 'TERMINAL_STATUS':
          return 'terminal';
        case 'TRANSITION_NOT_ALLOWED':
          return 'not allowed';
        case 'INVALID_ATTEMPT_COUNT':
          return 'invalid count';
        case 'ATTEMPT_LIMIT_REACHED':
          return 'limit reached';
        case 'ATTEMPT_LIMIT_NOT_REACHED':
          return 'limit not reached';
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    };
    expect(
      describeResult(evaluatePaymentIntentTransition('CREATED', 'PROCESSING')),
    ).toBe('allowed');
    expect(
      describeResult(evaluatePaymentIntentTransition('FAILED', 'CREATED')),
    ).toBe('terminal');
  });
});
