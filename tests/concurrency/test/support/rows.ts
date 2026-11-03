import type { Client } from 'pg';

export interface IntentRow {
  readonly id: string;
  readonly merchant_reference: string;
}

export interface RecordRow {
  readonly idempotency_key: string;
  readonly operation_id: string;
  readonly status: string;
  readonly response_status_code: number | null;
  /** The stored JSON text, byte for byte. */
  readonly response_body: string | null;
}

export interface CreationEventRow {
  readonly target_id: string;
  readonly correlation_id: string;
}

/** The intents of a merchant, read through the test's own connection. */
export async function intentRows(
  sql: Client,
  merchantId: string,
): Promise<IntentRow[]> {
  const result = await sql.query<IntentRow>(
    'select id, merchant_reference from payment_intents where merchant_id = $1',
    [merchantId],
  );
  return result.rows;
}

/** The idempotency records of a merchant. */
export async function recordRows(
  sql: Client,
  merchantId: string,
): Promise<RecordRow[]> {
  const result = await sql.query<RecordRow>(
    `select idempotency_key, operation_id, status, response_status_code,
            response_body::text as response_body
     from idempotency_records where merchant_id = $1`,
    [merchantId],
  );
  return result.rows;
}

/** The `PAYMENT_INTENT_CREATED` audit events of a merchant. */
export async function creationEvents(
  sql: Client,
  merchantId: string,
): Promise<CreationEventRow[]> {
  const result = await sql.query<CreationEventRow>(
    `select target_id, correlation_id from audit_events
     where merchant_id = $1 and action = 'PAYMENT_INTENT_CREATED'`,
    [merchantId],
  );
  return result.rows;
}
