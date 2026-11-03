import { opaqueTokenFormat } from './opaque-token.js';

/**
 * Session token format: `mfs_<lookup id>_<secret>`, the same shape as an API
 * key (`mfk_`) with its own prefix, so the guard can tell the two apart from
 * the token alone. Only the lookup id and the SHA-256 hash of the secret are
 * stored; the token exists only in the login response.
 */
export const SESSION_TOKEN_PREFIX = 'mfs';

export const SESSION_TOKEN_FORMAT = opaqueTokenFormat(SESSION_TOKEN_PREFIX);

/**
 * Absolute lifetime of a session: 8 hours from sign-in, a working day. A
 * session is never extended; after it expires the user signs in again.
 */
export const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;

/** Whether a bearer token claims to be a session token, by its prefix alone. */
export function isSessionToken(presented: string): boolean {
  return presented.startsWith(`${SESSION_TOKEN_PREFIX}_`);
}
