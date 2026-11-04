import type {
  Database,
  DatabaseTransaction,
  ProcessorAccountRow,
} from '@merchantflow/database';
import type {
  ProcessorAccount,
  ProcessorAccountWebhook,
} from '../application/processor-account.js';
import type { EncryptedSecret } from './secret-cipher.js';

/** Columns every query returns: everything except the encrypted secret. */
const PUBLIC_COLUMNS = [
  'id',
  'merchant_id',
  'provider',
  'display_name',
  'provider_account_id',
  'publishable_key',
  'secret_key_hint',
  'enabled',
  'is_default',
  'created_at',
  'updated_at',
] as const;

type PublicRow = Pick<ProcessorAccountRow, (typeof PUBLIC_COLUMNS)[number]>;

function toProcessorAccount(row: PublicRow): ProcessorAccount {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    provider: row.provider,
    displayName: row.display_name,
    providerAccountId: row.provider_account_id,
    publishableKey: row.publishable_key,
    secretKeyHint: row.secret_key_hint,
    enabled: row.enabled,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Name of the partial unique index on an enabled provider account. */
export const ENABLED_PROVIDER_ACCOUNT_INDEX =
  'processor_accounts_enabled_provider_account_idx';

/**
 * Inserts an account with its encrypted secret and returns it without the
 * secret. A second enabled connection of the same provider account violates
 * `ENABLED_PROVIDER_ACCOUNT_INDEX`, which surfaces as a thrown database error.
 */
export async function insertProcessorAccount(
  trx: DatabaseTransaction,
  account: ProcessorAccount,
  secret: EncryptedSecret,
): Promise<ProcessorAccount> {
  const row = await trx
    .insertInto('processor_accounts')
    .values({
      id: account.id,
      merchant_id: account.merchantId,
      provider: account.provider,
      display_name: account.displayName,
      provider_account_id: account.providerAccountId,
      publishable_key: account.publishableKey,
      secret_key_ciphertext: secret.ciphertext,
      secret_key_iv: secret.iv,
      secret_key_auth_tag: secret.authTag,
      secret_key_version: secret.keyVersion,
      secret_key_hint: account.secretKeyHint,
      enabled: account.enabled,
      is_default: account.isDefault,
      created_at: account.createdAt,
      updated_at: account.updatedAt,
    })
    .returning(PUBLIC_COLUMNS)
    .executeTakeFirstOrThrow();
  return toProcessorAccount(row);
}

/** Every account of a merchant, enabled or not, oldest first. */
export async function listProcessorAccounts(
  db: Database,
  merchantId: string,
): Promise<readonly ProcessorAccount[]> {
  const rows = await db
    .selectFrom('processor_accounts')
    .select(PUBLIC_COLUMNS)
    .where('merchant_id', '=', merchantId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(toProcessorAccount);
}

/** The account with the given id of the given merchant, or `undefined`. */
export async function findProcessorAccount(
  db: Database,
  key: { readonly merchantId: string; readonly id: string },
): Promise<ProcessorAccount | undefined> {
  const row = await db
    .selectFrom('processor_accounts')
    .select(PUBLIC_COLUMNS)
    .where('merchant_id', '=', key.merchantId)
    .where('id', '=', key.id)
    .executeTakeFirst();
  return row === undefined ? undefined : toProcessorAccount(row);
}

/** Whether the merchant has a default account. */
export async function hasDefaultProcessorAccount(
  db: Database,
  merchantId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('processor_accounts')
    .select('id')
    .where('merchant_id', '=', merchantId)
    .where('is_default', '=', true)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Disables an enabled account and takes away its default flag, only if it is
 * still enabled, and returns it; `undefined` when it does not exist for the
 * merchant or is already disabled.
 */
export async function disableEnabledProcessorAccount(
  trx: DatabaseTransaction,
  change: {
    readonly merchantId: string;
    readonly id: string;
    readonly updatedAt: Date;
  },
): Promise<ProcessorAccount | undefined> {
  const row = await trx
    .updateTable('processor_accounts')
    .set({ enabled: false, is_default: false, updated_at: change.updatedAt })
    .where('merchant_id', '=', change.merchantId)
    .where('id', '=', change.id)
    .where('enabled', '=', true)
    .returning(PUBLIC_COLUMNS)
    .executeTakeFirst();
  return row === undefined ? undefined : toProcessorAccount(row);
}

/**
 * Clears the default flag of the merchant's current default account and
 * returns its id, or `undefined` when the merchant had none.
 */
export async function clearDefaultProcessorAccount(
  trx: DatabaseTransaction,
  change: { readonly merchantId: string; readonly updatedAt: Date },
): Promise<string | undefined> {
  const row = await trx
    .updateTable('processor_accounts')
    .set({ is_default: false, updated_at: change.updatedAt })
    .where('merchant_id', '=', change.merchantId)
    .where('is_default', '=', true)
    .returning('id')
    .executeTakeFirst();
  return row?.id;
}

/**
 * Makes an enabled, non-default account the default, only if it still is
 * enabled and not the default, and returns it; `undefined` otherwise. The
 * previous default must be cleared first, or the partial unique index refuses
 * the change.
 */
export async function makeDefaultProcessorAccount(
  trx: DatabaseTransaction,
  change: {
    readonly merchantId: string;
    readonly id: string;
    readonly updatedAt: Date;
  },
): Promise<ProcessorAccount | undefined> {
  const row = await trx
    .updateTable('processor_accounts')
    .set({ is_default: true, updated_at: change.updatedAt })
    .where('merchant_id', '=', change.merchantId)
    .where('id', '=', change.id)
    .where('enabled', '=', true)
    .where('is_default', '=', false)
    .returning(PUBLIC_COLUMNS)
    .executeTakeFirst();
  return row === undefined ? undefined : toProcessorAccount(row);
}

/** An account with the stored parts of its encrypted secret key. */
export interface ProcessorAccountWithSecret {
  readonly account: ProcessorAccount;
  readonly secret: EncryptedSecret;
}

/**
 * The account with the given id of the given merchant, with its encrypted
 * secret, or `undefined`. Only the code that decrypts the secret for a
 * provider call reads it.
 */
export async function findProcessorAccountWithSecret(
  db: Database,
  key: { readonly merchantId: string; readonly id: string },
): Promise<ProcessorAccountWithSecret | undefined> {
  const row = await db
    .selectFrom('processor_accounts')
    .select([
      ...PUBLIC_COLUMNS,
      'secret_key_ciphertext',
      'secret_key_iv',
      'secret_key_auth_tag',
      'secret_key_version',
    ])
    .where('merchant_id', '=', key.merchantId)
    .where('id', '=', key.id)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    account: toProcessorAccount(row),
    secret: {
      ciphertext: row.secret_key_ciphertext,
      iv: row.secret_key_iv,
      authTag: row.secret_key_auth_tag,
      keyVersion: row.secret_key_version,
    },
  };
}

/** The webhook columns that are not secret. */
const WEBHOOK_COLUMNS = [
  'webhook_mode',
  'webhook_secret_hint',
  'webhook_endpoint_id',
  'webhook_configured_at',
] as const;

type WebhookRow = Pick<ProcessorAccountRow, (typeof WEBHOOK_COLUMNS)[number]>;

function toWebhook(row: WebhookRow): ProcessorAccountWebhook | null {
  if (
    row.webhook_mode === null ||
    row.webhook_secret_hint === null ||
    row.webhook_configured_at === null
  ) {
    return null;
  }
  return {
    mode: row.webhook_mode,
    signingSecretHint: row.webhook_secret_hint,
    endpointId: row.webhook_endpoint_id,
    configuredAt: row.webhook_configured_at,
  };
}

/** An account with its webhook configuration, which may be absent. */
export interface ProcessorAccountWithWebhook {
  readonly account: ProcessorAccount;
  readonly webhook: ProcessorAccountWebhook | null;
}

/**
 * The account with the given id of the given merchant and its webhook
 * configuration, without any secret, or `undefined`. Pass `forUpdate` inside a
 * transaction to lock the row until it ends.
 */
export async function findProcessorAccountWithWebhook(
  db: Database,
  key: { readonly merchantId: string; readonly id: string },
  options: { readonly forUpdate?: boolean } = {},
): Promise<ProcessorAccountWithWebhook | undefined> {
  let query = db
    .selectFrom('processor_accounts')
    .select([...PUBLIC_COLUMNS, ...WEBHOOK_COLUMNS])
    .where('merchant_id', '=', key.merchantId)
    .where('id', '=', key.id);
  if (options.forUpdate === true) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (row === undefined) return undefined;
  return { account: toProcessorAccount(row), webhook: toWebhook(row) };
}

/**
 * Stores a webhook configuration in place of any other, with its encrypted
 * signing secret, and returns it as stored.
 */
export async function saveProcessorAccountWebhook(
  trx: DatabaseTransaction,
  change: {
    readonly merchantId: string;
    readonly id: string;
    readonly webhook: ProcessorAccountWebhook;
    readonly secret: EncryptedSecret;
    readonly updatedAt: Date;
  },
): Promise<ProcessorAccountWithWebhook | undefined> {
  const row = await trx
    .updateTable('processor_accounts')
    .set({
      webhook_secret_ciphertext: change.secret.ciphertext,
      webhook_secret_iv: change.secret.iv,
      webhook_secret_auth_tag: change.secret.authTag,
      webhook_secret_version: change.secret.keyVersion,
      webhook_secret_hint: change.webhook.signingSecretHint,
      webhook_mode: change.webhook.mode,
      webhook_endpoint_id: change.webhook.endpointId,
      webhook_configured_at: change.webhook.configuredAt,
      updated_at: change.updatedAt,
    })
    .where('merchant_id', '=', change.merchantId)
    .where('id', '=', change.id)
    .returning([...PUBLIC_COLUMNS, ...WEBHOOK_COLUMNS])
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return { account: toProcessorAccount(row), webhook: toWebhook(row) };
}

/** Removes the webhook configuration of an account, secret included. */
export async function clearProcessorAccountWebhook(
  trx: DatabaseTransaction,
  change: {
    readonly merchantId: string;
    readonly id: string;
    readonly updatedAt: Date;
  },
): Promise<ProcessorAccountWithWebhook | undefined> {
  const row = await trx
    .updateTable('processor_accounts')
    .set({
      webhook_secret_ciphertext: null,
      webhook_secret_iv: null,
      webhook_secret_auth_tag: null,
      webhook_secret_version: null,
      webhook_secret_hint: null,
      webhook_mode: null,
      webhook_endpoint_id: null,
      webhook_configured_at: null,
      updated_at: change.updatedAt,
    })
    .where('merchant_id', '=', change.merchantId)
    .where('id', '=', change.id)
    .returning([...PUBLIC_COLUMNS, ...WEBHOOK_COLUMNS])
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return { account: toProcessorAccount(row), webhook: toWebhook(row) };
}

/** An account that receives webhooks, with its encrypted signing secret. */
export interface ProcessorAccountForDelivery {
  readonly account: ProcessorAccount;
  readonly signingSecret: EncryptedSecret | null;
}

/**
 * The account a webhook delivery names, by its id alone, with its encrypted
 * signing secret, or `undefined`. This is the one read of merchant-owned data
 * without a merchant filter: a delivery has no principal, the account id in
 * its URL is the only tenant reference, and nothing read here is trusted until
 * the signature, checked with this account's own secret, proves the sender.
 * Every later read uses the account's merchant.
 */
export async function findProcessorAccountForDelivery(
  db: Database,
  id: string,
): Promise<ProcessorAccountForDelivery | undefined> {
  const row = await db
    .selectFrom('processor_accounts')
    .select([
      ...PUBLIC_COLUMNS,
      'webhook_secret_ciphertext',
      'webhook_secret_iv',
      'webhook_secret_auth_tag',
      'webhook_secret_version',
    ])
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const { webhook_secret_ciphertext, webhook_secret_iv } = row;
  const { webhook_secret_auth_tag, webhook_secret_version } = row;
  return {
    account: toProcessorAccount(row),
    signingSecret:
      webhook_secret_ciphertext === null ||
      webhook_secret_iv === null ||
      webhook_secret_auth_tag === null ||
      webhook_secret_version === null
        ? null
        : {
            ciphertext: webhook_secret_ciphertext,
            iv: webhook_secret_iv,
            authTag: webhook_secret_auth_tag,
            keyVersion: webhook_secret_version,
          },
  };
}
