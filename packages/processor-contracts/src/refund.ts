import type { PositiveMoney } from '@merchantflow/domain';
import type { ProcessorCredentials } from './credentials.js';
import type { ProcessorErrorCategory } from './error-category.js';
import { assertNever } from './payment-result.js';

/**
 * Identifiers of the platform records behind a refund. An adapter attaches
 * them to the provider's refund, where the provider supports it, so the refund
 * can be traced back from the provider's dashboard.
 */
export interface ProcessorRefundReferences {
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly refundId: string;
}

/**
 * A refund of part or all of a captured payment.
 *
 * - `credentials`: the keys of the account the payment was captured with.
 * - `providerTransactionId`: the provider transaction of the successful
 *   attempt, such as a Stripe `pi_` ID.
 * - `amount`: the amount to return, greater than zero, in the payment's
 *   currency.
 * - `operationId`: the stable identity of the refund, created and stored
 *   before the call. It is sent as the provider's idempotency key, so sending
 *   the same refund again with it cannot refund twice.
 */
export interface RefundInput {
  readonly credentials: ProcessorCredentials;
  readonly providerTransactionId: string;
  readonly amount: PositiveMoney;
  readonly operationId: string;
  readonly references: ProcessorRefundReferences;
}

/**
 * The normalized outcome of a refund at a provider. No provider type crosses
 * this boundary.
 *
 * - `succeeded`: the provider refunded the amount.
 * - `pending`: the provider accepted the refund and has not finished it; it
 *   may still succeed or fail.
 * - `failed`: the provider refused or failed the refund, so no money was
 *   returned.
 * - `unknown`: the request may have reached the provider and its outcome is
 *   not known, as after a timeout. It is never read as a failure.
 */
export type ProcessorRefundResult =
  | {
      readonly status: 'succeeded';
      readonly providerRefundId: string;
    }
  | {
      readonly status: 'pending';
      readonly providerRefundId: string;
    }
  | {
      readonly status: 'failed';
      /** The provider's refund, when the provider created one before failing it. */
      readonly providerRefundId: string | null;
      readonly category: ProcessorErrorCategory;
      /** The provider's failure reason, when it gives one. */
      readonly failureCode: string | null;
    }
  | {
      readonly status: 'unknown';
      readonly category: ProcessorErrorCategory;
      /** The provider's refund, when the adapter learned it before losing track. */
      readonly providerRefundId: string | null;
    };

export type ProcessorRefundStatus = ProcessorRefundResult['status'];

/**
 * A lookup of one refund at the provider, with the keys of the account it was
 * made with. The refund must belong to `providerTransactionId` and return
 * `amount`; a refund that does not is reported as `unknown`, never applied.
 * `timeoutMs`, when given, bounds the lookup, with no automatic retry.
 */
export interface GetRefundInput {
  readonly credentials: ProcessorCredentials;
  readonly providerRefundId: string;
  readonly providerTransactionId: string;
  readonly amount: PositiveMoney;
  readonly timeoutMs?: number;
}

/**
 * The answer of a refund lookup: `found` with the refund's current state,
 * normalized like the result of a refund, or `unavailable` when the provider
 * gave no usable answer. A failed lookup says nothing about the refund, which
 * keeps whatever state it had.
 */
export type ProcessorRefundLookup =
  | { readonly outcome: 'found'; readonly result: ProcessorRefundResult }
  | {
      readonly outcome: 'unavailable';
      readonly category: Exclude<ProcessorErrorCategory, 'ISSUER_DECLINE'>;
    };

/** Every refund status, in a fixed order, for exhaustive checks and documentation. */
export const PROCESSOR_REFUND_STATUSES = [
  'succeeded',
  'pending',
  'failed',
  'unknown',
] as const satisfies readonly ProcessorRefundStatus[];

/** One handler per refund status; a missing handler fails to compile. */
export type ProcessorRefundResultHandlers<T> = {
  readonly [S in ProcessorRefundStatus]: (
    result: Extract<ProcessorRefundResult, { status: S }>,
  ) => T;
};

/**
 * Calls the handler of the refund result's status. The handler table is
 * exhaustive by type, and the switch fails to compile if a status is added
 * without a case.
 */
export function matchRefundResult<T>(
  result: ProcessorRefundResult,
  handlers: ProcessorRefundResultHandlers<T>,
): T {
  switch (result.status) {
    case 'succeeded':
      return handlers.succeeded(result);
    case 'pending':
      return handlers.pending(result);
    case 'failed':
      return handlers.failed(result);
    case 'unknown':
      return handlers.unknown(result);
    default:
      return assertNever(result);
  }
}
