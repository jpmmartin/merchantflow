import type { AuditEvent } from '../../audit/application/audit-event.js';
import type { ApiKeyScope } from './api-key-scope.js';

/**
 * Where a principal's authority comes from: an API key, or the session of a
 * signed-in user. Narrow on `source` to read the identifier of the other kind;
 * `apiKeyId` is readable on every principal and is `undefined` for a user.
 */
export type PrincipalCredential =
  | {
      readonly source: 'API_KEY';
      /** Identifier of the key row. It is not part of the key a caller presents. */
      readonly apiKeyId: string;
      readonly userId?: never;
      readonly sessionId?: never;
    }
  | {
      readonly source: 'USER';
      /** Identifier of the user row. */
      readonly userId: string;
      /** Identifier of the session row. It is not part of the token. */
      readonly sessionId: string;
      readonly apiKeyId?: never;
    };

/**
 * The authenticated caller of a request. It comes only from the stored key or
 * from the stored user of a session: a merchant principal carries the merchant
 * of its key or user, and nothing in the request (path, query, body, or
 * header) can change it. Narrow on `kind` to tell a platform principal from a
 * merchant one; users and keys share the same role and merchant pairing.
 */
export type Principal = ApiKeyScope & PrincipalCredential;

/**
 * The actor recorded on the audit event of a request: the key that made it, or
 * the signed-in user.
 */
export function auditActorOf(
  principal: Principal,
): Pick<AuditEvent, 'actorType' | 'actorId'> {
  switch (principal.source) {
    case 'API_KEY':
      return { actorType: 'API_KEY', actorId: principal.apiKeyId };
    case 'USER':
      return { actorType: 'USER', actorId: principal.userId };
  }
}
