import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expectDatabaseError,
  startMigratedPostgres,
  type MigratedPostgres,
} from './support/migrated-postgres.js';

const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';
const FOREIGN_KEY_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';
const VALUE_TOO_LONG = '22001';

const COLUMNS = [
  'id',
  'occurred_at',
  'actor_type',
  'actor_id',
  'action',
  'target_type',
  'target_id',
  'merchant_id',
  'correlation_id',
  'metadata',
] as const;

type Column = (typeof COLUMNS)[number];
type EventValues = Record<Column, unknown>;

function validValues(overrides: Partial<EventValues> = {}): EventValues {
  return {
    id: randomUUID(),
    occurred_at: '2026-11-02T10:00:00.000Z',
    actor_type: 'API_KEY',
    actor_id: randomUUID(),
    action: 'MERCHANT_STATUS_CHANGED',
    target_type: 'MERCHANT',
    target_id: randomUUID(),
    merchant_id: null,
    correlation_id: randomUUID(),
    metadata: JSON.stringify({ from: 'DRAFT', to: 'ACTIVE' }),
    ...overrides,
  };
}

describe('audit_events', () => {
  let postgres: MigratedPostgres;
  let merchantId: string;

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    merchantId = randomUUID();
    await postgres.client.query(
      `insert into merchants (id, legal_name, display_name, business_type, industry,
         country_code, default_currency, status, created_at, updated_at)
       values ($1, 'Acme Payments Ltd', 'Acme', 'LLC', 'Retail', 'US', 'USD', 'DRAFT',
         '2026-11-02T10:00:00.000Z', '2026-11-02T10:00:00.000Z')`,
      [merchantId],
    );
  });

  afterAll(async () => {
    await postgres.stop();
  });

  /** Inserts one event through the raw client, without any application code. */
  function insert(overrides: Partial<EventValues> = {}): Promise<unknown> {
    const values = validValues(overrides);
    return postgres.client.query(
      `insert into audit_events (${COLUMNS.join(', ')}) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      COLUMNS.map((column) => values[column]),
    );
  }

  async function snapshot(): Promise<unknown[]> {
    const { rows } = await postgres.client.query<Record<string, unknown>>(
      'select * from audit_events order by id',
    );
    return rows;
  }

  describe('field constraints', () => {
    it('accepts an event with no merchant', async () => {
      await expect(insert()).resolves.toBeDefined();
    });

    it('accepts an event for an existing merchant', async () => {
      await expect(insert({ merchant_id: merchantId })).resolves.toBeDefined();
    });

    it('accepts the SYSTEM actor type with a component name', async () => {
      await expect(
        insert({ actor_type: 'SYSTEM', actor_id: 'seed' }),
      ).resolves.toBeDefined();
    });

    it('rejects an event for a merchant that does not exist', async () => {
      await expectDatabaseError(insert({ merchant_id: randomUUID() }), {
        code: FOREIGN_KEY_VIOLATION,
        constraint: 'audit_events_merchant_id_fkey',
      });
    });

    it.each(['api_key', 'USER', 'PLATFORM_ADMIN', ''])(
      'rejects the actor type %j',
      async (actorType) => {
        await expectDatabaseError(insert({ actor_type: actorType }), {
          code: CHECK_VIOLATION,
          constraint: 'audit_events_actor_type_check',
        });
      },
    );

    it.each([
      ['actor_id', 'audit_events_actor_id_check'],
      ['target_id', 'audit_events_target_id_check'],
    ] as const)('bounds and requires content in %s', async (column, name) => {
      await expect(
        insert({ [column]: 'x'.repeat(128) }),
      ).resolves.toBeDefined();
      for (const value of ['', '  ']) {
        await expectDatabaseError(insert({ [column]: value }), {
          code: CHECK_VIOLATION,
          constraint: name,
        });
      }
      await expectDatabaseError(insert({ [column]: 'x'.repeat(129) }), {
        code: VALUE_TOO_LONG,
      });
    });

    it.each([
      ['action', 'audit_events_action_check'],
      ['target_type', 'audit_events_target_type_check'],
    ] as const)('requires an upper snake case %s', async (column, name) => {
      await expect(insert({ [column]: 'A'.repeat(64) })).resolves.toBeDefined();
      for (const value of [
        '',
        'merchant_created',
        'Merchant',
        'MERCHANT CREATED',
        'MERCHANT-CREATED',
        '1MERCHANT',
        '_MERCHANT',
        'MERCHANT\n',
      ]) {
        await expectDatabaseError(insert({ [column]: value }), {
          code: CHECK_VIOLATION,
          constraint: name,
        });
      }
      await expectDatabaseError(insert({ [column]: 'A'.repeat(65) }), {
        code: VALUE_TOO_LONG,
      });
    });

    it('accepts the correlation ID formats of AD-30 at their limits', async () => {
      await expect(
        insert({ correlation_id: 'a'.repeat(8) }),
      ).resolves.toBeDefined();
      await expect(
        insert({ correlation_id: 'Z._-'.repeat(16) }),
      ).resolves.toBeDefined();
    });

    it.each([
      '',
      'short',
      'has space 1',
      'quote"quote1',
      'line\nbreak1',
      'semi;colon1',
      'accénted-id',
    ])('rejects the correlation ID %j', async (correlationId) => {
      await expectDatabaseError(insert({ correlation_id: correlationId }), {
        code: CHECK_VIOLATION,
        constraint: 'audit_events_correlation_id_check',
      });
    });

    it('rejects a correlation ID above 64 characters', async () => {
      await expectDatabaseError(insert({ correlation_id: 'a'.repeat(65) }), {
        code: VALUE_TOO_LONG,
      });
    });

    it('accepts an empty metadata object and nested JSON', async () => {
      await expect(insert({ metadata: '{}' })).resolves.toBeDefined();
      await expect(
        insert({ metadata: JSON.stringify({ a: { b: [1, 'two', null] } }) }),
      ).resolves.toBeDefined();
    });

    it.each(['[]', '"text"', '1', 'true', 'null', '[{"a":1}]'])(
      'rejects the metadata %s, which is not a JSON object',
      async (metadata) => {
        await expectDatabaseError(insert({ metadata }), {
          code: CHECK_VIOLATION,
          constraint: 'audit_events_metadata_check',
        });
      },
    );

    it('rejects metadata above 8192 bytes and accepts metadata just below it', async () => {
      // The constraint measures the text form of the jsonb value, which
      // PostgreSQL prints as `{"k": "<padding>"}`: 9 bytes around the padding.
      const sized = (length: number) =>
        JSON.stringify({ k: 'x'.repeat(length - 9) });
      await expect(insert({ metadata: sized(8192) })).resolves.toBeDefined();
      await expectDatabaseError(insert({ metadata: sized(8193) }), {
        code: CHECK_VIOLATION,
        constraint: 'audit_events_metadata_check',
      });
    });

    it.each(COLUMNS.filter((column) => column !== 'merchant_id'))(
      'rejects a null %s',
      async (column) => {
        await expectDatabaseError(insert({ [column]: null }), {
          code: NOT_NULL_VIOLATION,
        });
      },
    );

    it('gives occurred_at no default and stores it as timestamptz', async () => {
      const { rows } = await postgres.client.query<{
        column_default: string | null;
        data_type: string;
      }>(
        `select column_default, data_type from information_schema.columns
         where table_name = 'audit_events' and column_name = 'occurred_at'`,
      );
      expect(rows).toEqual([
        { column_default: null, data_type: 'timestamp with time zone' },
      ]);
    });
  });

  describe('immutability', () => {
    it('still accepts new events after rejected changes', async () => {
      const id = randomUUID();
      await insert({ id });
      await expectDatabaseError(
        postgres.client.query('delete from audit_events where id = $1', [id]),
        { code: RESTRICT_VIOLATION },
      );
      await expect(insert()).resolves.toBeDefined();
    });

    it('rejects UPDATE and leaves the row unchanged', async () => {
      const id = randomUUID();
      await insert({ id, merchant_id: merchantId });
      const before = await snapshot();

      const error = await expectDatabaseError(
        postgres.client.query(
          "update audit_events set action = 'TAMPERED' where id = $1",
          [id],
        ),
        { code: RESTRICT_VIOLATION },
      );
      expect(error.message).toContain('append-only');
      expect(await snapshot()).toEqual(before);
    });

    it('rejects UPDATE of every row, and an UPDATE that matches no row', async () => {
      await insert();
      const before = await snapshot();

      await expectDatabaseError(
        postgres.client.query("update audit_events set actor_id = 'x'"),
        { code: RESTRICT_VIOLATION },
      );
      await expectDatabaseError(
        postgres.client.query(
          "update audit_events set actor_id = 'x' where false",
        ),
        { code: RESTRICT_VIOLATION },
      );
      expect(await snapshot()).toEqual(before);
    });

    it('rejects DELETE and leaves the row in place', async () => {
      const id = randomUUID();
      await insert({ id });
      const before = await snapshot();

      const error = await expectDatabaseError(
        postgres.client.query('delete from audit_events where id = $1', [id]),
        { code: RESTRICT_VIOLATION },
      );
      expect(error.message).toContain('append-only');
      await expectDatabaseError(
        postgres.client.query('delete from audit_events'),
        { code: RESTRICT_VIOLATION },
      );
      await expectDatabaseError(
        postgres.client.query('delete from audit_events where false'),
        { code: RESTRICT_VIOLATION },
      );
      expect(await snapshot()).toEqual(before);
    });

    it('rejects TRUNCATE, with and without CASCADE', async () => {
      await insert();
      const before = await snapshot();

      await expectDatabaseError(
        postgres.client.query('truncate audit_events'),
        { code: RESTRICT_VIOLATION },
      );
      await expectDatabaseError(
        postgres.client.query('truncate audit_events cascade'),
        { code: RESTRICT_VIOLATION },
      );
      expect(await snapshot()).toEqual(before);
    });

    it('rejects a TRUNCATE of merchants that cascades into audit_events', async () => {
      await insert({ merchant_id: merchantId });
      const before = await snapshot();

      await expectDatabaseError(
        postgres.client.query('truncate merchants cascade'),
        { code: RESTRICT_VIOLATION },
      );
      expect(await snapshot()).toEqual(before);
      const { rows } = await postgres.client.query(
        'select count(*)::int as total from merchants',
      );
      expect(rows).toEqual([{ total: 1 }]);
    });

    it('rejects deleting a merchant that has audit events', async () => {
      await insert({ merchant_id: merchantId });
      await expectDatabaseError(
        postgres.client.query('delete from merchants where id = $1', [
          merchantId,
        ]),
        {
          code: FOREIGN_KEY_VIOLATION,
          constraint: 'audit_events_merchant_id_fkey',
        },
      );
    });
  });

  describe('limits of trigger-based immutability', () => {
    // These tests document what the trigger does not stop. Each runs in a
    // transaction that is rolled back, so the trigger is intact afterwards.
    it('lets the table owner disable the trigger and delete rows', async () => {
      const id = randomUUID();
      await insert({ id });

      await postgres.client.query('begin');
      try {
        await postgres.client.query(
          'alter table audit_events disable trigger audit_events_append_only',
        );
        const deleted = await postgres.client.query(
          'delete from audit_events where id = $1',
          [id],
        );
        expect(deleted.rowCount).toBe(1);
      } finally {
        await postgres.client.query('rollback');
      }

      const { rows } = await postgres.client.query(
        'select count(*)::int as total from audit_events where id = $1',
        [id],
      );
      expect(rows).toEqual([{ total: 1 }]);
    });

    it('lets a superuser skip the trigger with session_replication_role', async () => {
      const id = randomUUID();
      await insert({ id });

      await postgres.client.query('begin');
      try {
        await postgres.client.query(
          "set local session_replication_role = 'replica'",
        );
        const deleted = await postgres.client.query(
          'delete from audit_events where id = $1',
          [id],
        );
        expect(deleted.rowCount).toBe(1);
      } finally {
        await postgres.client.query('rollback');
      }

      await expectDatabaseError(
        postgres.client.query('delete from audit_events where id = $1', [id]),
        { code: RESTRICT_VIOLATION },
      );
    });
  });
});
