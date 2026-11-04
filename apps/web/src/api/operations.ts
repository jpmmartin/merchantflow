import { apiRequest } from './client';

/**
 * The actions the API accepts as the audit list's `action` filter. It mirrors
 * `AUDIT_ACTIONS` of the API's audit module; an action missing here is still
 * listed, only not offered as a filter.
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

/** Whether a text, such as a query parameter, is an audit action. */
export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/** Who acted, as the API describes it; `label` is ready to display. */
export type Actor =
  | {
      readonly type: 'USER';
      readonly label: string;
      readonly user_id: string;
      readonly display_name: string;
      readonly email: string;
    }
  | {
      readonly type: 'API_KEY';
      readonly label: string;
      readonly api_key_id: string;
      readonly role: string;
    }
  | {
      readonly type: 'SYSTEM';
      readonly label: string;
      readonly component: string;
    }
  | { readonly type: 'PLATFORM_ADMINISTRATOR'; readonly label: string }
  | {
      readonly type: 'UNKNOWN';
      readonly label: string;
      readonly actor_type: string;
      readonly actor_id: string | null;
    };

export interface AuditEvent {
  readonly id: string;
  readonly occurred_at: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly merchant_id: string | null;
  readonly correlation_id: string;
  readonly actor: Actor;
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AuditEventPage {
  readonly data: readonly AuditEvent[];
  readonly next_cursor: string | null;
}

/**
 * One page of the audit log, newest first. `from` and `to` are UTC instants
 * (ISO 8601); `from` is inclusive and `to` exclusive.
 */
export async function listAuditEvents(page: {
  readonly cursor: string | undefined;
  readonly action: AuditAction | undefined;
  readonly from: string | undefined;
  readonly to: string | undefined;
}): Promise<AuditEventPage> {
  const query = new URLSearchParams();
  if (page.action !== undefined) query.set('action', page.action);
  if (page.from !== undefined) query.set('from', page.from);
  if (page.to !== undefined) query.set('to', page.to);
  if (page.cursor !== undefined) query.set('cursor', page.cursor);
  const text = query.toString();
  return (await apiRequest(
    'GET',
    `/audit-events${text === '' ? '' : `?${text}`}`,
  )) as AuditEventPage;
}

export type TimelineItemKind =
  | 'PAYMENT_INTENT_CREATED'
  | 'PAYMENT_ATTEMPT_STARTED'
  | 'CAPTURE_REQUESTED'
  | 'VOID_REQUESTED'
  | 'REFUND_REQUESTED'
  | 'AUDIT_EVENT'
  | 'JOURNAL_ENTRY_POSTED';

export interface TimelineItem {
  readonly kind: TimelineItemKind;
  readonly source_id: string;
  readonly occurred_at: string;
  readonly summary: string;
  readonly status: string | null;
  readonly amount_minor: string | null;
  readonly currency: string | null;
  readonly actor: Actor | null;
  readonly audit_action: string | null;
}

export interface PaymentTimeline {
  readonly payment_intent_id: string;
  readonly merchant_id: string;
  readonly data: readonly TimelineItem[];
}

/** Every step of one payment, oldest first. */
export async function getPaymentTimeline(id: string): Promise<PaymentTimeline> {
  return (await apiRequest(
    'GET',
    `/payment-intents/${encodeURIComponent(id)}/timeline`,
  )) as PaymentTimeline;
}
