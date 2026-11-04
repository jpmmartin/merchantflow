import type { PositiveMoney } from '@merchantflow/domain';
import type { ProcessorCredentials } from './credentials.js';
import type { ProcessorErrorCategory } from './error-category.js';
import { assertNever } from './payment-result.js';

/**
 * Identifiers of the platform records behind a capture or a void. An adapter
 * may attach them to the provider's payment, where the provider supports it.
 */
export interface ProcessorAuthorizationActionReferences {
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly authorizationActionId: string;
}

/**
 * A capture of the whole amount an authorization holds.
 *
 * - `credentials`: the keys of the account the payment was authorized with.
 * - `providerTransactionId`: the authorized provider payment, such as a
 *   Stripe `pi_` ID.
 * - `amount`: the amount to capture: the whole amount of the authorization,
 *   which the provider's answer must match.
 * - `operationId`: the stable identity of the capture, created and stored
 *   before the call. It is sent as the provider's idempotency key, so sending
 *   the same capture again with it cannot capture twice.
 */
export interface CaptureInput {
  readonly credentials: ProcessorCredentials;
  readonly providerTransactionId: string;
  readonly amount: PositiveMoney;
  readonly operationId: string;
  readonly references: ProcessorAuthorizationActionReferences;
}

/**
 * A void: the release of an authorization's hold, with nothing captured. The
 * fields mean what they mean for a capture.
 */
export interface VoidInput {
  readonly credentials: ProcessorCredentials;
  readonly providerTransactionId: string;
  readonly operationId: string;
  readonly references: ProcessorAuthorizationActionReferences;
}

/**
 * The normalized outcome of a capture or a void at a provider. No provider
 * type crosses this boundary.
 *
 * - `succeeded`: the provider captured the funds, or released the hold.
 * - `failed`: the provider refused the request, so the hold is as it was
 *   before (for example, the authorization had already expired).
 * - `unknown`: the request may have reached the provider and its outcome is
 *   not known, as after a timeout. It is never read as a failure.
 */
export type ProcessorAuthorizationActionResult =
  | { readonly status: 'succeeded' }
  | {
      readonly status: 'failed';
      readonly category: ProcessorErrorCategory;
      /** The provider's error code, when it gives one. */
      readonly failureCode: string | null;
    }
  | { readonly status: 'unknown'; readonly category: ProcessorErrorCategory };

export type ProcessorAuthorizationActionStatus =
  ProcessorAuthorizationActionResult['status'];

/** Every status, in a fixed order, for exhaustive checks and documentation. */
export const PROCESSOR_AUTHORIZATION_ACTION_STATUSES = [
  'succeeded',
  'failed',
  'unknown',
] as const satisfies readonly ProcessorAuthorizationActionStatus[];

/** One handler per status; a missing handler fails to compile. */
export type ProcessorAuthorizationActionResultHandlers<T> = {
  readonly [S in ProcessorAuthorizationActionStatus]: (
    result: Extract<ProcessorAuthorizationActionResult, { status: S }>,
  ) => T;
};

/**
 * Calls the handler of the result's status. The handler table is exhaustive
 * by type, and the switch fails to compile if a status is added without a
 * case.
 */
export function matchAuthorizationActionResult<T>(
  result: ProcessorAuthorizationActionResult,
  handlers: ProcessorAuthorizationActionResultHandlers<T>,
): T {
  switch (result.status) {
    case 'succeeded':
      return handlers.succeeded(result);
    case 'failed':
      return handlers.failed(result);
    case 'unknown':
      return handlers.unknown(result);
    default:
      return assertNever(result);
  }
}
