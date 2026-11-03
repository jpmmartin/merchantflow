import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { findUserSessionByLookupId } from '../infrastructure/user-session-queries.js';
import type { AuthenticationResult } from './authenticate-api-key.service.js';
import { hashTokenSecret, verifyTokenSecret } from './opaque-token.js';
import { SESSION_TOKEN_FORMAT } from './session-token.js';

/**
 * Hash that stands in for the stored one when the lookup id is unknown, so an
 * unknown session costs the same comparison as a wrong secret.
 */
const UNKNOWN_SESSION_HASH = hashTokenSecret('unknown-session-token');

/**
 * Turns a presented session token into a principal. Every failure is the same
 * `UNAUTHENTICATED` result an invalid API key gets: a token that is malformed,
 * unknown, wrong, revoked, or expired, and a session of a disabled user, are
 * not told apart.
 *
 * The session and its user are read in one query on every call and never
 * cached, so sign-out, expiry, and disabling the user take effect at the next
 * request, and the role and merchant always come from the stored user.
 */
@Injectable()
export class AuthenticateSessionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(presentedToken: string): Promise<AuthenticationResult> {
    const parsed = SESSION_TOKEN_FORMAT.parse(presentedToken);
    if (parsed === undefined) {
      return { ok: false, code: 'UNAUTHENTICATED' };
    }
    const found = await findUserSessionByLookupId(
      this.database,
      parsed.lookupId,
    );
    const secretMatches = verifyTokenSecret(
      parsed.secret,
      found?.session.secretHash ?? UNKNOWN_SESSION_HASH,
    );
    if (
      found === undefined ||
      !secretMatches ||
      found.session.revokedAt !== null ||
      found.session.expiresAt.getTime() <= this.clock.now().getTime() ||
      !found.user.enabled
    ) {
      return { ok: false, code: 'UNAUTHENTICATED' };
    }
    return {
      ok: true,
      principal: {
        ...found.user.scope,
        source: 'USER',
        userId: found.user.id,
        sessionId: found.session.id,
      },
    };
  }
}
