import type { MerchantStatus } from './merchant.js';

export type MerchantTransitionFailure =
  | {
      readonly ok: false;
      readonly code: 'SAME_STATUS';
      readonly from: MerchantStatus;
      readonly to: MerchantStatus;
    }
  | {
      readonly ok: false;
      readonly code: 'TRANSITION_NOT_ALLOWED';
      readonly from: MerchantStatus;
      readonly to: MerchantStatus;
    };

export type MerchantTransitionResult =
  | {
      readonly ok: true;
      readonly from: MerchantStatus;
      readonly to: MerchantStatus;
    }
  | MerchantTransitionFailure;

const ALLOWED_TARGETS: Readonly<
  Record<MerchantStatus, readonly MerchantStatus[]>
> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['SUSPENDED'],
  SUSPENDED: ['ACTIVE'],
};

/**
 * Decides whether a merchant may move from one status to another. It checks
 * the lifecycle only; which role may request the change is not decided here.
 */
export function evaluateMerchantTransition(
  from: MerchantStatus,
  to: MerchantStatus,
): MerchantTransitionResult {
  if (from === to) {
    return { ok: false, code: 'SAME_STATUS', from, to };
  }
  if (!ALLOWED_TARGETS[from].includes(to)) {
    return { ok: false, code: 'TRANSITION_NOT_ALLOWED', from, to };
  }
  return { ok: true, from, to };
}
