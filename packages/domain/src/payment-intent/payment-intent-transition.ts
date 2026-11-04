import type { PaymentIntentStatus } from './payment-intent.js';

/**
 * The number of unsuccessful attempts after which an intent becomes `FAILED`.
 * The count includes the attempt that has just ended unsuccessfully, so the
 * first and second unsuccessful attempts leave the intent retryable and the
 * third one fails it.
 */
export const MAX_UNSUCCESSFUL_ATTEMPTS = 3;

type TransitionFailure<Code extends string> = {
  readonly ok: false;
  readonly code: Code;
  readonly from: PaymentIntentStatus;
  readonly to: PaymentIntentStatus;
};

export type PaymentIntentTransitionFailure =
  | TransitionFailure<'SAME_STATUS'>
  | TransitionFailure<'TERMINAL_STATUS'>
  | TransitionFailure<'TRANSITION_NOT_ALLOWED'>
  | TransitionFailure<'INVALID_ATTEMPT_COUNT'>
  | TransitionFailure<'ATTEMPT_LIMIT_REACHED'>
  | TransitionFailure<'ATTEMPT_LIMIT_NOT_REACHED'>;

export type PaymentIntentTransitionResult =
  | {
      readonly ok: true;
      readonly from: PaymentIntentStatus;
      readonly to: PaymentIntentStatus;
    }
  | PaymentIntentTransitionFailure;

export interface PaymentIntentTransitionContext {
  /**
   * How many attempts of the intent have ended unsuccessfully, counting the
   * one that triggers the transition. Required, as a whole number of at least
   * one, for the transitions to `CREATED` and `FAILED`; ignored by the rest.
   */
  readonly unsuccessfulAttempts?: number;
}

/**
 * When a listed transition applies: always, only while the attempt limit has
 * not been reached (the intent stays retryable), or only once it has been
 * reached (the intent fails).
 */
type TransitionGuard = 'ALWAYS' | 'RETRY_AVAILABLE' | 'ATTEMPTS_EXHAUSTED';

/**
 * The transition table: the targets each status may move to, and the guard of
 * each. A status without targets is terminal. Statuses missing from this
 * record fail to compile, so a new status needs a row here.
 *
 * - Reserve: `CREATED` to `PROCESSING`.
 * - Success: `PROCESSING`, `REQUIRES_ACTION`, or `UNKNOWN` to `SUCCEEDED`.
 * - Customer action needed, such as 3D Secure: `PROCESSING` to
 *   `REQUIRES_ACTION`.
 * - Timeout or ambiguous outcome: `PROCESSING` or `REQUIRES_ACTION` to
 *   `UNKNOWN`.
 * - Decline, failed authentication, or proven non-execution: back to `CREATED`
 *   while retries remain, `FAILED` at the third unsuccessful attempt. From
 *   `UNKNOWN` this is the resolution once non-execution is proven.
 * - Refund of a captured payment: `SUCCEEDED` to `PARTIALLY_REFUNDED` or
 *   `REFUNDED`; `PARTIALLY_REFUNDED` to itself (a further partial refund, the
 *   only self-transition the table lists) or to `REFUNDED`. `REFUNDED` is
 *   terminal.
 */
const TRANSITIONS: Readonly<
  Record<
    PaymentIntentStatus,
    Readonly<Partial<Record<PaymentIntentStatus, TransitionGuard>>>
  >
> = {
  CREATED: { PROCESSING: 'ALWAYS' },
  PROCESSING: {
    SUCCEEDED: 'ALWAYS',
    UNKNOWN: 'ALWAYS',
    REQUIRES_ACTION: 'ALWAYS',
    CREATED: 'RETRY_AVAILABLE',
    FAILED: 'ATTEMPTS_EXHAUSTED',
  },
  REQUIRES_ACTION: {
    SUCCEEDED: 'ALWAYS',
    UNKNOWN: 'ALWAYS',
    CREATED: 'RETRY_AVAILABLE',
    FAILED: 'ATTEMPTS_EXHAUSTED',
  },
  UNKNOWN: {
    SUCCEEDED: 'ALWAYS',
    CREATED: 'RETRY_AVAILABLE',
    FAILED: 'ATTEMPTS_EXHAUSTED',
  },
  SUCCEEDED: { PARTIALLY_REFUNDED: 'ALWAYS', REFUNDED: 'ALWAYS' },
  FAILED: {},
  PARTIALLY_REFUNDED: { PARTIALLY_REFUNDED: 'ALWAYS', REFUNDED: 'ALWAYS' },
  REFUNDED: {},
};

/**
 * Statuses whose payment outcome is final: the payment was captured, refunded
 * in part or in full, or failed. Nothing can move them back into the payment
 * lifecycle, so a target outside their row is `TERMINAL_STATUS`; only the
 * refund targets of their row are allowed.
 */
const SETTLED_STATUSES: ReadonlySet<PaymentIntentStatus> = new Set([
  'SUCCEEDED',
  'FAILED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
]);

function isValidAttemptCount(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Decides whether a payment intent may move from one status to another. It
 * checks the lifecycle and the attempt limit only; whether an attempt was
 * really declined, or non-execution was proven, is the caller's to establish
 * before asking.
 */
export function evaluatePaymentIntentTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
  context: PaymentIntentTransitionContext = {},
): PaymentIntentTransitionResult {
  const targets = TRANSITIONS[from];
  const guard = Object.hasOwn(targets, to) ? targets[to] : undefined;
  if (from === to && guard === undefined) {
    return { ok: false, code: 'SAME_STATUS', from, to };
  }
  if (guard === undefined) {
    return {
      ok: false,
      code: SETTLED_STATUSES.has(from)
        ? 'TERMINAL_STATUS'
        : 'TRANSITION_NOT_ALLOWED',
      from,
      to,
    };
  }
  if (guard === 'ALWAYS') {
    return { ok: true, from, to };
  }
  const { unsuccessfulAttempts } = context;
  if (!isValidAttemptCount(unsuccessfulAttempts)) {
    return { ok: false, code: 'INVALID_ATTEMPT_COUNT', from, to };
  }
  const limitReached = unsuccessfulAttempts >= MAX_UNSUCCESSFUL_ATTEMPTS;
  if (guard === 'RETRY_AVAILABLE' && limitReached) {
    return { ok: false, code: 'ATTEMPT_LIMIT_REACHED', from, to };
  }
  if (guard === 'ATTEMPTS_EXHAUSTED' && !limitReached) {
    return { ok: false, code: 'ATTEMPT_LIMIT_NOT_REACHED', from, to };
  }
  return { ok: true, from, to };
}
