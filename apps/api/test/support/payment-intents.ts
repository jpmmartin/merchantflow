import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { API, type MerchantApi } from './merchant-api.js';

export const PAYMENT_INTENTS = `${API}/payment-intents`;

/** A create request body as the API receives it. */
export interface CreateIntentBody {
  readonly amount_minor?: unknown;
  readonly currency?: unknown;
  readonly merchant_reference?: unknown;
  readonly [field: string]: unknown;
}

/** A payment intent as the API returns it. */
export interface ApiPaymentIntent {
  readonly id: string;
  readonly merchant_id: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly merchant_reference: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** A valid body with a reference no other test uses. */
export function intentBody(
  overrides: Record<string, unknown> = {},
): CreateIntentBody {
  return {
    amount_minor: '1000',
    currency: 'USD',
    merchant_reference: `order-${randomUUID()}`,
    ...overrides,
  };
}

/** An idempotency key no other test uses. */
export function newKey(): string {
  return `key-${randomUUID()}`;
}

/**
 * Sends a create request. `idempotencyKey` undefined sends no header at all;
 * `body` as a string is sent as raw JSON text.
 */
export function createIntent(
  api: MerchantApi,
  key: string | undefined,
  idempotencyKey: string | undefined,
  body: CreateIntentBody | string,
  headers: Readonly<Record<string, string>> = {},
): request.Test {
  const call = api.post(key, PAYMENT_INTENTS);
  if (idempotencyKey !== undefined) call.set('Idempotency-Key', idempotencyKey);
  for (const [name, value] of Object.entries(headers)) call.set(name, value);
  if (typeof body === 'string') {
    call.set('Content-Type', 'application/json').send(body);
  } else {
    call.send(body);
  }
  return call;
}

export interface IntentRow {
  readonly id: string;
  readonly merchant_id: string;
  /** Read as text, so the test sees the exact digits PostgreSQL stored. */
  readonly amount_minor: string;
  readonly currency: string;
  readonly merchant_reference: string;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface RecordRow {
  readonly id: string;
  readonly merchant_id: string;
  readonly operation: string;
  readonly idempotency_key: string;
  readonly operation_id: string;
  readonly status: string;
  readonly response_status_code: number | null;
  /** The stored JSON text, byte for byte. */
  readonly response_body: string | null;
}

/** The intents of a merchant, through the raw client. */
export async function intentRows(
  api: MerchantApi,
  merchantId: string,
): Promise<IntentRow[]> {
  const result = await api.postgres.client.query<IntentRow>(
    `select id, merchant_id, amount_minor::text as amount_minor, currency,
            merchant_reference, status, created_at, updated_at
     from payment_intents where merchant_id = $1 order by created_at, id`,
    [merchantId],
  );
  return result.rows;
}

/** The idempotency records of a merchant, through the raw client. */
export async function recordRows(
  api: MerchantApi,
  merchantId: string,
): Promise<RecordRow[]> {
  const result = await api.postgres.client.query<RecordRow>(
    `select id, merchant_id, operation, idempotency_key, operation_id, status,
            response_status_code, response_body::text as response_body
     from idempotency_records where merchant_id = $1 order by created_at, id`,
    [merchantId],
  );
  return result.rows;
}

/** The record of one key of a merchant, if any. */
export async function recordOf(
  api: MerchantApi,
  merchantId: string,
  idempotencyKey: string,
): Promise<RecordRow | undefined> {
  return (await recordRows(api, merchantId)).find(
    (row) => row.idempotency_key === idempotencyKey,
  );
}

/** The `PAYMENT_INTENT_CREATED` events of a merchant. */
export async function creationEvents(api: MerchantApi, merchantId: string) {
  return (await api.auditRows('PAYMENT_INTENT_CREATED')).filter(
    (row) => row.merchant_id === merchantId,
  );
}

/** A merchant in the given status with a key of each merchant role. */
export async function merchantWithKeys(
  api: MerchantApi,
  status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
) {
  const merchant =
    status === 'DRAFT'
      ? await api.createMerchant()
      : await api.createActiveMerchant();
  const admin = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');
  const readOnly = await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY');
  if (status === 'SUSPENDED') await setStatus(api, merchant.id, 'SUSPENDED');
  return { merchant, admin, readOnly };
}

/** Changes a merchant's status through the API as the platform administrator. */
export async function setStatus(
  api: MerchantApi,
  merchantId: string,
  status: 'ACTIVE' | 'SUSPENDED',
): Promise<void> {
  const response = await api.post(
    api.platform.key,
    `${API}/merchants/${merchantId}/status`,
    { status },
  );
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}`);
  }
}
