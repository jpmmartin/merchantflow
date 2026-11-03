import type { Database } from '@merchantflow/database';
import type { User } from '../application/user.js';
import type { UserSession } from '../application/user-session.js';
import { toUser } from './user-queries.js';

/**
 * Inserts a session as given. Pass the transaction of the sign-in so that the
 * session and its audit event commit together.
 */
export async function insertUserSession(
  db: Database,
  session: UserSession,
): Promise<void> {
  await db
    .insertInto('user_sessions')
    .values({
      id: session.id,
      user_id: session.userId,
      lookup_id: session.lookupId,
      secret_hash: session.secretHash,
      created_at: session.createdAt,
      expires_at: session.expiresAt,
      revoked_at: session.revokedAt,
    })
    .execute();
}

/**
 * Returns the session with the given lookup id together with its user, read
 * in one query, or `undefined` when no session has that lookup id. The user's
 * current role, merchant, and enabled state come from the same read.
 */
export async function findUserSessionByLookupId(
  db: Database,
  lookupId: string,
): Promise<{ readonly session: UserSession; readonly user: User } | undefined> {
  const row = await db
    .selectFrom('user_sessions')
    .innerJoin('users', 'users.id', 'user_sessions.user_id')
    .select([
      'user_sessions.id as session_id',
      'user_sessions.user_id as session_user_id',
      'user_sessions.lookup_id as session_lookup_id',
      'user_sessions.secret_hash as session_secret_hash',
      'user_sessions.created_at as session_created_at',
      'user_sessions.expires_at as session_expires_at',
      'user_sessions.revoked_at as session_revoked_at',
      'users.id',
      'users.email',
      'users.display_name',
      'users.role',
      'users.merchant_id',
      'users.password_hash',
      'users.enabled',
      'users.created_at',
      'users.updated_at',
    ])
    .where('user_sessions.lookup_id', '=', lookupId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    session: {
      id: row.session_id,
      userId: row.session_user_id,
      lookupId: row.session_lookup_id,
      secretHash: row.session_secret_hash,
      createdAt: row.session_created_at,
      expiresAt: row.session_expires_at,
      revokedAt: row.session_revoked_at,
    },
    user: toUser(row),
  };
}

/**
 * Revokes a session only if it is still active, and returns whether it did.
 * Of two concurrent calls exactly one revokes it.
 */
export async function revokeActiveUserSession(
  db: Database,
  change: { readonly id: string; readonly revokedAt: Date },
): Promise<boolean> {
  const result = await db
    .updateTable('user_sessions')
    .set({ revoked_at: change.revokedAt })
    .where('id', '=', change.id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}

/**
 * Revokes every active session of a user and returns how many it revoked.
 * Sessions that are already revoked keep their original time. Pass the
 * transaction that disables the user, so both commit together.
 */
export async function revokeActiveSessionsOfUser(
  db: Database,
  change: { readonly userId: string; readonly revokedAt: Date },
): Promise<number> {
  const result = await db
    .updateTable('user_sessions')
    .set({ revoked_at: change.revokedAt })
    .where('user_id', '=', change.userId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
