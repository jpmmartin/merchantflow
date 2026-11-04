import type { PositiveMoney } from '@merchantflow/domain';
import type { ProcessorCredentials } from './credentials.js';
import type { ProcessorErrorCategory } from './error-category.js';
import type { ProcessorPaymentResult } from './payment-result.js';

/**
 * Identifiers of the platform records behind a provider operation. An adapter
 * attaches them to the provider's transaction, where the provider supports it,
 * so the transaction can be traced back from the provider's dashboard.
 */
export interface ProcessorOperationReferences {
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly paymentAttemptId: string;
}

/**
 * A sale: authorize and capture an amount in one operation.
 *
 * - `credentials`: the keys of the one account the sale is made with.
 * - `amount`: the amount to charge, greater than zero, with its currency.
 * - `paymentMethod`: a token the provider's browser library created; never
 *   card data.
 * - `operationId`: the stable identity of the operation, created and stored
 *   before the call. It is sent as the provider's idempotency key, so sending
 *   the same sale again with it cannot charge twice.
 */
export interface SaleInput {
  readonly credentials: ProcessorCredentials;
  readonly amount: PositiveMoney;
  readonly paymentMethod: string;
  readonly operationId: string;
  readonly references: ProcessorOperationReferences;
}

/** A lookup of one transaction at the provider, with the account's keys. */
export interface GetTransactionInput {
  readonly credentials: ProcessorCredentials;
  readonly providerTransactionId: string;
}

/**
 * The answer of a transaction lookup.
 *
 * - `found`: the provider answered, and `result` is the transaction's current
 *   state, normalized like the result of a sale.
 * - `unavailable`: the provider gave no usable answer. It says nothing about
 *   the transaction, which keeps whatever state it had; the caller may look it
 *   up again later.
 */
export type ProcessorTransactionLookup =
  | { readonly outcome: 'found'; readonly result: ProcessorPaymentResult }
  | {
      readonly outcome: 'unavailable';
      readonly category: Exclude<ProcessorErrorCategory, 'ISSUER_DECLINE'>;
    };
