import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@merchantflow/database';
import { DATABASE } from '../../database/database.module.js';
import { findApiKeyByLookupId } from '../infrastructure/api-key-queries.js';
import {
  hashApiKeySecret,
  parseApiKey,
  verifyApiKeySecret,
} from './api-key-secret.js';
import type { Principal } from './principal.js';

export type AuthenticationResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly code: 'UNAUTHENTICATED' };

/**
 * Hash that stands in for the stored one when the lookup id is unknown, so an
 * unknown key costs the same comparison as a wrong secret.
 */
const UNKNOWN_KEY_HASH = hashApiKeySecret('unknown-api-key');

/**
 * Turns a presented key into a principal. Every failure is the same
 * `UNAUTHENTICATED` result: a key that is malformed, unknown, wrong, or
 * revoked is not told apart, so a caller learns nothing about which keys exist.
 *
 * Revocation is read from the database on every call and never cached, so a
 * revoked key stops working with its next request. The merchant's status is
 * deliberately not read: a key of a `DRAFT` or `SUSPENDED` merchant
 * authenticates, and the use case of each command decides what the status
 * allows.
 */
@Injectable()
export class AuthenticateApiKeyService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(presentedKey: string): Promise<AuthenticationResult> {
    const parsed = parseApiKey(presentedKey);
    if (parsed === undefined) {
      return { ok: false, code: 'UNAUTHENTICATED' };
    }
    const apiKey = await findApiKeyByLookupId(this.database, parsed.lookupId);
    const secretMatches = verifyApiKeySecret(
      parsed.secret,
      apiKey?.secretHash ?? UNKNOWN_KEY_HASH,
    );
    if (apiKey === undefined || !secretMatches || apiKey.revokedAt !== null) {
      return { ok: false, code: 'UNAUTHENTICATED' };
    }
    return {
      ok: true,
      principal: { ...apiKey.scope, apiKeyId: apiKey.id },
    };
  }
}
