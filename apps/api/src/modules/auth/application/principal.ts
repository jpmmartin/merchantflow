import type { ApiKeyScope } from './api-key-scope.js';

/**
 * The authenticated caller of a request. It comes only from the stored key: a
 * merchant principal carries the merchant of its key, and nothing in the
 * request (path, query, body, or header) can change it. Narrow on `kind` to
 * tell a platform key from a merchant key.
 */
export type Principal = ApiKeyScope & {
  /** Identifier of the key row. It is not part of the key a caller presents. */
  readonly apiKeyId: string;
};
