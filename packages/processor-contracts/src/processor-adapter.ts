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
import type {
  GetRefundInput,
  ProcessorRefundLookup,
  ProcessorRefundResult,
  RefundInput,
} from './refund.js';
import type {
  CreateWebhookEndpointInput,
  DeleteWebhookEndpointInput,
  VerifyWebhookEventInput,
  WebhookEndpointCreation,
  WebhookEndpointDeletion,
  WebhookEventVerification,
} from './webhooks.js';

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
  /**
   * Refunds part or all of a captured payment (capability `REFUND`, and
   * `PARTIAL_REFUND` for less than the captured amount). A timeout, a broken
   * connection, a provider error, or any answer that does not prove the
   * outcome is `unknown`, never `failed`; only a proven refusal or failure is
   * `failed`. Repeating the call with the same `operationId` returns the
   * provider's first result instead of refunding again. Errors that are not
   * about the provider, such as a defect, are thrown.
   */
  refund(input: RefundInput): Promise<ProcessorRefundResult>;
  /**
   * Reads the current state of one refund (capability `TRANSACTION_LOOKUP`).
   * It changes nothing at the provider.
   */
  getRefund(input: GetRefundInput): Promise<ProcessorRefundLookup>;
  /**
   * Creates a webhook endpoint in the account of the credentials (capability
   * `WEBHOOKS`) and returns its signing secret.
   */
  createWebhookEndpoint(
    input: CreateWebhookEndpointInput,
  ): Promise<WebhookEndpointCreation>;
  /** Deletes a webhook endpoint the platform created (capability `WEBHOOKS`). */
  deleteWebhookEndpoint(
    input: DeleteWebhookEndpointInput,
  ): Promise<WebhookEndpointDeletion>;
  /**
   * Verifies a webhook delivery's signature on its raw body with the
   * account's signing secret and normalizes the event (capability
   * `WEBHOOKS`). It makes no network call.
   */
  verifyWebhookEvent(input: VerifyWebhookEventInput): WebhookEventVerification;
}
