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
export {
  PROCESSOR_PAYMENT_STATUSES,
  assertNever,
  matchPaymentResult,
  type ProcessorPaymentResult,
  type ProcessorPaymentResultHandlers,
  type ProcessorPaymentStatus,
} from './payment-result.js';
export {
  PROVIDER_CODE_PATTERN,
  isProviderCode,
  type ProcessorAdapter,
} from './processor-adapter.js';
