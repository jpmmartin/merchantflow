import type { AuditJsonValue, AuditMetadata } from './audit-event.js';

/** A metadata value that may be shown: a scalar, or text in a list or map. */
export type SafeAuditValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | { readonly [key: string]: string };

export type SafeAuditMetadata = { readonly [key: string]: SafeAuditValue };

/** How a shown field may look. Anything else is left out. */
type FieldShape = 'scalar' | 'string-list' | 'string-map';

/**
 * The metadata fields that may leave the API, reviewed against every service
 * that records an event (P-09): identifiers of platform rows, provider object
 * identifiers that the other read endpoints already return (`pi_`, `re_`,
 * `we_`, `acct_`), statuses, decline and failure codes, amounts as integer
 * strings, and the descriptive merchant fields of `MERCHANT_UPDATED`. A field
 * not listed here is never returned, so a field added later stays hidden until
 * it is reviewed. `lookup_id` of `API_KEY_ISSUED` and `API_KEY_REVOKED` is
 * deliberately absent: it is part of the key a caller presents, and no other
 * response returns it.
 */
const SHOWN_FIELDS: ReadonlyMap<string, FieldShape> = new Map<
  string,
  FieldShape
>([
  ['action', 'scalar'],
  ['action_status', 'scalar'],
  ['amount_minor', 'scalar'],
  ['attempt_status', 'scalar'],
  ['authorization_action_id', 'scalar'],
  ['change', 'scalar'],
  ['changed_fields', 'string-list'],
  ['country_code', 'scalar'],
  ['currency', 'scalar'],
  ['current', 'string-map'],
  ['decline_code', 'scalar'],
  ['default_currency', 'scalar'],
  ['error_category', 'scalar'],
  ['expires_at', 'scalar'],
  ['failure_code', 'scalar'],
  ['from', 'scalar'],
  ['is_default', 'scalar'],
  ['journal_entry_id', 'scalar'],
  ['mode', 'scalar'],
  ['payment_attempt_id', 'scalar'],
  ['previous', 'string-map'],
  ['previous_action_status', 'scalar'],
  ['previous_default_id', 'scalar'],
  ['previous_mode', 'scalar'],
  ['previous_refund_status', 'scalar'],
  ['previous_status', 'scalar'],
  ['previous_webhook_endpoint_id', 'scalar'],
  ['processor_account_id', 'scalar'],
  ['provider', 'scalar'],
  ['provider_account_id', 'scalar'],
  ['provider_refund_id', 'scalar'],
  ['provider_transaction_id', 'scalar'],
  ['refund_id', 'scalar'],
  ['refund_status', 'scalar'],
  ['revoked_sessions', 'scalar'],
  ['role', 'scalar'],
  ['scope', 'scalar'],
  ['status', 'scalar'],
  ['to', 'scalar'],
  ['was_default', 'scalar'],
  ['webhook_endpoint_id', 'scalar'],
]);

/** An amount field must be a base-10 integer string, as the services write it. */
const AMOUNT_MINOR = /^(0|[1-9][0-9]*)$/;

function shownValue(
  name: string,
  shape: FieldShape,
  value: AuditJsonValue,
): SafeAuditValue | undefined {
  switch (shape) {
    case 'scalar':
      if (name === 'amount_minor') {
        return typeof value === 'string' && AMOUNT_MINOR.test(value)
          ? value
          : undefined;
      }
      return value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
        ? value
        : undefined;
    case 'string-list':
      return Array.isArray(value) &&
        value.every((item) => typeof item === 'string')
        ? value
        : undefined;
    case 'string-map': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
      }
      const map: Record<string, string> = {};
      for (const [key, item] of Object.entries(value)) {
        if (typeof item !== 'string') return undefined;
        map[key] = item;
      }
      return map;
    }
  }
}

/**
 * The part of an event's metadata that may be shown: only the reviewed
 * fields, and only when they have the shape the services write. Every other
 * field is dropped without a trace in the answer.
 */
export function safeAuditMetadata(metadata: AuditMetadata): SafeAuditMetadata {
  const shown: Record<string, SafeAuditValue> = {};
  for (const [name, value] of Object.entries(metadata)) {
    const shape = SHOWN_FIELDS.get(name);
    if (shape === undefined) continue;
    const safe = shownValue(name, shape, value);
    if (safe !== undefined) shown[name] = safe;
  }
  return shown;
}
