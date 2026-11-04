import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertTestMerchant } from './support/idempotency.js';
import {
  expectDatabaseError,
  startMigratedPostgres,
  type MigratedPostgres,
} from './support/migrated-postgres.js';

const CREATED_AT = '2026-11-03T12:00:00.000Z';

interface IntentValues {
  id?: string;
  merchant_id?: string;
  amount_minor?: string;
  currency?: string;
  merchant_reference?: string;
  status?: string;
}

describe('payment_intents constraints', () => {
  let postgres: MigratedPostgres;
  let merchantId: string;
  let otherMerchantId: string;

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    merchantId = await insertTestMerchant(postgres.db);
    otherMerchantId = await insertTestMerchant(postgres.db);
  });

  afterAll(async () => {
    await postgres.stop();
  });

  /** Inserts a row through the raw client, bypassing the application. */
  function insert(values: IntentValues = {}) {
    const row = {
      id: randomUUID(),
      merchant_id: merchantId,
      amount_minor: '1000',
      currency: 'USD',
      merchant_reference: `order-${randomUUID()}`,
      status: 'CREATED',
      ...values,
    };
    return postgres.client
      .query(
        `insert into payment_intents
           (id, merchant_id, amount_minor, currency, merchant_reference,
            status, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          row.id,
          row.merchant_id,
          row.amount_minor,
          row.currency,
          row.merchant_reference,
          row.status,
          CREATED_AT,
        ],
      )
      .then(() => row);
  }

  it('accepts a valid row and keeps the BIGINT maximum exact', async () => {
    const row = await insert({ amount_minor: '9223372036854775807' });
    const stored = await postgres.client.query<{ amount_minor: string }>(
      'select amount_minor::text as amount_minor from payment_intents where id = $1',
      [row.id],
    );
    expect(stored.rows[0]?.amount_minor).toBe('9223372036854775807');
  });

  it.each(['0', '-1'])('rejects the amount %s', async (amount) => {
    await expectDatabaseError(insert({ amount_minor: amount }), {
      code: '23514',
      constraint: 'payment_intents_amount_minor_check',
    });
  });

  it('rejects an amount above the BIGINT maximum', async () => {
    await expectDatabaseError(insert({ amount_minor: '9223372036854775808' }), {
      code: '22003',
    });
  });

  it.each(['usd', 'US', 'U1D'])('rejects the currency %j', async (currency) => {
    await expectDatabaseError(insert({ currency }), {
      code: '23514',
      constraint: 'payment_intents_currency_check',
    });
  });

  it('accepts a well-formed currency that Money does not support', async () => {
    await expect(insert({ currency: 'EUR' })).resolves.toBeDefined();
  });

  it.each(['REQUIRES_CAPTURE', 'created', 'CANCELED'])(
    'rejects the status %j',
    async (status) => {
      await expectDatabaseError(insert({ status }), {
        code: '23514',
        constraint: 'payment_intents_status_check',
      });
    },
  );

  it.each([
    'CREATED',
    'PROCESSING',
    'SUCCEEDED',
    'FAILED',
    'UNKNOWN',
    'REQUIRES_ACTION',
  ])('accepts the status %s', async (status) => {
    await expect(insert({ status })).resolves.toBeDefined();
  });

  it.each([
    ['empty', ''],
    ['129 characters', 'r'.repeat(129)],
    ['with a space', 'order 1'],
    ['128 characters and a trailing space', `${'r'.repeat(128)} `],
    ['with a newline', 'order-1\n'],
    ['outside ASCII', 'pedido-ñ'],
  ])('rejects a reference %s', async (_label, reference) => {
    await expectDatabaseError(insert({ merchant_reference: reference }), {
      code: '23514',
      constraint: 'payment_intents_merchant_reference_check',
    });
  });

  it('accepts a reference of 128 visible ASCII characters', async () => {
    await expect(
      insert({ merchant_reference: '!'.repeat(128) }),
    ).resolves.toBeDefined();
  });

  it('allows one intent per merchant and reference, and the same reference for another merchant', async () => {
    const reference = `order-${randomUUID()}`;
    await insert({ merchant_reference: reference });
    await expectDatabaseError(insert({ merchant_reference: reference }), {
      code: '23505',
      constraint: 'payment_intents_merchant_reference_key',
    });
    await expect(
      insert({ merchant_reference: reference, merchant_id: otherMerchantId }),
    ).resolves.toBeDefined();
  });

  it('rejects an unknown merchant', async () => {
    await expectDatabaseError(insert({ merchant_id: randomUUID() }), {
      code: '23503',
      constraint: 'payment_intents_merchant_id_fkey',
    });
  });

  it('has a unique (merchant_id, id) for composite foreign keys', async () => {
    const result = await postgres.client.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'payment_intents_merchant_id_id_key'`,
    );
    expect(result.rows.map((row) => row.definition)).toEqual([
      'UNIQUE (merchant_id, id)',
    ]);
  });

  it('has no default on any column', async () => {
    const result = await postgres.client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'payment_intents' and column_default is not null`,
    );
    expect(result.rows).toEqual([]);
  });

  it('lets only status and updated_at change', async () => {
    const row = await insert();
    await postgres.client.query(
      `update payment_intents set status = 'PROCESSING', updated_at = now() where id = $1`,
      [row.id],
    );

    for (const assignment of [
      `amount_minor = 1`,
      `currency = 'EUR'`,
      `merchant_reference = 'changed'`,
      `merchant_id = '${otherMerchantId}'`,
      `id = '${randomUUID()}'`,
      `created_at = now()`,
    ]) {
      await expectDatabaseError(
        postgres.client.query(
          `update payment_intents set ${assignment} where id = $1`,
          [row.id],
        ),
        { code: '23001' },
      );
    }
  });

  it.each([
    ['a delete', 'delete from payment_intents where id = $1', true, '23001'],
    [
      'a delete that matches no row',
      'delete from payment_intents where false',
      false,
      '23001',
    ],
    // The foreign key of payment_attempts makes PostgreSQL refuse a truncate
    // (feature_not_supported) before the statement trigger runs.
    ['a truncate', 'truncate payment_intents', false, '0A000'],
  ])('rejects %s', async (_label, statement, withId, code) => {
    const row = await insert();
    await expectDatabaseError(
      postgres.client.query(statement, withId ? [row.id] : []),
      { code },
    );
  });
});
