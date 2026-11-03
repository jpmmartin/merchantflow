import { randomUUID } from 'node:crypto';
import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { AuditEvent } from '../../audit/application/audit-event.js';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../infrastructure/constraint-violation.js';
import { insertUser } from '../infrastructure/user-queries.js';
import type { ApiKeyScope } from './api-key-scope.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hashPassword,
} from './password-hash.js';
import { normalizeEmail } from './user-email.js';
import { summarizeUser, type User, type UserSummary } from './user.js';

/** Longest display name, the column bound. */
const DISPLAY_NAME_MAX_LENGTH = 100;

export interface CreateUserCommand {
  readonly actor: Pick<AuditEvent, 'actorType' | 'actorId'>;
  readonly email: string;
  readonly displayName: string;
  readonly scope: ApiKeyScope;
  /** The initial password. It is hashed here and never stored or logged. */
  readonly password: string;
  readonly correlationId: string;
}

export type CreateUserResult =
  | { readonly ok: true; readonly user: UserSummary }
  | {
      readonly ok: false;
      readonly code:
        | 'INVALID_EMAIL'
        | 'INVALID_DISPLAY_NAME'
        | 'INVALID_PASSWORD'
        | 'EMAIL_TAKEN'
        | 'MERCHANT_NOT_FOUND';
    };

/**
 * Creates an enabled user and writes its `USER_CREATED` audit event in one
 * transaction. The email is stored in lower case; a password needs at least
 * 12 characters. The password is hashed before the transaction opens, so the
 * key derivation never holds a connection.
 */
@Injectable()
export class CreateUserService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CreateUserService.name);
  }

  async execute(command: CreateUserCommand): Promise<CreateUserResult> {
    const email = normalizeEmail(command.email);
    if (email === undefined) return { ok: false, code: 'INVALID_EMAIL' };
    const displayName = command.displayName.trim();
    if (
      displayName.length === 0 ||
      displayName.length > DISPLAY_NAME_MAX_LENGTH
    ) {
      return { ok: false, code: 'INVALID_DISPLAY_NAME' };
    }
    if (
      command.password.length < PASSWORD_MIN_LENGTH ||
      command.password.length > PASSWORD_MAX_LENGTH
    ) {
      return { ok: false, code: 'INVALID_PASSWORD' };
    }

    const passwordHash = await hashPassword(command.password);
    const now = this.clock.now();
    const user: User = {
      id: randomUUID(),
      email,
      displayName,
      scope: command.scope,
      passwordHash,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const merchantId =
      command.scope.kind === 'MERCHANT' ? command.scope.merchantId : null;

    try {
      await this.database.transaction().execute(async (trx) => {
        await insertUser(trx, user);
        await appendAuditEvent(trx, {
          id: randomUUID(),
          occurredAt: now,
          actorType: command.actor.actorType,
          actorId: command.actor.actorId,
          action: 'USER_CREATED',
          targetType: 'USER',
          targetId: user.id,
          merchantId,
          correlationId: command.correlationId,
          metadata: { role: command.scope.role, scope: command.scope.kind },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'users_email_key')) {
        return { ok: false, code: 'EMAIL_TAKEN' };
      }
      if (isForeignKeyViolation(error, 'users_merchant_id_fkey')) {
        return { ok: false, code: 'MERCHANT_NOT_FOUND' };
      }
      throw error;
    }

    this.logger.info(
      {
        userId: user.id,
        role: command.scope.role,
        merchantId,
        correlationId: command.correlationId,
      },
      'user created',
    );
    return { ok: true, user: summarizeUser(user) };
  }
}
