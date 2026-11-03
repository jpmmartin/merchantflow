import { randomUUID } from 'node:crypto';
import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { revokeActiveUserSession } from '../infrastructure/user-session-queries.js';
import type { Principal } from './principal.js';

export interface LogOutCommand {
  readonly principal: Principal;
  readonly correlationId: string;
}

export type LogOutResult =
  | {
      readonly ok: true;
      /** `ALREADY_REVOKED`: a concurrent sign-out got there first. */
      readonly outcome: 'REVOKED' | 'ALREADY_REVOKED';
    }
  | { readonly ok: false; readonly code: 'SESSION_REQUIRED' };

/**
 * Signs the current session out: it revokes the session the request
 * authenticated with and writes `USER_SESSION_REVOKED` in the same
 * transaction. It applies only to sessions; an API key principal is refused
 * and its key is not touched.
 */
@Injectable()
export class LogOutService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LogOutService.name);
  }

  async execute(command: LogOutCommand): Promise<LogOutResult> {
    const { principal } = command;
    if (principal.source !== 'USER') {
      return { ok: false, code: 'SESSION_REQUIRED' };
    }
    const now = this.clock.now();
    const outcome = await this.database
      .transaction()
      .execute(async (trx): Promise<'REVOKED' | 'ALREADY_REVOKED'> => {
        const revoked = await revokeActiveUserSession(trx, {
          id: principal.sessionId,
          revokedAt: now,
        });
        if (!revoked) return 'ALREADY_REVOKED';
        await appendAuditEvent(trx, {
          id: randomUUID(),
          occurredAt: now,
          actorType: 'USER',
          actorId: principal.userId,
          action: 'USER_SESSION_REVOKED',
          targetType: 'USER_SESSION',
          targetId: principal.sessionId,
          merchantId:
            principal.kind === 'MERCHANT' ? principal.merchantId : null,
          correlationId: command.correlationId,
          metadata: {},
        });
        return 'REVOKED';
      });

    this.logger.info(
      {
        userId: principal.userId,
        sessionId: principal.sessionId,
        outcome,
        correlationId: command.correlationId,
      },
      'user signed out',
    );
    return { ok: true, outcome };
  }
}
