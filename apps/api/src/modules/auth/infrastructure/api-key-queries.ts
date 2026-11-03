import type { ApiKeyRow, Database } from '@merchantflow/database';
import type { ApiKey } from '../application/api-key.js';

function toRow(apiKey: ApiKey) {
  return {
    id: apiKey.id,
    lookup_id: apiKey.lookupId,
    secret_hash: apiKey.secretHash,
    merchant_id:
      apiKey.scope.kind === 'MERCHANT' ? apiKey.scope.merchantId : null,
    role: apiKey.scope.role,
    created_at: apiKey.createdAt,
    revoked_at: apiKey.revokedAt,
  };
}

function toApiKey(row: ApiKeyRow): ApiKey {
  const base = {
    id: row.id,
    lookupId: row.lookup_id,
    secretHash: row.secret_hash,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
  if (row.merchant_id === null && row.role === 'PLATFORM_ADMIN') {
    return { ...base, scope: { kind: 'PLATFORM', role: row.role } };
  }
  if (row.merchant_id !== null && row.role !== 'PLATFORM_ADMIN') {
    return {
      ...base,
      scope: { kind: 'MERCHANT', merchantId: row.merchant_id, role: row.role },
    };
  }
  // api_keys_role_scope_check makes this combination impossible to store.
  throw new Error(`api_keys row ${row.id} has an invalid role and scope`);
}

/**
 * Inserts a key as given. PostgreSQL rejects a row that breaks a constraint,
 * which surfaces as a thrown database error. Pass the transaction of the
 * issuance so that the key and its audit event commit together.
 */
export async function insertApiKey(
  db: Database,
  apiKey: ApiKey,
): Promise<void> {
  await db.insertInto('api_keys').values(toRow(apiKey)).execute();
}

/** Returns the key with the given id, or `undefined` when none exists. */
export async function findApiKeyById(
  db: Database,
  id: string,
): Promise<ApiKey | undefined> {
  const row = await db
    .selectFrom('api_keys')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row === undefined ? undefined : toApiKey(row);
}

/** Returns the key with the given lookup id, or `undefined` when none exists. */
export async function findApiKeyByLookupId(
  db: Database,
  lookupId: string,
): Promise<ApiKey | undefined> {
  const row = await db
    .selectFrom('api_keys')
    .selectAll()
    .where('lookup_id', '=', lookupId)
    .executeTakeFirst();
  return row === undefined ? undefined : toApiKey(row);
}

/**
 * Revokes a key only if it is still active, and returns the revoked key. It
 * returns `undefined` when the key does not exist or was already revoked, and
 * in that case it changes nothing. Of two concurrent calls exactly one gets the
 * key back.
 */
export async function revokeActiveApiKey(
  db: Database,
  change: { readonly id: string; readonly revokedAt: Date },
): Promise<ApiKey | undefined> {
  const row = await db
    .updateTable('api_keys')
    .set({ revoked_at: change.revokedAt })
    .where('id', '=', change.id)
    .where('revoked_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? undefined : toApiKey(row);
}

/**
 * Returns the oldest active platform key, or `undefined` when there is none. A
 * revoked key does not count.
 */
export async function findActivePlatformApiKey(
  db: Database,
): Promise<ApiKey | undefined> {
  const row = await db
    .selectFrom('api_keys')
    .selectAll()
    .where('merchant_id', 'is', null)
    .where('revoked_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? undefined : toApiKey(row);
}
