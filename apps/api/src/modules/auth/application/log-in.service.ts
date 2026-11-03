import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { findUserByEmail } from '../infrastructure/user-queries.js';
import { insertUserSession } from '../infrastructure/user-session-queries.js';
import { hashPassword, verifyPassword } from './password-hash.js';
import { SESSION_LIFETIME_MS, SESSION_TOKEN_FORMAT } from './session-token.js';
import { normalizeEmail } from './user-email.js';
import { summarizeUser, type UserSummary } from './user.js';
import type { UserSession } from './user-session.js';

export interface LogInCommand {
  readonly email: string;
  readonly password: string;
  readonly correlationId: string;
}

export type LogInResult =
  | {
      readonly ok: true;
      /** The session token. This is the only time it exists outside the caller. */
      readonly token: string;
      readonly expiresAt: Date;
      readonly sessionId: string;
      readonly user: UserSummary;
    }
  | { readonly ok: false; readonly code: 'INVALID_CREDENTIALS' };

/**
 * Signs a user in with an email and a password and opens a session.
 *
 * Every failure is the same `INVALID_CREDENTIALS` result, and every attempt
 * runs exactly one scrypt comparison: an unknown or unstorable email is
 * compared against a hash of a random password, and a disabled user's
 * password is still compared, so neither the answer nor its timing tells
 * whether an email exists or is enabled.
 *
 * The session and its `USER_SESSION_CREATED` audit event commit together. The
 * token is generated here, returned once, and stored only as a hash.
 */
@Injectable()
export class LogInService {
  /** Hash that stands in for a user's hash when the email is unknown. */
  private decoyHash: Promise<string> | undefined;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LogInService.name);
  }

  async execute(command: LogInCommand): Promise<LogInResult> {
    const email = normalizeEmail(command.email);
    const user =
      email === undefined
        ? undefined
        : await findUserByEmail(this.database, email);
    const matches = await verifyPassword(
      command.password,
      user?.passwordHash ?? (await this.decoy()),
    );
    if (user === undefined || !matches || !user.enabled) {
      this.logger.info(
        { correlationId: command.correlationId },
        'sign-in refused',
      );
      return { ok: false, code: 'INVALID_CREDENTIALS' };
    }

    const now = this.clock.now();
    const generated = SESSION_TOKEN_FORMAT.generate();
    const session: UserSession = {
      id: randomUUID(),
      userId: user.id,
      lookupId: generated.lookupId,
      secretHash: generated.secretHash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
      revokedAt: null,
    };
    await this.database.transaction().execute(async (trx) => {
      await insertUserSession(trx, session);
      await appendAuditEvent(trx, {
        id: randomUUID(),
        occurredAt: now,
        actorType: 'USER',
        actorId: user.id,
        action: 'USER_SESSION_CREATED',
        targetType: 'USER_SESSION',
        targetId: session.id,
        merchantId:
          user.scope.kind === 'MERCHANT' ? user.scope.merchantId : null,
        correlationId: command.correlationId,
        metadata: { expires_at: session.expiresAt.toISOString() },
      });
    });

    this.logger.info(
      {
        userId: user.id,
        sessionId: session.id,
        correlationId: command.correlationId,
      },
      'user signed in',
    );
    return {
      ok: true,
      token: generated.token,
      expiresAt: session.expiresAt,
      sessionId: session.id,
      user: summarizeUser(user),
    };
  }

  /**
   * A hash of a random password with the current parameters, made once per
   * process and kept, so an unknown email costs the same derivation as a known
   * one. No password can match it.
   */
  private decoy(): Promise<string> {
    this.decoyHash ??= hashPassword(randomBytes(32).toString('hex'));
    return this.decoyHash;
  }
}
