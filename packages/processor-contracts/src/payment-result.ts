import type { ProcessorErrorCategory } from './error-category.js';

/**
 * The normalized outcome of a payment operation at a provider. No provider
 * type crosses this boundary: an adapter translates its own models into one of
 * these variants.
 *
 * - `succeeded`: the provider executed the operation.
 * - `declined`: the provider or the issuer refused it; nothing was charged.
 * - `requires_action`: the customer must complete a step, such as 3D Secure.
 * - `failed_before_execution`: the adapter can prove the provider never
 *   executed it, so a new attempt is safe.
 * - `unknown`: the request may have reached the provider and its outcome is
 *   not known, as after a timeout. It is never read as a failure.
 */
export type ProcessorPaymentResult =
  | {
      readonly status: 'succeeded';
      readonly providerTransactionId: string;
    }
  | {
      readonly status: 'declined';
      readonly providerTransactionId: string | null;
      /** The provider's decline code, when it gives one. */
      readonly declineCode: string | null;
    }
  | {
      readonly status: 'requires_action';
      readonly providerTransactionId: string;
      /**
       * What the provider's browser library needs to run the customer's step,
       * such as a Stripe client secret. It is a credential for that one
       * transaction: it is returned to the browser and never stored or logged.
       */
      readonly clientSecret: string;
    }
  | {
      readonly status: 'failed_before_execution';
      readonly category: ProcessorErrorCategory;
    }
  | {
      readonly status: 'unknown';
      readonly category: ProcessorErrorCategory;
      /** The provider transaction, when the adapter learned it before losing track. */
      readonly providerTransactionId: string | null;
    };

export type ProcessorPaymentStatus = ProcessorPaymentResult['status'];

/** Every status, in a fixed order, for exhaustive checks and documentation. */
export const PROCESSOR_PAYMENT_STATUSES = [
  'succeeded',
  'declined',
  'requires_action',
  'failed_before_execution',
  'unknown',
] as const satisfies readonly ProcessorPaymentStatus[];

/** One handler per status; a missing handler fails to compile. */
export type ProcessorPaymentResultHandlers<T> = {
  readonly [S in ProcessorPaymentStatus]: (
    result: Extract<ProcessorPaymentResult, { status: S }>,
  ) => T;
};

/**
 * Calls the handler of the result's status. The handler table is exhaustive by
 * type, and the switch fails to compile if a status is added without a case.
 */
export function matchPaymentResult<T>(
  result: ProcessorPaymentResult,
  handlers: ProcessorPaymentResultHandlers<T>,
): T {
  switch (result.status) {
    case 'succeeded':
      return handlers.succeeded(result);
    case 'declined':
      return handlers.declined(result);
    case 'requires_action':
      return handlers.requires_action(result);
    case 'failed_before_execution':
      return handlers.failed_before_execution(result);
    case 'unknown':
      return handlers.unknown(result);
    default:
      return assertNever(result);
  }
}

/** Fails to compile when a union is not handled completely. */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
}
