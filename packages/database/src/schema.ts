import type { ColumnType, Kysely } from 'kysely';

/** A JSON value as stored in a `jsonb` column. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A JSON object. The `audit_events.metadata` check rejects every other JSON type. */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Row of `merchants`. It mirrors the table, not the domain `Merchant`; the
 * merchants module maps between them. `status` lists the values of the
 * `merchants_status_check` constraint.
 */
export interface MerchantsTable {
  id: string;
  legal_name: string;
  display_name: string;
  business_type: string;
  industry: string;
  country_code: string;
  default_currency: string;
  status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED';
  created_at: Date;
  updated_at: Date;
}

/**
 * Row of `audit_events`, which is append-only. `metadata` is written as
 * serialized JSON, read back parsed, and has no update type. `actor_type` lists
 * the values of `audit_events_actor_type_check`.
 */
export interface AuditEventsTable {
  id: string;
  occurred_at: Date;
  actor_type: 'API_KEY' | 'SYSTEM';
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  merchant_id: string | null;
  correlation_id: string;
  metadata: ColumnType<JsonObject, string, never>;
}

/** Table types of the database, keyed by table name. */
export interface DatabaseSchema {
  merchants: MerchantsTable;
  audit_events: AuditEventsTable;
}

/** The Kysely instance that every query and transaction goes through. */
export type Database = Kysely<DatabaseSchema>;
