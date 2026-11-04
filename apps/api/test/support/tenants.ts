import { randomUUID } from 'node:crypto';
import type { Database, DatabaseSchema } from '@merchantflow/database';
import { parsePositiveMoney } from '@merchantflow/domain';
import { CreateUserService } from '../../src/modules/auth/application/create-user.service.js';
import { generatePassword } from '../../src/modules/auth/application/password-hash.js';
import { DATABASE } from '../../src/modules/database/database.module.js';
import { LedgerPostingService } from '../../src/modules/ledger/application/ledger-posting.service.js';
import {
  SECRET_CIPHER,
  type SecretCipher,
} from '../../src/modules/merchants/infrastructure/secret-cipher.js';
import {
  API,
  START_TIME,
  type ApiMerchant,
  type IssuedKey,
  type MerchantApi,
} from './merchant-api.js';
import {
  createIntent,
  intentBody,
  newKey,
  type ApiPaymentIntent,
} from './payment-intents.js';
import type { TenantResources } from './tenant-routes.js';

/**
 * One merchant with a key of each merchant role, a key to be addressed, a
 * payment intent, a user, a default processor account, and a journal entry.
 */
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
  /** Identifier of a platform user, which no merchant path may reach. */
  readonly platformUserId: string;
  /** Identifiers that belong to no tenant. */
  readonly missing: TenantResources;
}

/** Identifier of a merchant that was never created. */
export const MISSING_MERCHANT_ID = '4c1f6a52-7d0e-4f0a-9d53-2f2b6a1c9e10';
const MISSING_KEY_ID = '9b7d2c1e-3a54-4e8f-8f0b-6d1a5c2e7f43';
const MISSING_PAYMENT_INTENT_ID = '2d8e5b7a-61c3-4f9d-a0e4-7b3c9f1d6a58';
const MISSING_USER_ID = '6e2a9c4f-8b17-4d3e-b5a0-1f7c3d9e2b64';
const MISSING_PROCESSOR_ACCOUNT_ID = '8a3f1d6c-2e9b-4c7a-9f05-3b8e6d2a1c47';
const MISSING_JOURNAL_ENTRY_ID = '5f9c2a7e-1d4b-4e8a-b3c6-7a2e9d1f4b85';

/**
 * Posts a sale for a merchant's intent through the ledger module's posting
 * service, as Apply does for a successful attempt, so the merchant has
 * accounts, a balance, and a journal entry. The source is a new attempt ID,
 * because the tenant intents have no attempt.
 */
async function postJournalEntry(
  api: MerchantApi,
  merchantId: string,
  paymentIntentId: string,
): Promise<string> {
  const amount = parsePositiveMoney('1000', 'USD');
  if (!amount.ok) throw new Error('Expected a valid amount');
  const posting = await api.app
    .get<Database>(DATABASE)
    .transaction()
    .execute((trx) =>
      api.app.get(LedgerPostingService).postPaymentSale(trx, {
        merchantId,
        paymentIntentId,
        paymentAttemptId: randomUUID(),
        amount: amount.money,
        merchantReference: 'tenant-ledger',
      }),
    );
  if (!posting.ok) throw new Error('Expected a posted journal entry');
  return posting.entry.id;
}

/**
 * Stores a default Stripe processor account for a merchant directly, with its
 * secret encrypted by the application's cipher, because connecting one through
 * the API would call Stripe.
 */
async function createProcessorAccount(
  api: MerchantApi,
  merchantId: string,
): Promise<string> {
  const cipher = api.app.get<SecretCipher | null>(SECRET_CIPHER);
  if (cipher === null) throw new Error('Expected a credentials master key');
  const id = randomUUID();
  const compact = randomUUID().replaceAll('-', '');
  const secretKey = `sk_test_${compact}`;
  const secret = cipher.encrypt(secretKey, {
    merchantId,
    processorAccountId: id,
    provider: 'stripe',
  });
  await api.postgres.client.query(
    `insert into processor_accounts (
       id, merchant_id, provider, display_name, provider_account_id,
       publishable_key, secret_key_ciphertext, secret_key_iv,
       secret_key_auth_tag, secret_key_version, secret_key_hint, enabled,
       is_default, created_at, updated_at
     ) values ($1, $2, 'stripe', 'Tenant Stripe', $3, $4, $5, $6, $7, $8, $9,
       true, true, $10, $10)`,
    [
      id,
      merchantId,
      `acct_${compact.slice(0, 16)}`,
      `pk_test_${compact}`,
      secret.ciphertext,
      secret.iv,
      secret.authTag,
      secret.keyVersion,
      secretKey.slice(-4),
      START_TIME,
    ],
  );
  return id;
}

async function createTenant(api: MerchantApi): Promise<Tenant> {
  const merchant = await api.createActiveMerchant();
  const admin = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');
  const readOnly = await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY');
  const spare = await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY');
  const intent = await createIntent(api, admin.key, newKey(), intentBody());
  if (intent.status !== 201) {
    throw new Error(`Expected 201, got ${intent.status}`);
  }
  const paymentIntentId = (intent.body as ApiPaymentIntent).id;
  const user = await api.post(
    api.platform.key,
    `${API}/merchants/${merchant.id}/users`,
    {
      email: `tenant-${randomUUID()}@example.test`,
      display_name: 'Tenant User',
    },
  );
  if (user.status !== 201) {
    throw new Error(`Expected 201, got ${user.status}`);
  }
  const userId = (user.body as { id: string }).id;
  const processorAccountId = await createProcessorAccount(api, merchant.id);
  const journalEntryId = await postJournalEntry(
    api,
    merchant.id,
    paymentIntentId,
  );
  return {
    merchant,
    admin,
    readOnly,
    spare,
    resources: {
      merchantId: merchant.id,
      apiKeyId: spare.id,
      paymentIntentId,
      userId,
      processorAccountId,
      journalEntryId,
    },
  };
}

/**
 * Creates merchants A and B, each active and with keys for `MERCHANT_ADMIN`
 * and `MERCHANT_READ_ONLY`, a payment intent, and a user, and a platform user,
 * and returns them with the platform key and the identifiers of a merchant
 * that does not exist.
 */
export async function createTenants(api: MerchantApi): Promise<Tenants> {
  const a = await createTenant(api);
  const b = await createTenant(api);
  const platformUser = await api.app.get(CreateUserService).execute({
    actor: { actorType: 'SYSTEM', actorId: 'tenant-isolation-test' },
    email: `platform-${randomUUID()}@example.test`,
    displayName: 'Platform User',
    scope: { kind: 'PLATFORM', role: 'PLATFORM_ADMIN' },
    password: generatePassword(),
    correlationId: randomUUID(),
  });
  if (!platformUser.ok) throw new Error('Expected the platform user');
  return {
    a,
    b,
    platform: api.platform,
    platformUserId: platformUser.user.id,
    missing: {
      merchantId: MISSING_MERCHANT_ID,
      apiKeyId: MISSING_KEY_ID,
      paymentIntentId: MISSING_PAYMENT_INTENT_ID,
      userId: MISSING_USER_ID,
      processorAccountId: MISSING_PROCESSOR_ACCOUNT_ID,
      journalEntryId: MISSING_JOURNAL_ENTRY_ID,
    },
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
