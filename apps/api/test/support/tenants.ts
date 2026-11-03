import type { DatabaseSchema } from '@merchantflow/database';
import type { ApiMerchant, IssuedKey, MerchantApi } from './merchant-api.js';
import type { TenantResources } from './tenant-routes.js';

/** One merchant with a key of each merchant role and a key to be addressed. */
export interface Tenant {
  readonly merchant: ApiMerchant;
  readonly admin: IssuedKey;
  readonly readOnly: IssuedKey;
  /** A second key, so a test can address a key without using the caller's. */
  readonly spare: IssuedKey;
  readonly resources: TenantResources;
}

export interface Tenants {
  readonly a: Tenant;
  readonly b: Tenant;
  readonly platform: IssuedKey;
  /** Identifiers that belong to no tenant. */
  readonly missing: TenantResources;
}

/** Identifier of a merchant that was never created. */
export const MISSING_MERCHANT_ID = '4c1f6a52-7d0e-4f0a-9d53-2f2b6a1c9e10';
const MISSING_KEY_ID = '9b7d2c1e-3a54-4e8f-8f0b-6d1a5c2e7f43';

async function createTenant(api: MerchantApi): Promise<Tenant> {
  const merchant = await api.createActiveMerchant();
  const admin = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');
  const readOnly = await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY');
  const spare = await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY');
  return {
    merchant,
    admin,
    readOnly,
    spare,
    resources: { merchantId: merchant.id, apiKeyId: spare.id },
  };
}

/**
 * Creates merchants A and B, each active and with keys for `MERCHANT_ADMIN`
 * and `MERCHANT_READ_ONLY`, and returns them with the platform key and the
 * identifiers of a merchant that does not exist.
 */
export async function createTenants(api: MerchantApi): Promise<Tenants> {
  const a = await createTenant(api);
  const b = await createTenant(api);
  return {
    a,
    b,
    platform: api.platform,
    missing: { merchantId: MISSING_MERCHANT_ID, apiKeyId: MISSING_KEY_ID },
  };
}

/** The contents of every table of the database, by table name. */
export type DatabaseSnapshot = Readonly<Record<string, readonly string[]>>;

/** Tables the migration tool keeps for itself. */
const BOOKKEEPING_TABLE = /^kysely_/;

/** Tables `DatabaseSchema` declares, to prove the snapshot reads them. */
export const SCHEMA_TABLES = [
  'merchants',
  'audit_events',
  'api_keys',
  'idempotency_records',
  'payment_intents',
] as const satisfies readonly (keyof DatabaseSchema)[];

/**
 * Reads every row of every table of the public schema through a connection of
 * its own. The table list comes from the catalog, so a table added by a later
 * migration is covered without editing this file. Each row is its JSON text and
 * rows are sorted, so the comparison does not depend on physical order.
 */
export async function snapshotDatabase(
  api: MerchantApi,
): Promise<DatabaseSnapshot> {
  const tables = await api.postgres.client.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name`,
  );
  const snapshot: Record<string, string[]> = {};
  for (const { table_name: table } of tables.rows) {
    if (BOOKKEEPING_TABLE.test(table)) continue;
    const rows = await api.postgres.client.query(
      `select * from "${table.replaceAll('"', '""')}"`,
    );
    snapshot[table] = rows.rows.map((row) => JSON.stringify(row)).sort();
  }
  return snapshot;
}

/** The rows of a snapshot whose text names the given identifier. */
export function rowsMentioning(
  snapshot: DatabaseSnapshot,
  identifier: string,
): DatabaseSnapshot {
  return Object.fromEntries(
    Object.entries(snapshot).map(([table, rows]) => [
      table,
      rows.filter((row) => row.includes(identifier)),
    ]),
  );
}
