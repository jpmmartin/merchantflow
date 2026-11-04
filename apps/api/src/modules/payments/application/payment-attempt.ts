import type { CaptureMode } from '@merchantflow/domain';
import type {
  ProcessorErrorCategory,
  ProcessorPaymentResult,
} from '@merchantflow/processor-contracts';
import { matchPaymentResult } from '@merchantflow/processor-contracts';

/**
 * Lifecycle statuses of a payment attempt, one execution of an intent against
 * one processor account. `EXECUTING`, `REQUIRES_ACTION`, and `UNKNOWN` are
 * open: while an attempt is open, no other attempt of its intent can start.
 * `AUTHORIZED` holds the funds of a `MANUAL` intent; its capture makes it
 * `SUCCEEDED` (captured) and its void `CANCELED` (released).
 */
export const PAYMENT_ATTEMPT_STATUSES = [
  'EXECUTING',
  'REQUIRES_ACTION',
  'SUCCEEDED',
  'DECLINED',
  'FAILED',
  'UNKNOWN',
  'AUTHORIZED',
  'CANCELED',
] as const;

export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

/** A payment attempt. Timestamps come from the injected clock. */
export interface PaymentAttempt {
  readonly id: string;
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly processorAccountId: string;
  /** The provider idempotency key of the attempt, created before the call. */
  readonly operationId: string;
  /** The idempotency record of the confirmation that started the attempt. */
  readonly idempotencyRecordId: string;
  readonly status: PaymentAttemptStatus;
  readonly providerTransactionId: string | null;
  readonly declineCode: string | null;
  readonly errorCategory: ProcessorErrorCategory | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What a provider result means for an attempt:
 *
 * - `SUCCEEDED`: the provider captured the payment of an `AUTOMATIC` intent.
 * - `AUTHORIZED`: the provider holds the funds of a `MANUAL` intent, not
 *   captured.
 * - `REQUIRES_ACTION`: the customer must authenticate; the client secret is
 *   for the browser only and is never stored.
 * - `UNSUCCESSFUL`: a decline (`DECLINED`) or a proven non-execution
 *   (`FAILED`); nothing was charged, and it counts toward the attempt limit.
 * - `UNKNOWN`: the outcome cannot be established; it blocks new attempts.
 */
export type AttemptResolution =
  | {
      readonly kind: 'SUCCEEDED';
      readonly providerTransactionId: string;
    }
  | {
      readonly kind: 'AUTHORIZED';
      readonly providerTransactionId: string;
    }
  | {
      readonly kind: 'REQUIRES_ACTION';
      readonly providerTransactionId: string;
      readonly clientSecret: string;
    }
  | {
      readonly kind: 'UNSUCCESSFUL';
      readonly attemptStatus: 'DECLINED' | 'FAILED';
      readonly providerTransactionId: string | null;
      readonly declineCode: string | null;
      readonly errorCategory: ProcessorErrorCategory;
    }
  | {
      readonly kind: 'UNKNOWN';
      readonly providerTransactionId: string | null;
      readonly errorCategory: ProcessorErrorCategory;
    };

/**
 * Translates a normalized provider result into the change of an attempt of an
 * intent with the given capture mode. A decline is recorded with the category
 * `ISSUER_DECLINE`; an unknown result is never read as a decline.
 *
 * A result that does not fit the capture mode proves nothing the attempt
 * expects, so it is `UNKNOWN` with the category `UNKNOWN`, which blocks the
 * intent for manual review: a capture (`succeeded`) of a `MANUAL` intent's
 * attempt happened outside the platform's capture, and an authorization of an
 * `AUTOMATIC` intent's attempt was not asked for. A canceled provider payment
 * is `UNKNOWN` too, as it was before capture modes existed.
 */
export function resolutionOf(
  result: ProcessorPaymentResult,
  captureMode: CaptureMode,
): AttemptResolution {
  const mismatch = (providerTransactionId: string): AttemptResolution => ({
    kind: 'UNKNOWN',
    providerTransactionId,
    errorCategory: 'UNKNOWN',
  });
  return matchPaymentResult<AttemptResolution>(result, {
    succeeded: (r) =>
      captureMode === 'AUTOMATIC'
        ? { kind: 'SUCCEEDED', providerTransactionId: r.providerTransactionId }
        : mismatch(r.providerTransactionId),
    authorized: (r) =>
      captureMode === 'MANUAL'
        ? { kind: 'AUTHORIZED', providerTransactionId: r.providerTransactionId }
        : mismatch(r.providerTransactionId),
    canceled: (r) => mismatch(r.providerTransactionId),
    requires_action: (r) => ({
      kind: 'REQUIRES_ACTION',
      providerTransactionId: r.providerTransactionId,
      clientSecret: r.clientSecret,
    }),
    declined: (r) => ({
      kind: 'UNSUCCESSFUL',
      attemptStatus: 'DECLINED',
      providerTransactionId: r.providerTransactionId,
      declineCode: r.declineCode,
      errorCategory: 'ISSUER_DECLINE',
    }),
    failed_before_execution: (r) => ({
      kind: 'UNSUCCESSFUL',
      attemptStatus: 'FAILED',
      providerTransactionId: null,
      declineCode: null,
      errorCategory: r.category,
    }),
    unknown: (r) => ({
      kind: 'UNKNOWN',
      providerTransactionId: r.providerTransactionId,
      errorCategory: r.category,
    }),
  });
}

/** The attempt status a resolution sets. */
export function attemptStatusOf(
  resolution: AttemptResolution,
): PaymentAttemptStatus {
  switch (resolution.kind) {
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'AUTHORIZED':
      return 'AUTHORIZED';
    case 'REQUIRES_ACTION':
      return 'REQUIRES_ACTION';
    case 'UNSUCCESSFUL':
      return resolution.attemptStatus;
    case 'UNKNOWN':
      return 'UNKNOWN';
  }
}
