/**
 * Every action the application records in the audit trail, in alphabetical
 * order. The audit list accepts only these as its `action` filter, so an
 * unknown value is refused instead of silently matching nothing. A service
 * that records a new action adds it here; until then its events are listed but
 * cannot be filtered by that action.
 */
export const AUDIT_ACTIONS = [
  'API_KEY_ISSUED',
  'API_KEY_REVOKED',
  'LEDGER_SALE_BACKFILLED',
  'MERCHANT_CREATED',
  'MERCHANT_STATUS_CHANGED',
  'MERCHANT_UPDATED',
  'PAYMENT_ATTEMPT_RESOLVED_BY_PROVIDER_EVENT',
  'PAYMENT_AUTHORIZATION_ACTION_APPLIED',
  'PAYMENT_AUTHORIZATION_ACTION_RESOLVED',
  'PAYMENT_INTENT_ACTION_COMPLETED',
  'PAYMENT_INTENT_CONFIRMED',
  'PAYMENT_INTENT_CREATED',
  'PAYMENT_REFUND_APPLIED',
  'PAYMENT_REFUND_RESOLVED',
  'PROCESSOR_ACCOUNT_CONNECTED',
  'PROCESSOR_ACCOUNT_DEFAULT_CHANGED',
  'PROCESSOR_ACCOUNT_DISABLED',
  'PROCESSOR_ACCOUNT_WEBHOOK_CONFIGURED',
  'PROCESSOR_ACCOUNT_WEBHOOK_REMOVED',
  'USER_CREATED',
  'USER_DISABLED',
  'USER_SESSION_CREATED',
  'USER_SESSION_REVOKED',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
