import { randomUUID } from 'node:crypto';
import { MERCHANT_STATUSES } from '@merchantflow/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expectDatabaseError,
  startMigratedPostgres,
  type MigratedPostgres,
} from './support/migrated-postgres.js';

const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';
const UNIQUE_VIOLATION = '23505';
const VALUE_TOO_LONG = '22001';

const COLUMNS = [
  'id',
  'legal_name',
  'display_name',
  'business_type',
  'industry',
  'country_code',
  'default_currency',
  'status',
  'created_at',
  'updated_at',
] as const;

type Column = (typeof COLUMNS)[number];
type MerchantValues = Record<Column, unknown>;

const T0 = '2026-11-02T10:00:00.000Z';

function validValues(): MerchantValues {
  return {
    id: randomUUID(),
    legal_name: 'Acme Payments Ltd',
    display_name: 'Acme',
    business_type: 'LLC',
    industry: 'Retail',
    country_code: 'US',
    default_currency: 'USD',
    status: 'DRAFT',
    created_at: T0,
    updated_at: T0,
  };
}

describe('merchants constraints', () => {
  let postgres: MigratedPostgres;

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
  });

  afterAll(async () => {
    await postgres.stop();
  });

  /** Inserts one row through the raw client, without any application code. */
  function insert(overrides: Partial<MerchantValues>): Promise<unknown> {
    const values = { ...validValues(), ...overrides };
    return postgres.client.query(
      `insert into merchants (${COLUMNS.join(', ')}) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      COLUMNS.map((column) => values[column]),
    );
  }

  it('accepts a valid merchant', async () => {
    await expect(insert({})).resolves.toBeDefined();
  });

  it.each(MERCHANT_STATUSES)('accepts the domain status %s', async (status) => {
    await expect(insert({ status })).resolves.toBeDefined();
  });

  it.each(['PENDING_REVIEW', 'REJECTED', 'active', 'Active', ' ACTIVE', ''])(
    'rejects the status %j',
    async (status) => {
      await expectDatabaseError(insert({ status }), {
        code: CHECK_VIOLATION,
        constraint: 'merchants_status_check',
      });
    },
  );

  describe.each([
    ['legal_name', 200],
    ['display_name', 100],
    ['business_type', 50],
    ['industry', 100],
  ] as const)('%s', (column, maxLength) => {
    const constraint = `merchants_${column}_check`;

    it('accepts a value of exactly the maximum length', async () => {
      await expect(
        insert({ [column]: 'x'.repeat(maxLength) }),
      ).resolves.toBeDefined();
    });

    it.each(['', ' ', '   ', '\t', '\n', ' \t\n '])(
      'rejects the blank value %j',
      async (value) => {
        await expectDatabaseError(insert({ [column]: value }), {
          code: CHECK_VIOLATION,
          constraint,
        });
      },
    );

    it('rejects a value above the maximum length', async () => {
      await expectDatabaseError(
        insert({ [column]: 'x'.repeat(maxLength + 1) }),
        { code: VALUE_TOO_LONG },
      );
    });
  });

  it('counts characters, not bytes, against the length bound', async () => {
    await expect(
      insert({ display_name: 'é'.repeat(100) }),
    ).resolves.toBeDefined();
    await expectDatabaseError(insert({ display_name: 'é'.repeat(101) }), {
      code: VALUE_TOO_LONG,
    });
  });

  it.each(['us', 'Us', 'U', 'U1', '', 'ÜS'])(
    'rejects the country code %j',
    async (countryCode) => {
      await expectDatabaseError(insert({ country_code: countryCode }), {
        code: CHECK_VIOLATION,
        constraint: 'merchants_country_code_check',
      });
    },
  );

  it.each(['USA', ' US', 'US\n'])(
    'rejects the country code %j, which is longer than two characters',
    async (countryCode) => {
      await expectDatabaseError(insert({ country_code: countryCode }), {
        code: VALUE_TOO_LONG,
      });
    },
  );

  it.each(['US', 'ES', 'GB'])('accepts the country code %s', async (code) => {
    await expect(insert({ country_code: code })).resolves.toBeDefined();
  });

  it.each(['usd', 'Usd', 'US', 'U$D', '', 'US1'])(
    'rejects the currency code %j',
    async (currency) => {
      await expectDatabaseError(insert({ default_currency: currency }), {
        code: CHECK_VIOLATION,
        constraint: 'merchants_default_currency_check',
      });
    },
  );

  it.each(['USDD', ' USD', 'USD\n'])(
    'rejects the currency code %j, which is longer than three characters',
    async (currency) => {
      await expectDatabaseError(insert({ default_currency: currency }), {
        code: VALUE_TOO_LONG,
      });
    },
  );

  it('drops excess trailing spaces instead of rejecting them, as varchar(n) does', async () => {
    const id = randomUUID();
    await insert({ id, country_code: 'US ', default_currency: 'USD  ' });
    const { rows } = await postgres.client.query(
      'select country_code, default_currency from merchants where id = $1',
      [id],
    );
    expect(rows).toEqual([{ country_code: 'US', default_currency: 'USD' }]);
  });

  it('checks the currency format only, so a valid non-USD code is accepted', async () => {
    await expect(insert({ default_currency: 'EUR' })).resolves.toBeDefined();
  });

  it('rejects updated_at earlier than created_at', async () => {
    await expectDatabaseError(
      insert({ updated_at: '2026-11-02T09:59:59.999Z' }),
      { code: CHECK_VIOLATION, constraint: 'merchants_updated_at_check' },
    );
  });

  it('accepts updated_at equal to created_at', async () => {
    await expect(insert({ updated_at: T0 })).resolves.toBeDefined();
  });

  it('rejects an update that moves updated_at before created_at', async () => {
    const id = randomUUID();
    await insert({ id });
    await expectDatabaseError(
      postgres.client.query(
        'update merchants set updated_at = $2 where id = $1',
        [id, '2026-11-02T09:00:00.000Z'],
      ),
      { code: CHECK_VIOLATION, constraint: 'merchants_updated_at_check' },
    );
  });

  it('rejects an update to an invalid status', async () => {
    const id = randomUUID();
    await insert({ id });
    await expectDatabaseError(
      postgres.client.query(
        "update merchants set status = 'REJECTED' where id = $1",
        [id],
      ),
      { code: CHECK_VIOLATION, constraint: 'merchants_status_check' },
    );
  });

  it.each(COLUMNS)('rejects a null %s', async (column) => {
    await expectDatabaseError(insert({ [column]: null }), {
      code: NOT_NULL_VIOLATION,
    });
  });

  it('declares every text column as a bounded varchar', async () => {
    const { rows } = await postgres.client.query<{
      column_name: string;
      data_type: string;
      character_maximum_length: number;
    }>(
      `select column_name, data_type, character_maximum_length from information_schema.columns
       where table_name = 'merchants' and data_type like 'character%'
       order by column_name`,
    );
    expect(rows).toEqual([
      {
        column_name: 'business_type',
        data_type: 'character varying',
        character_maximum_length: 50,
      },
      {
        column_name: 'country_code',
        data_type: 'character varying',
        character_maximum_length: 2,
      },
      {
        column_name: 'default_currency',
        data_type: 'character varying',
        character_maximum_length: 3,
      },
      {
        column_name: 'display_name',
        data_type: 'character varying',
        character_maximum_length: 100,
      },
      {
        column_name: 'industry',
        data_type: 'character varying',
        character_maximum_length: 100,
      },
      {
        column_name: 'legal_name',
        data_type: 'character varying',
        character_maximum_length: 200,
      },
      {
        column_name: 'status',
        data_type: 'character varying',
        character_maximum_length: 20,
      },
    ]);
  });

  it('gives the timestamp columns no default', async () => {
    const { rows } = await postgres.client.query<{
      column_name: string;
      column_default: string | null;
    }>(
      `select column_name, column_default from information_schema.columns
       where table_name = 'merchants' and column_name in ('created_at', 'updated_at')`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.column_default)).toEqual([null, null]);
  });

  it('stores the timestamps as timestamptz', async () => {
    const { rows } = await postgres.client.query<{ data_type: string }>(
      `select data_type from information_schema.columns
       where table_name = 'merchants' and column_name in ('created_at', 'updated_at')`,
    );
    expect(rows.map((row) => row.data_type)).toEqual([
      'timestamp with time zone',
      'timestamp with time zone',
    ]);
  });

  it('rejects a duplicate id', async () => {
    const id = randomUUID();
    await insert({ id });
    await expectDatabaseError(insert({ id }), {
      code: UNIQUE_VIOLATION,
      constraint: 'merchants_pkey',
    });
  });
});
