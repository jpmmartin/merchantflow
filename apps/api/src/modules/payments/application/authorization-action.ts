import type { PositiveMoney } from '@merchantflow/domain';
import {
  matchAuthorizationActionResult,
  type ProcessorAuthorizationActionResult,
  type ProcessorErrorCategory,
  type ProcessorPaymentResult,
} from '@merchantflow/processor-contracts';

/**
 * What an action does to the hold of a `MANUAL` intent: `CAPTURE` takes the
 * held funds, and `VOID` releases them with nothing captured.
 */
export const AUTHORIZATION_ACTION_KINDS = ['CAPTURE', 'VOID'] as const;

export type AuthorizationActionKind =
  (typeof AUTHORIZATION_ACTION_KINDS)[number];

/**
 * Lifecycle statuses of a capture or void. `EXECUTING` is set before the
 * provider is called; `UNKNOWN` means the outcome could not be established;
 * `SUCCEEDED` and `FAILED` are final. While an action is `EXECUTING`,
 * `UNKNOWN`, or `SUCCEEDED`, no other action of its intent can start.
 */
export const AUTHORIZATION_ACTION_STATUSES = [
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
] as const;

export type AuthorizationActionStatus =
  (typeof AUTHORIZATION_ACTION_STATUSES)[number];

/** A capture or void of a hold. Timestamps come from the injected clock. */
export interface AuthorizationAction {
  readonly id: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  /** The authorized attempt whose hold is captured or voided. */
  readonly paymentAttemptId: string;
  /** The account of that attempt, the only one that can act on the hold. */
  readonly processorAccountId: string;
  readonly action: AuthorizationActionKind;
  /** The provider idempotency key of the action, created before the call. */
  readonly operationId: string;
  /** The idempotency record of the request that started the action. */
  readonly idempotencyRecordId: string;
  /** The amount captured or released: always the intent's whole amount. */
  readonly amount: PositiveMoney;
  readonly status: AuthorizationActionStatus;
  readonly failureCode: string | null;
  readonly errorCategory: ProcessorErrorCategory | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What a provider result means for an action row. */
export type AuthorizationActionResolution =
  | {
      readonly status: 'SUCCEEDED';
      readonly failureCode: null;
      readonly errorCategory: null;
    }
  | {
      readonly status: 'FAILED';
      readonly failureCode: string | null;
      readonly errorCategory: ProcessorErrorCategory;
    }
  | {
      readonly status: 'UNKNOWN';
      readonly failureCode: null;
      readonly errorCategory: ProcessorErrorCategory;
    };

/**
 * Translates the normalized result of a capture or void call into the change
 * of the action. An unknown result is never read as a failure.
 */
export function authorizationActionResolutionOf(
  result: ProcessorAuthorizationActionResult,
): AuthorizationActionResolution {
  return matchAuthorizationActionResult<AuthorizationActionResolution>(result, {
    succeeded: () => ({
      status: 'SUCCEEDED',
      failureCode: null,
      errorCategory: null,
    }),
    failed: (r) => ({
      status: 'FAILED',
      failureCode: r.failureCode,
      errorCategory: r.category,
    }),
    unknown: (r) => ({
      status: 'UNKNOWN',
      failureCode: null,
      errorCategory: r.category,
    }),
  });
}

/**
 * The failure code of an action whose request never took effect at the
 * provider: a later lookup found the payment still holding its funds.
 */
export const NOT_EXECUTED_FAILURE_CODE = 'not_executed';

/**
 * The failure code of an action that cannot take effect any more because the
 * provider's payment is in a state it cannot leave: canceled for a capture,
 * captured for a void.
 */
export const PAYMENT_ALREADY_FINAL_FAILURE_CODE = 'payment_already_final';

/**
 * What a provider lookup of the payment, made after an `UNKNOWN` action's
 * request ended, proves about that action, or `undefined` when it proves
 * nothing and the action stays `UNKNOWN`:
 *
 * - the state the action leads to (`succeeded` for a capture, `canceled` for a
 *   void): the action took effect, `SUCCEEDED`;
 * - `authorized`: the payment still holds its funds, so the request, whose
 *   tries had all ended, never took effect: `FAILED` (`not_executed`), and a
 *   new capture or void may be requested;
 * - the other final state (`canceled` for a capture, `succeeded` for a void):
 *   the action can never take effect: `FAILED` (`payment_already_final`). The
 *   payment changed outside the platform, which this does not apply;
 * - anything else (requires action, declined, unknown): nothing is proven.
 */
export function authorizationActionResolutionFromLookup(
  action: AuthorizationActionKind,
  result: ProcessorPaymentResult,
): AuthorizationActionResolution | undefined {
  const reached = action === 'CAPTURE' ? 'succeeded' : 'canceled';
  const closed = action === 'CAPTURE' ? 'canceled' : 'succeeded';
  if (result.status === reached) {
    return { status: 'SUCCEEDED', failureCode: null, errorCategory: null };
  }
  if (result.status === 'authorized') {
    return {
      status: 'FAILED',
      failureCode: NOT_EXECUTED_FAILURE_CODE,
      errorCategory: 'UNKNOWN',
    };
  }
  if (result.status === closed) {
    return {
      status: 'FAILED',
      failureCode: PAYMENT_ALREADY_FINAL_FAILURE_CODE,
      errorCategory: 'INVALID_REQUEST',
    };
  }
  return undefined;
}
