import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertTestMerchant } from './support/idempotency.js';
import {
  expectDatabaseError,
  startMigratedPostgres,
  type MigratedPostgres,
} from './support/migrated-postgres.js';

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const NOT_NULL_VIOLATION = '23502';
const RESTRICT_VIOLATION = '23001';
const FINGERPRINT = 'a'.repeat(64);

type Row = Record<string, unknown>;

describe('idempotency_records constraints', () => {
  let postgres: MigratedPostgres;
  let merchantId: string;

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    merchantId = await insertTestMerchant(postgres.db);
  });

  afterAll(async () => {
    await postgres.stop();
  });

  function inProgress(overrides: Row = {}): Row {
    return {
      id: randomUUID(),
      merchant_id: merchantId,
      operation: 'CREATE_PAYMENT_INTENT',
      idempotency_key: `key-${randomUUID()}`,
      request_fingerprint: FINGERPRINT,
      operation_id: randomUUID(),
      status: 'IN_PROGRESS',
      response_status_code: null,
      response_body: null,
      created_at: '2026-11-03T10:00:00Z',
      completed_at: null,
      expires_at: '2026-12-03T10:00:00Z',
      ...overrides,
    };
  }

  function completed(overrides: Row = {}): Row {
    return inProgress({
      status: 'COMPLETED',
      response_status_code: 201,
      response_body: '{"id":"pi_1"}',
      completed_at: '2026-11-03T10:00:01Z',
      ...overrides,
    });
  }

  function insert(row: Row) {
    const columns = Object.keys(row);
    return postgres.client.query(
      `insert into idempotency_records (${columns.join(', ')})
       values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(row),
    );
  }

  async function count(): Promise<number> {
    const { rows } = await postgres.client.query<{ total: number }>(
      'select count(*)::int as total from idempotency_records',
    );
    return rows[0]?.total ?? Number.NaN;
  }

  describe('valid rows', () => {
    it('accepts a record in progress and a completed record', async () => {
      await insert(inProgress());
      await insert(completed());
    });

    it.each(['a', '!', '~', 'A-z_0.9:~!', 'k'.repeat(255)])(
      'accepts the key %j',
      async (key) => {
        await insert(inProgress({ idempotency_key: key }));
      },
    );

    it.each(['A', 'CREATE_PAYMENT_INTENT', 'X'.repeat(64), 'A1_2'])(
      'accepts the operation %j',
      async (operation) => {
        await insert(inProgress({ operation }));
      },
    );

    it.each([100, 200, 409, 599])(
      'accepts the status code %i',
      async (code) => {
        await insert(completed({ response_status_code: code }));
      },
    );

    it('accepts a body of exactly 65536 bytes of text', async () => {
      // {"p":"..."} is 8 bytes plus the padding.
      const body = JSON.stringify({ p: 'x'.repeat(65536 - 8) });
      expect(Buffer.byteLength(body)).toBe(65536);

      await insert(completed({ response_body: body }));
    });

    it('keeps the body text and its key order exactly as given', async () => {
      const row = completed({
        response_body: '{"b":1,"a":{"d":2,"c":3},"b":4}',
      });
      await insert(row);

      const { rows } = await postgres.client.query<{ body: string }>(
        'select response_body::text as body from idempotency_records where id = $1',
        [row.id],
      );
      expect(rows[0]?.body).toBe('{"b":1,"a":{"d":2,"c":3},"b":4}');
    });

    it('accepts the same key under another operation or another merchant', async () => {
      const otherMerchantId = await insertTestMerchant(postgres.db);
      const first = inProgress();
      await insert(first);

      await insert(
        inProgress({
          idempotency_key: first.idempotency_key,
          operation: 'CONFIRM_PAYMENT_INTENT',
        }),
      );
      await insert(
        inProgress({
          idempotency_key: first.idempotency_key,
          merchant_id: otherMerchantId,
        }),
      );
    });
  });

  describe('invalid rows', () => {
    const cases: {
      name: string;
      row: () => Row;
      code: string;
      constraint?: string;
    }[] = [
      {
        name: 'an unknown status',
        row: () => inProgress({ status: 'FAILED' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_status_check',
      },
      {
        name: 'a lowercase status',
        row: () => inProgress({ status: 'in_progress' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_status_check',
      },
      {
        name: 'an uppercase fingerprint',
        row: () => inProgress({ request_fingerprint: 'A'.repeat(64) }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_request_fingerprint_check',
      },
      {
        name: 'a short fingerprint',
        row: () => inProgress({ request_fingerprint: 'a'.repeat(63) }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_request_fingerprint_check',
      },
      {
        name: 'a fingerprint that is not hexadecimal',
        row: () => inProgress({ request_fingerprint: 'g'.repeat(64) }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_request_fingerprint_check',
      },
      {
        name: 'a long fingerprint',
        row: () => inProgress({ request_fingerprint: 'a'.repeat(65) }),
        code: '22001',
      },
      {
        name: 'an empty key',
        row: () => inProgress({ idempotency_key: '' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_idempotency_key_check',
      },
      {
        name: 'a key of 256 characters',
        row: () => inProgress({ idempotency_key: 'k'.repeat(256) }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_idempotency_key_check',
      },
      {
        name: 'a key of 255 characters and a trailing space',
        row: () => inProgress({ idempotency_key: `${'k'.repeat(255)} ` }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_idempotency_key_check',
      },
      {
        name: 'a key with a space',
        row: () => inProgress({ idempotency_key: 'a b' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_idempotency_key_check',
      },
      {
        name: 'a key with a tab',
        row: () => inProgress({ idempotency_key: 'a\tb' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_idempotency_key_check',
      },
      {
        name: 'a key with a trailing newline',
        row: () => inProgress({ idempotency_key: 'ab\n' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_idempotency_key_check',
      },
      {
        name: 'a key with DEL',
        row: () => inProgress({ idempotency_key: 'a\u007fb' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_idempotency_key_check',
      },
      {
        name: 'a key outside ASCII',
        row: () => inProgress({ idempotency_key: 'clé' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_idempotency_key_check',
      },
      {
        name: 'a lowercase operation',
        row: () => inProgress({ operation: 'create_payment_intent' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_operation_check',
      },
      {
        name: 'an empty operation',
        row: () => inProgress({ operation: '' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_operation_check',
      },
      {
        name: 'an operation that starts with a digit',
        row: () => inProgress({ operation: '1_CREATE' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_operation_check',
      },
      {
        name: 'an operation with a hyphen',
        row: () => inProgress({ operation: 'CREATE-INTENT' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_operation_check',
      },
      {
        name: 'an operation of 65 characters',
        row: () => inProgress({ operation: 'X'.repeat(65) }),
        code: '22001',
      },
      {
        name: 'an in-progress record with a status code',
        row: () => inProgress({ response_status_code: 201 }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_status_response_check',
      },
      {
        name: 'an in-progress record with a body',
        row: () => inProgress({ response_body: '{}' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_status_response_check',
      },
      {
        name: 'an in-progress record with a completion time',
        row: () => inProgress({ completed_at: '2026-11-03T10:00:01Z' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_status_response_check',
      },
      {
        name: 'a completed record without a status code',
        row: () => completed({ response_status_code: null }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_status_response_check',
      },
      {
        name: 'a completed record without a body',
        row: () => completed({ response_body: null }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_status_response_check',
      },
      {
        name: 'a completed record without a completion time',
        row: () => completed({ completed_at: null }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_status_response_check',
      },
      {
        name: 'a status code of 99',
        row: () => completed({ response_status_code: 99 }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_response_status_code_check',
      },
      {
        name: 'a status code of 600',
        row: () => completed({ response_status_code: 600 }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_response_status_code_check',
      },
      {
        name: 'a body that is an array',
        row: () => completed({ response_body: '[]' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_response_body_check',
      },
      {
        name: 'a body that is a string',
        row: () => completed({ response_body: '"ok"' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_response_body_check',
      },
      {
        name: 'a body that is JSON null',
        row: () => completed({ response_body: 'null' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_response_body_check',
      },
      {
        name: 'a body of 65537 bytes of text',
        row: () =>
          completed({
            response_body: JSON.stringify({ p: 'x'.repeat(65536 - 7) }),
          }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_response_body_check',
      },
      {
        name: 'a body that is not JSON',
        row: () => completed({ response_body: '{id:1}' }),
        code: '22P02',
      },
      {
        name: 'an expiry equal to the creation time',
        row: () => inProgress({ expires_at: '2026-11-03T10:00:00Z' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_expires_at_check',
      },
      {
        name: 'an expiry before the creation time',
        row: () => inProgress({ expires_at: '2026-11-02T10:00:00Z' }),
        code: CHECK_VIOLATION,
        constraint: 'idempotency_records_expires_at_check',
      },
      {
        name: 'an unknown merchant',
        row: () => inProgress({ merchant_id: randomUUID() }),
        code: FOREIGN_KEY_VIOLATION,
        constraint: 'idempotency_records_merchant_id_fkey',
      },
      ...[
        'id',
        'merchant_id',
        'operation',
        'idempotency_key',
        'request_fingerprint',
        'operation_id',
        'status',
        'created_at',
        'expires_at',
      ].map((column) => ({
        name: `a null ${column}`,
        row: () => inProgress({ [column]: null }),
        code: NOT_NULL_VIOLATION,
      })),
    ];

    it.each(cases)('rejects $name', async ({ row, code, constraint }) => {
      const before = await count();

      await expectDatabaseError(insert(row()), {
        code,
        ...(constraint === undefined ? {} : { constraint }),
      });
      expect(await count()).toBe(before);
    });

    it('rejects a second row for the same merchant, operation, and key', async () => {
      const first = inProgress();
      await insert(first);

      await expectDatabaseError(
        insert(
          completed({
            idempotency_key: first.idempotency_key,
            request_fingerprint: 'b'.repeat(64),
          }),
        ),
        { code: UNIQUE_VIOLATION, constraint: 'idempotency_records_scope_key' },
      );
    });

    it('rejects a duplicate id', async () => {
      const first = inProgress();
      await insert(first);

      await expectDatabaseError(insert(inProgress({ id: first.id })), {
        code: UNIQUE_VIOLATION,
        constraint: 'idempotency_records_pkey',
      });
    });
  });

  describe('updates', () => {
    async function withRow(row: Row) {
      await insert(row);
      return row.id as string;
    }

    it('lets a record in progress be completed', async () => {
      const id = await withRow(inProgress());

      const result = await postgres.client.query(
        `update idempotency_records
         set status = 'COMPLETED', response_status_code = 201,
             response_body = '{}', completed_at = now(),
             expires_at = now() + interval '30 days'
         where id = $1`,
        [id],
      );

      expect(result.rowCount).toBe(1);
    });

    it.each([
      [
        'status',
        `status = 'IN_PROGRESS', response_status_code = null, response_body = null, completed_at = null`,
      ],
      ['response_status_code', 'response_status_code = 500'],
      ['response_body', `response_body = '{"replaced":true}'`],
      ['completed_at', `completed_at = completed_at + interval '1 second'`],
      ['expires_at', `expires_at = expires_at + interval '1 day'`],
    ])(
      'rejects a change of %s on a completed record',
      async (_column, assignment) => {
        const id = await withRow(completed());
        const before = await postgres.client.query(
          'select * from idempotency_records where id = $1',
          [id],
        );

        await expectDatabaseError(
          postgres.client.query(
            `update idempotency_records set ${assignment} where id = $1`,
            [id],
          ),
          { code: RESTRICT_VIOLATION },
        );
        const after = await postgres.client.query(
          'select * from idempotency_records where id = $1',
          [id],
        );
        expect(after.rows).toEqual(before.rows);
      },
    );

    it.each([
      ['id', `id = gen_random_uuid()`],
      ['operation', `operation = 'OTHER_OPERATION'`],
      ['idempotency_key', `idempotency_key = idempotency_key || 'x'`],
      ['request_fingerprint', `request_fingerprint = '${'b'.repeat(64)}'`],
      ['operation_id', `operation_id = gen_random_uuid()`],
      ['created_at', `created_at = created_at - interval '1 second'`],
    ])(
      'rejects a change of %s on a record in progress',
      async (_column, assignment) => {
        const id = await withRow(inProgress());

        await expectDatabaseError(
          postgres.client.query(
            `update idempotency_records set ${assignment} where id = $1`,
            [id],
          ),
          { code: RESTRICT_VIOLATION },
        );
      },
    );

    it('rejects moving a record to another merchant', async () => {
      const otherMerchantId = await insertTestMerchant(postgres.db);
      const id = await withRow(inProgress());

      await expectDatabaseError(
        postgres.client.query(
          'update idempotency_records set merchant_id = $2 where id = $1',
          [id, otherMerchantId],
        ),
        { code: RESTRICT_VIOLATION },
      );
    });

    it('rejects completing a record without a response', async () => {
      const id = await withRow(inProgress());

      await expectDatabaseError(
        postgres.client.query(
          `update idempotency_records set status = 'COMPLETED' where id = $1`,
          [id],
        ),
        {
          code: CHECK_VIOLATION,
          constraint: 'idempotency_records_status_response_check',
        },
      );
    });

    it('rejects deleting a merchant that has records', async () => {
      const ownerId = await insertTestMerchant(postgres.db);
      await insert(inProgress({ merchant_id: ownerId }));

      await expectDatabaseError(
        postgres.client.query('delete from merchants where id = $1', [ownerId]),
        {
          code: FOREIGN_KEY_VIOLATION,
          constraint: 'idempotency_records_merchant_id_fkey',
        },
      );
    });
  });
});
