/**
 * Operations and features a processor adapter may support. An adapter declares
 * only what it implements; a caller checks the declaration before it relies on
 * an operation, and an undeclared one is a typed refusal, never a silent no-op.
 */
export const PROCESSOR_CAPABILITIES = [
  'CREDENTIAL_VALIDATION',
  'AUTHORIZATION',
  'CAPTURE',
  'PARTIAL_CAPTURE',
  'SALE',
  'REFUND',
  'PARTIAL_REFUND',
  'VOID',
  'STORED_PAYMENT_METHODS',
  'WEBHOOKS',
  'TRANSACTION_LOOKUP',
  'PROVIDER_IDEMPOTENCY',
] as const;

export type ProcessorCapability = (typeof PROCESSOR_CAPABILITIES)[number];
