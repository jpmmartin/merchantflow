import { describe, expect, it } from 'vitest';
import { MERCHANT_STATUSES, type MerchantStatus } from './merchant.js';
import {
  evaluateMerchantTransition,
  type MerchantTransitionResult,
} from './merchant-transition.js';

describe('evaluateMerchantTransition', () => {
  it.each<[MerchantStatus, MerchantStatus]>([
    ['DRAFT', 'ACTIVE'],
    ['ACTIVE', 'SUSPENDED'],
    ['SUSPENDED', 'ACTIVE'],
  ])('allows %s to %s', (from, to) => {
    expect(evaluateMerchantTransition(from, to)).toEqual({
      ok: true,
      from,
      to,
    });
  });

  it.each<[MerchantStatus, MerchantStatus]>([
    ['DRAFT', 'DRAFT'],
    ['ACTIVE', 'ACTIVE'],
    ['SUSPENDED', 'SUSPENDED'],
  ])('rejects staying in %s', (from, to) => {
    expect(evaluateMerchantTransition(from, to)).toEqual({
      ok: false,
      code: 'SAME_STATUS',
      from,
      to,
    });
  });

  it.each<[MerchantStatus, MerchantStatus]>([
    ['DRAFT', 'SUSPENDED'],
    ['ACTIVE', 'DRAFT'],
    ['SUSPENDED', 'DRAFT'],
  ])('rejects %s to %s', (from, to) => {
    expect(evaluateMerchantTransition(from, to)).toEqual({
      ok: false,
      code: 'TRANSITION_NOT_ALLOWED',
      from,
      to,
    });
  });

  it('covers all nine status pairs with exactly three successes', () => {
    const results = MERCHANT_STATUSES.flatMap((from) =>
      MERCHANT_STATUSES.map((to) => evaluateMerchantTransition(from, to)),
    );
    expect(results).toHaveLength(9);
    expect(results.filter((result) => result.ok)).toHaveLength(3);
  });

  it('can be handled exhaustively', () => {
    const describeResult = (result: MerchantTransitionResult): string => {
      if (result.ok) return 'allowed';
      switch (result.code) {
        case 'SAME_STATUS':
          return 'same';
        case 'TRANSITION_NOT_ALLOWED':
          return 'not allowed';
        default: {
          const unreachable: never = result;
          return unreachable;
        }
      }
    };
    expect(describeResult(evaluateMerchantTransition('DRAFT', 'ACTIVE'))).toBe(
      'allowed',
    );
  });
});
