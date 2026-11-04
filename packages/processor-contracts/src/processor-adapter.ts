import type { ProcessorCapability } from './capability.js';
import type {
  CredentialValidationResult,
  ProcessorCredentials,
} from './credentials.js';
import type {
  GetTransactionInput,
  ProcessorTransactionLookup,
  SaleInput,
} from './payment-operations.js';
import type { ProcessorPaymentResult } from './payment-result.js';

/**
 * Provider codes are lower-case identifiers such as `stripe`. The format is
 * checked here and in PostgreSQL; which codes exist is decided by the adapters
 * registered at runtime, not by a fixed list.
 */
export const PROVIDER_CODE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

export function isProviderCode(value: string): boolean {
  return PROVIDER_CODE_PATTERN.test(value);
}

/**
 * The port every processor adapter implements. An adapter holds no merchant
 * credentials: each operation receives the credentials of the one account it
 * acts for, and the adapter keeps them only for that call.
 */
export interface ProcessorAdapter {
  /** The provider code this adapter serves. */
  readonly provider: string;
  /** What the adapter implements; nothing else may be called. */
  readonly capabilities: ReadonlySet<ProcessorCapability>;
  /**
   * Checks that credentials are test-mode credentials the provider accepts and
   * identifies the provider account they belong to. It changes nothing at the
   * provider.
   */
  validateCredentials(
    credentials: ProcessorCredentials,
  ): Promise<CredentialValidationResult>;
  /**
   * Authorizes and captures an amount (capability `SALE`). A timeout, a broken
   * connection, a provider error, or any answer that does not prove the
   * outcome is `unknown`, never `declined`; only a proven refusal before
   * execution is `failed_before_execution`. Repeating the call with the same
   * `operationId` returns the provider's first result instead of charging
   * again. Errors that are not about the provider, such as a defect, are
   * thrown.
   */
  sale(input: SaleInput): Promise<ProcessorPaymentResult>;
  /**
   * Reads the current state of one transaction (capability
   * `TRANSACTION_LOOKUP`). It changes nothing at the provider.
   */
  getTransaction(
    input: GetTransactionInput,
  ): Promise<ProcessorTransactionLookup>;
}
