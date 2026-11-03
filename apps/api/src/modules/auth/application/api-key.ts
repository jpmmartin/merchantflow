import type { ApiKeyScope } from './api-key-scope.js';

/** A stored API key. It holds the hash of the secret, never the key. */
export interface ApiKey {
  readonly id: string;
  /** Public identifier embedded in the key. */
  readonly lookupId: string;
  /** SHA-256 of the secret part of the key, in lowercase hexadecimal. */
  readonly secretHash: string;
  readonly scope: ApiKeyScope;
  readonly createdAt: Date;
  /** `null` while the key is active. */
  readonly revokedAt: Date | null;
}
