import type { Database, UserRow } from '@merchantflow/database';
import type { ApiKeyScope } from '../application/api-key-scope.js';
import type { User } from '../application/user.js';

/** The scope of a stored user or key row, which the database constrains. */
export function scopeOfRow(
  table: string,
  row: Pick<UserRow, 'id' | 'merchant_id' | 'role'>,
): ApiKeyScope {
  if (row.merchant_id === null && row.role === 'PLATFORM_ADMIN') {
    return { kind: 'PLATFORM', role: row.role };
  }
  if (row.merchant_id !== null && row.role !== 'PLATFORM_ADMIN') {
    return { kind: 'MERCHANT', merchantId: row.merchant_id, role: row.role };
  }
  // The role and scope check constraint makes this combination impossible.
  throw new Error(`${table} row ${row.id} has an invalid role and scope`);
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    scope: scopeOfRow('users', row),
    passwordHash: row.password_hash,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Inserts a user as given. PostgreSQL rejects a row that breaks a constraint,
 * including a taken email, which surfaces as a thrown database error. Pass the
 * transaction of the creation so that the user and its audit event commit
 * together.
 */
export async function insertUser(db: Database, user: User): Promise<void> {
  await db
    .insertInto('users')
    .values({
      id: user.id,
      email: user.email,
      display_name: user.displayName,
      role: user.scope.role,
      merchant_id:
        user.scope.kind === 'MERCHANT' ? user.scope.merchantId : null,
      password_hash: user.passwordHash,
      enabled: user.enabled,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
    })
    .execute();
}

/** Returns the user with the given lower-case email, or `undefined`. */
export async function findUserByEmail(
  db: Database,
  email: string,
): Promise<User | undefined> {
  const row = await db
    .selectFrom('users')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirst();
  return row === undefined ? undefined : toUser(row);
}

/** Returns the user with the given id, or `undefined`. */
export async function findUserById(
  db: Database,
  id: string,
): Promise<User | undefined> {
  const row = await db
    .selectFrom('users')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row === undefined ? undefined : toUser(row);
}

/**
 * Returns the oldest platform user, enabled or not, or `undefined` when there
 * is none.
 */
export async function findOldestPlatformUser(
  db: Database,
): Promise<User | undefined> {
  const row = await db
    .selectFrom('users')
    .selectAll()
    .where('merchant_id', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? undefined : toUser(row);
}
