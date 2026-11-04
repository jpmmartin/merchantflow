export { ProcessorAdapterRegistry } from './adapter-registry.js';
export {
  PROCESSOR_CAPABILITIES,
  type ProcessorCapability,
} from './capability.js';
export {
  CREDENTIAL_REJECTION_REASONS,
  type CredentialRejectionReason,
  type CredentialValidationResult,
  type ProcessorCredentials,
} from './credentials.js';
export {
  PROCESSOR_ERROR_CATEGORIES,
  type ProcessorErrorCategory,
} from './error-category.js';
export type {
  GetTransactionInput,
  ProcessorOperationReferences,
  ProcessorTransactionLookup,
  SaleInput,
} from './payment-operations.js';
export {
  PROCESSOR_PAYMENT_STATUSES,
  assertNever,
  matchPaymentResult,
  type ProcessorPaymentResult,
  type ProcessorPaymentResultHandlers,
  type ProcessorPaymentStatus,
} from './payment-result.js';
export {
  PROCESSOR_REFUND_STATUSES,
  matchRefundResult,
  type GetRefundInput,
  type ProcessorRefundLookup,
  type ProcessorRefundReferences,
  type ProcessorRefundResult,
  type ProcessorRefundResultHandlers,
  type ProcessorRefundStatus,
  type RefundInput,
} from './refund.js';
export type {
  CreateWebhookEndpointInput,
  DeleteWebhookEndpointInput,
  ProcessorEvent,
  ProcessorEventReferences,
  VerifyWebhookEventInput,
  WebhookEndpointCreation,
  WebhookEndpointDeletion,
  WebhookEventVerification,
} from './webhooks.js';
export {
  PROVIDER_CODE_PATTERN,
  isProviderCode,
  type ProcessorAdapter,
} from './processor-adapter.js';
