import type { SafeAuditMetadata } from '../../audit/application/safe-audit-metadata.js';

function text(metadata: SafeAuditMetadata, name: string): string | undefined {
  const value = metadata[name];
  return typeof value === 'string' ? value : undefined;
}

/** `from → to` when both are known, otherwise the known one. */
function move(from: string | undefined, to: string | undefined): string {
  if (from !== undefined && to !== undefined && from !== to) {
    return `${from} → ${to}`;
  }
  return to ?? from ?? 'unchanged';
}

/** What an attempt status means in a step of the payment. */
function attemptStep(status: string | undefined): string {
  switch (status) {
    case 'REQUIRES_ACTION':
      return '3D Secure authentication required';
    case 'AUTHORIZED':
      return 'authorized, funds held';
    case 'SUCCEEDED':
      return 'succeeded';
    case 'DECLINED':
      return 'declined';
    case 'FAILED':
      return 'failed';
    case 'UNKNOWN':
      return 'outcome unknown';
    case 'CANCELED':
      return 'canceled';
    default:
      return status ?? 'recorded';
  }
}

/** A code in parentheses when there is one. */
function codeOf(metadata: SafeAuditMetadata, name: string): string {
  const code = text(metadata, name);
  return code === undefined ? '' : ` (${code})`;
}

/**
 * A short sentence about an event, built only from its action and its safe
 * metadata, so it can never contain a field that `safeAuditMetadata` drops.
 */
export function summarizeAuditEvent(
  action: string,
  metadata: SafeAuditMetadata,
): string {
  const intentMove = move(
    text(metadata, 'previous_status'),
    text(metadata, 'status'),
  );
  switch (action) {
    case 'PAYMENT_INTENT_CREATED':
      return 'Payment order created.';
    case 'PAYMENT_INTENT_CONFIRMED':
      return `Payment confirmed: attempt ${attemptStep(text(metadata, 'attempt_status'))}${codeOf(metadata, 'decline_code')}; order ${intentMove}.`;
    case 'PAYMENT_INTENT_ACTION_COMPLETED':
      return `3D Secure authentication completed: attempt ${attemptStep(text(metadata, 'attempt_status'))}${codeOf(metadata, 'decline_code')}; order ${intentMove}.`;
    case 'PAYMENT_ATTEMPT_RESOLVED_BY_PROVIDER_EVENT':
      return `Attempt resolved from a Stripe event: ${attemptStep(text(metadata, 'attempt_status'))}${codeOf(metadata, 'decline_code')}; order ${intentMove}.`;
    case 'PAYMENT_AUTHORIZATION_ACTION_APPLIED':
      return `${text(metadata, 'action') ?? 'Action'} ${text(metadata, 'action_status') ?? 'recorded'}${codeOf(metadata, 'failure_code')}; order ${intentMove}.`;
    case 'PAYMENT_AUTHORIZATION_ACTION_RESOLVED':
      return `${text(metadata, 'action') ?? 'Action'} resolved: ${move(text(metadata, 'previous_action_status'), text(metadata, 'action_status'))}${codeOf(metadata, 'failure_code')}; order ${intentMove}.`;
    case 'PAYMENT_REFUND_APPLIED':
      return `Refund ${text(metadata, 'refund_status') ?? 'recorded'}${codeOf(metadata, 'failure_code')}; order ${intentMove}.`;
    case 'PAYMENT_REFUND_RESOLVED':
      return text(metadata, 'change') === 'REFUND_REVERSED'
        ? `Refund failed after success and was reversed${codeOf(metadata, 'failure_code')}; order ${intentMove}.`
        : `Refund resolved: ${move(text(metadata, 'previous_refund_status'), text(metadata, 'refund_status'))}${codeOf(metadata, 'failure_code')}; order ${intentMove}.`;
    case 'LEDGER_SALE_BACKFILLED':
      return 'Sale entry posted by the ledger backfill.';
    case 'MERCHANT_CREATED':
      return 'Merchant created.';
    case 'MERCHANT_UPDATED': {
      const fields = metadata['changed_fields'];
      return Array.isArray(fields)
        ? `Merchant profile updated: ${fields.join(', ')}.`
        : 'Merchant profile updated.';
    }
    case 'MERCHANT_STATUS_CHANGED':
      return `Merchant status ${move(text(metadata, 'from'), text(metadata, 'to'))}.`;
    case 'API_KEY_ISSUED':
      return `API key issued (${text(metadata, 'role') ?? 'unknown role'}).`;
    case 'API_KEY_REVOKED':
      return `API key revoked (${text(metadata, 'role') ?? 'unknown role'}).`;
    case 'USER_CREATED':
      return `User created (${text(metadata, 'role') ?? 'unknown role'}).`;
    case 'USER_DISABLED':
      return 'User disabled and signed out.';
    case 'USER_SESSION_CREATED':
      return 'User signed in.';
    case 'USER_SESSION_REVOKED':
      return 'User signed out.';
    case 'PROCESSOR_ACCOUNT_CONNECTED':
      return `Processor account connected${metadata['is_default'] === true ? ' as default' : ''}.`;
    case 'PROCESSOR_ACCOUNT_DEFAULT_CHANGED':
      return 'Default processor account changed.';
    case 'PROCESSOR_ACCOUNT_DISABLED':
      return 'Processor account disabled.';
    case 'PROCESSOR_ACCOUNT_WEBHOOK_CONFIGURED':
      return `Webhook configured (${text(metadata, 'mode') ?? 'unknown mode'}).`;
    case 'PROCESSOR_ACCOUNT_WEBHOOK_REMOVED':
      return 'Webhook removed.';
    default:
      return `${action}.`;
  }
}
