import type { ApiKeyScope } from './api-key-scope.js';

/** A stored user. It holds the password hash, never the password. */
export interface User {
  readonly id: string;
  /** Sign-in identifier, in lower case. */
  readonly email: string;
  readonly displayName: string;
  /** Same role and merchant pairing as an API key. */
  readonly scope: ApiKeyScope;
  /** scrypt hash in PHC string format. */
  readonly passwordHash: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What may leave the auth module about a user: no password hash. */
export type UserSummary = Omit<User, 'passwordHash'>;

/** A user without its password hash. */
export function summarizeUser(user: User): UserSummary {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    scope: user.scope,
    enabled: user.enabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
