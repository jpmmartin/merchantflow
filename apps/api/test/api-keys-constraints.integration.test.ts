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
const UNIQUE_VIOLATION = '23505';
const RESTRICT_VIOLATION = '23001';
const VALUE_TOO_LONG = '22001';

const CREATED_AT = '2026-11-03T10:00:00.000Z';
const REVOKED_AT = '2026-11-03T11:00:00.000Z';

const COLUMNS = [
  'id',
  'lookup_id',
  'secret_hash',
  'merchant_id',
  'role',
  'created_at',
  'revoked_at',
] as const;

type Column = (typeof COLUMNS)[number];
type KeyValues = Record<Column, unknown>;

let counter = 0;

/** A lookup id that is valid and different on every call. */
function uniqueLookupId(): string {
  counter += 1;
  return counter.toString(16).padStart(16, '0');
}

describe('api_keys', () => {
  let postgres: MigratedPostgres;
  let merchantId: string;

  function platformKey(overrides: Partial<KeyValues> = {}): KeyValues {
    return {
      id: randomUUID(),
      lookup_id: uniqueLookupId(),
      secret_hash: 'a'.repeat(64),
      merchant_id: null,
      role: 'PLATFORM_ADMIN',
      created_at: CREATED_AT,
      revoked_at: null,
      ...overrides,
    };
  }

  function merchantKey(overrides: Partial<KeyValues> = {}): KeyValues {
    return platformKey({
      merchant_id: merchantId,
      role: 'MERCHANT_ADMIN',
      ...overrides,
    });
  }

  function insert(values: KeyValues, omit: readonly Column[] = []) {
    const columns = COLUMNS.filter((column) => !omit.includes(column));
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    return postgres.client.query(
      `insert into api_keys (${columns.join(', ')}) values (${placeholders.join(', ')})`,
      columns.map((column) => values[column]),
    );
  }

  async function revokedAtOf(id: unknown): Promise<Date | null> {
    const result = await postgres.client.query<{ revoked_at: Date | null }>(
      'select revoked_at from api_keys where id = $1',
      [id],
    );
    return result.rows[0]?.revoked_at ?? null;
  }

  async function countRows(): Promise<number> {
    const result = await postgres.client.query<{ total: string }>(
      'select count(*) as total from api_keys',
    );
    return Number(result.rows[0]?.total);
  }

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

  describe('valid rows', () => {
    it('stores a platform key with the PLATFORM_ADMIN role and no merchant', async () => {
      await insert(platformKey());
    });

    it.each(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])(
      'stores a merchant key with the %s role',
      async (role) => {
        await insert(merchantKey({ role }));
      },
    );

    it('stores revoked_at as null when it is omitted', async () => {
      const values = platformKey();
      await insert(values, ['revoked_at']);

      expect(await revokedAtOf(values.id)).toBeNull();
    });
  });

  describe('scope and role', () => {
    it.each<[string, Partial<KeyValues>, boolean]>([
      [
        'a platform key with a merchant role',
        { role: 'MERCHANT_ADMIN' },
        false,
      ],
      [
        'a platform key with the read-only merchant role',
        { role: 'MERCHANT_READ_ONLY' },
        false,
      ],
      [
        'a merchant key with the platform role',
        { role: 'PLATFORM_ADMIN' },
        true,
      ],
      [
        'a platform key with the PLATFORM_OPERATOR role',
        { role: 'PLATFORM_OPERATOR' },
        false,
      ],
      [
        'a merchant key with the PLATFORM_OPERATOR role',
        { role: 'PLATFORM_OPERATOR' },
        true,
      ],
      ['a platform key with an unknown role', { role: 'ROOT' }, false],
      ['a merchant key with an unknown role', { role: 'ROOT' }, true],
      [
        'a merchant key with a lowercase role',
        { role: 'merchant_admin' },
        true,
      ],
      ['a merchant key with an empty role', { role: '' }, true],
    ])('rejects %s', async (_label, overrides, withMerchant) => {
      const values = withMerchant
        ? merchantKey(overrides)
        : platformKey(overrides);

      await expectDatabaseError(insert(values), {
        code: CHECK_VIOLATION,
        constraint: 'api_keys_role_scope_check',
      });
    });

    it('rejects a merchant key for a merchant that does not exist', async () => {
      await expectDatabaseError(
        insert(merchantKey({ merchant_id: randomUUID() })),
        {
          code: FOREIGN_KEY_VIOLATION,
          constraint: 'api_keys_merchant_id_fkey',
        },
      );
    });

    it('rejects removing a merchant that has a key', async () => {
      const referenced = randomUUID();
      await postgres.client.query(
        `insert into merchants (id, legal_name, display_name, business_type, industry,
           country_code, default_currency, status, created_at, updated_at)
         values ($1, 'Other Ltd', 'Other', 'LLC', 'Retail', 'US', 'USD', 'DRAFT',
           '2026-11-02T10:00:00.000Z', '2026-11-02T10:00:00.000Z')`,
        [referenced],
      );
      await insert(merchantKey({ merchant_id: referenced }));

      await expectDatabaseError(
        postgres.client.query('delete from merchants where id = $1', [
          referenced,
        ]),
        { code: FOREIGN_KEY_VIOLATION },
      );
    });

    it('rejects turning a merchant key into a platform key by update', async () => {
      const values = merchantKey();
      await insert(values);

      await expectDatabaseError(
        postgres.client.query(
          `update api_keys set merchant_id = null, role = 'PLATFORM_ADMIN' where id = $1`,
          [values.id],
        ),
        { code: RESTRICT_VIOLATION },
      );
    });
  });

  describe('lookup_id and secret_hash', () => {
    it.each([
      ['uppercase hexadecimal', 'ABCDEF0123456789'],
      ['non-hexadecimal characters', 'ghijklmnopqrstuv'],
      ['15 characters', 'abcdef012345678'],
      ['an empty string', ''],
      ['a trailing newline', 'abcdef01234567\n'],
    ])('rejects a lookup id with %s', async (_label, lookupId) => {
      await expectDatabaseError(insert(platformKey({ lookup_id: lookupId })), {
        code: CHECK_VIOLATION,
        constraint: 'api_keys_lookup_id_check',
      });
    });

    it('rejects a lookup id longer than 16 characters', async () => {
      await expectDatabaseError(
        insert(platformKey({ lookup_id: 'abcdef01234567890' })),
        { code: VALUE_TOO_LONG },
      );
    });

    it.each([
      ['uppercase hexadecimal', 'A'.repeat(64)],
      ['non-hexadecimal characters', 'z'.repeat(64)],
      ['63 characters', 'a'.repeat(63)],
      ['an empty string', ''],
    ])('rejects a secret hash with %s', async (_label, secretHash) => {
      await expectDatabaseError(
        insert(platformKey({ secret_hash: secretHash })),
        { code: CHECK_VIOLATION, constraint: 'api_keys_secret_hash_check' },
      );
    });

    it.each([
      ['65 characters', 'a'.repeat(65)],
      [
        'a full API key instead of a hash',
        `mfk_${'a'.repeat(16)}_${'b'.repeat(64)}`,
      ],
    ])('rejects a secret hash with %s', async (_label, secretHash) => {
      await expectDatabaseError(
        insert(platformKey({ secret_hash: secretHash })),
        { code: VALUE_TOO_LONG },
      );
    });

    it('rejects a second key with the same lookup id', async () => {
      const first = platformKey();
      await insert(first);

      await expectDatabaseError(
        insert(platformKey({ lookup_id: first.lookup_id })),
        { code: UNIQUE_VIOLATION, constraint: 'api_keys_lookup_id_key' },
      );
    });

    it('rejects a second key with the same id', async () => {
      const first = platformKey();
      await insert(first);

      await expectDatabaseError(insert(platformKey({ id: first.id })), {
        code: UNIQUE_VIOLATION,
        constraint: 'api_keys_pkey',
      });
    });

    it('accepts two keys that share a secret hash', async () => {
      await insert(platformKey({ secret_hash: 'c'.repeat(64) }));
      await insert(platformKey({ secret_hash: 'c'.repeat(64) }));
    });
  });

  describe('required columns', () => {
    it.each(['id', 'lookup_id', 'secret_hash', 'role', 'created_at'] as const)(
      'rejects a null %s',
      async (column) => {
        await expectDatabaseError(insert(platformKey({ [column]: null })), {
          code: NOT_NULL_VIOLATION,
        });
      },
    );

    it('has no default for the creation timestamp', async () => {
      await expectDatabaseError(insert(platformKey(), ['created_at']), {
        code: NOT_NULL_VIOLATION,
      });
    });

    it('has no default for the role, the hash, or the lookup id', async () => {
      for (const column of ['role', 'secret_hash', 'lookup_id'] as const) {
        await expectDatabaseError(insert(platformKey(), [column]), {
          code: NOT_NULL_VIOLATION,
        });
      }
    });
  });

  describe('revocation', () => {
    it('lets revoked_at go from null to a timestamp', async () => {
      const values = merchantKey();
      await insert(values);

      await postgres.client.query(
        'update api_keys set revoked_at = $2 where id = $1',
        [values.id, REVOKED_AT],
      );

      expect((await revokedAtOf(values.id))?.toISOString()).toBe(REVOKED_AT);
    });

    it('rejects clearing revoked_at, so a revoked key cannot be reactivated', async () => {
      const values = merchantKey({ revoked_at: REVOKED_AT });
      await insert(values);

      await expectDatabaseError(
        postgres.client.query(
          'update api_keys set revoked_at = null where id = $1',
          [values.id],
        ),
        { code: RESTRICT_VIOLATION },
      );

      expect((await revokedAtOf(values.id))?.toISOString()).toBe(REVOKED_AT);
    });

    it('rejects changing the revocation timestamp of a revoked key', async () => {
      const values = platformKey({ revoked_at: REVOKED_AT });
      await insert(values);

      await expectDatabaseError(
        postgres.client.query(
          `update api_keys set revoked_at = '2027-01-01T00:00:00.000Z' where id = $1`,
          [values.id],
        ),
        { code: RESTRICT_VIOLATION },
      );

      expect((await revokedAtOf(values.id))?.toISOString()).toBe(REVOKED_AT);
    });

    it('allows an update that leaves a revoked key exactly as it was', async () => {
      const values = platformKey({ revoked_at: REVOKED_AT });
      await insert(values);

      await postgres.client.query(
        'update api_keys set revoked_at = $2 where id = $1',
        [values.id, REVOKED_AT],
      );

      expect((await revokedAtOf(values.id))?.toISOString()).toBe(REVOKED_AT);
    });

    it('rejects reactivating a revoked key by changing its secret hash', async () => {
      const values = platformKey({ revoked_at: REVOKED_AT });
      await insert(values);

      await expectDatabaseError(
        postgres.client.query(
          `update api_keys set secret_hash = $2, revoked_at = null where id = $1`,
          [values.id, 'b'.repeat(64)],
        ),
        { code: RESTRICT_VIOLATION },
      );
    });

    it.each([
      ['id', randomUUID()],
      ['lookup_id', 'ffffffffffffffff'],
      ['secret_hash', 'b'.repeat(64)],
      ['created_at', '2026-11-03T09:00:00.000Z'],
    ])('rejects changing %s of an active key', async (column, value) => {
      const values = platformKey();
      await insert(values);

      await expectDatabaseError(
        postgres.client.query(
          `update api_keys set ${column} = $2 where id = $1`,
          [values.id, value],
        ),
        { code: RESTRICT_VIOLATION },
      );
    });

    it('rejects changing the role of an active key', async () => {
      const values = merchantKey();
      await insert(values);

      await expectDatabaseError(
        postgres.client.query(
          `update api_keys set role = 'MERCHANT_READ_ONLY' where id = $1`,
          [values.id],
        ),
        { code: RESTRICT_VIOLATION },
      );
    });
  });

  describe('removal', () => {
    it('rejects deleting a key', async () => {
      const values = platformKey({ revoked_at: REVOKED_AT });
      await insert(values);

      await expectDatabaseError(
        postgres.client.query('delete from api_keys where id = $1', [
          values.id,
        ]),
        { code: RESTRICT_VIOLATION },
      );

      expect(await revokedAtOf(values.id)).not.toBeNull();
    });

    it('rejects a delete that matches no row', async () => {
      await expectDatabaseError(
        postgres.client.query('delete from api_keys where false'),
        { code: RESTRICT_VIOLATION },
      );
    });

    it('rejects truncating the table, also with a cascade from merchants', async () => {
      const before = await countRows();

      await expectDatabaseError(postgres.client.query('truncate api_keys'), {
        code: RESTRICT_VIOLATION,
      });
      await expectDatabaseError(
        postgres.client.query('truncate merchants cascade'),
        { code: RESTRICT_VIOLATION },
      );

      expect(await countRows()).toBe(before);
    });

    it('therefore cannot reactivate a key by deleting and inserting it again', async () => {
      const values = platformKey({ revoked_at: REVOKED_AT });
      await insert(values);

      await expectDatabaseError(
        postgres.client.query('delete from api_keys where id = $1', [
          values.id,
        ]),
        { code: RESTRICT_VIOLATION },
      );
      await expectDatabaseError(
        insert({ ...values, id: randomUUID(), revoked_at: null }),
        { code: UNIQUE_VIOLATION, constraint: 'api_keys_lookup_id_key' },
      );
    });
  });

  describe('documented limit', () => {
    it('lets the table owner disable the trigger, which only a privileged role can do', async () => {
      const values = platformKey({ revoked_at: REVOKED_AT });
      await insert(values);

      await postgres.client.query('begin');
      try {
        await postgres.client.query(
          'alter table api_keys disable trigger api_keys_restrict_update',
        );
        await postgres.client.query(
          'update api_keys set revoked_at = null where id = $1',
          [values.id],
        );
        expect(await revokedAtOf(values.id)).toBeNull();
      } finally {
        await postgres.client.query('rollback');
      }

      expect((await revokedAtOf(values.id))?.toISOString()).toBe(REVOKED_AT);
    });
  });
});
