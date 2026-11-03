import type {
  ColumnType,
  Insertable,
  Kysely,
  Selectable,
  Transaction,
} from 'kysely';

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

/**
 * Row of `api_keys`. Only `revoked_at` can be updated: the other columns have
 * no update type, matching the `api_keys_restrict_update` trigger. `role` lists
 * the values of `api_keys_role_scope_check`, and `secret_hash` is the SHA-256 of
 * the secret part of the key, never the key itself.
 */
export interface ApiKeysTable {
  id: ColumnType<string, string, never>;
  lookup_id: ColumnType<string, string, never>;
  secret_hash: ColumnType<string, string, never>;
  merchant_id: ColumnType<string | null, string | null, never>;
  role: ColumnType<
    'PLATFORM_ADMIN' | 'MERCHANT_ADMIN' | 'MERCHANT_READ_ONLY',
    'PLATFORM_ADMIN' | 'MERCHANT_ADMIN' | 'MERCHANT_READ_ONLY',
    never
  >;
  created_at: ColumnType<Date, Date, never>;
  revoked_at: Date | null;
}

/** An `api_keys` row as selected, with every column at its read type. */
export type ApiKeyRow = Selectable<ApiKeysTable>;

/**
 * Row of `idempotency_records`. The scope, the fingerprint, the operation ID,
 * and the creation time have no update type, matching the
 * `idempotency_records_restrict_update` trigger. `status` lists the values of
 * `idempotency_records_status_check`. `response_body` is a `json` column: it is
 * written as serialized JSON and read back parsed, in its original key order.
 */
export interface IdempotencyRecordsTable {
  id: ColumnType<string, string, never>;
  merchant_id: ColumnType<string, string, never>;
  operation: ColumnType<string, string, never>;
  idempotency_key: ColumnType<string, string, never>;
  request_fingerprint: ColumnType<string, string, never>;
  operation_id: ColumnType<string, string, never>;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response_status_code: number | null;
  response_body: ColumnType<JsonObject | null, string | null, string>;
  created_at: ColumnType<Date, Date, never>;
  completed_at: Date | null;
  expires_at: Date;
}

/** An `idempotency_records` row as selected, with every column at its read type. */
export type IdempotencyRecordRow = Selectable<IdempotencyRecordsTable>;

/**
 * Row of `payment_intents`. It mirrors the table, not the domain
 * `PaymentIntent`; the payments module maps between them. Only `status` and
 * `updated_at` can be updated, matching the `payment_intents_restrict_update`
 * trigger. `amount_minor` is a `BIGINT`, read as a `bigint` by the pool's type
 * parsers and written from one. `status` lists the values of
 * `payment_intents_status_check`.
 */
export interface PaymentIntentsTable {
  id: ColumnType<string, string, never>;
  merchant_id: ColumnType<string, string, never>;
  amount_minor: ColumnType<bigint, bigint, never>;
  currency: ColumnType<string, string, never>;
  merchant_reference: ColumnType<string, string, never>;
  status: 'CREATED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  created_at: ColumnType<Date, Date, never>;
  updated_at: Date;
}

/** A `payment_intents` row as selected, with every column at its read type. */
export type PaymentIntentRow = Selectable<PaymentIntentsTable>;

/** A `payment_intents` row as inserted, with every column at its insert type. */
export type NewPaymentIntentRow = Insertable<PaymentIntentsTable>;

/** Table types of the database, keyed by table name. */
export interface DatabaseSchema {
  merchants: MerchantsTable;
  audit_events: AuditEventsTable;
  api_keys: ApiKeysTable;
  idempotency_records: IdempotencyRecordsTable;
  payment_intents: PaymentIntentsTable;
}

/** The Kysely instance that every query and transaction goes through. */
export type Database = Kysely<DatabaseSchema>;

/**
 * An open transaction of `Database`. Code that must run inside the caller's
 * transaction takes this type: a plain `Database` does not satisfy it.
 */
export type DatabaseTransaction = Transaction<DatabaseSchema>;
