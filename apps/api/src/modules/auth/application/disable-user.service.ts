import { randomUUID } from 'node:crypto';
import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { AuditEvent } from '../../audit/application/audit-event.js';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import {
  disableEnabledUser,
  findUserOfMerchant,
} from '../infrastructure/user-queries.js';
import { revokeActiveSessionsOfUser } from '../infrastructure/user-session-queries.js';
import { summarizeUser, type UserSummary } from './user.js';

export interface DisableUserCommand {
  readonly actor: Pick<AuditEvent, 'actorType' | 'actorId'>;
  readonly merchantId: string;
  readonly userId: string;
  readonly correlationId: string;
}

export type DisableUserResult =
  | {
      readonly ok: true;
      readonly user: UserSummary;
      /** `ALREADY_DISABLED` means nothing changed and nothing was audited. */
      readonly outcome: 'DISABLED' | 'ALREADY_DISABLED';
    }
  | { readonly ok: false; readonly code: 'USER_NOT_FOUND' };

/**
 * Disables a user of a merchant. In one transaction it clears `enabled` with a
 * conditional update, revokes every active session of the user, and writes
 * `USER_DISABLED` with the number of sessions it revoked, so the user cannot
 * act again after the commit. A user of another merchant, a platform user, and
 * an unknown id are all "not found". Disabling a disabled user succeeds
 * without a change.
 */
@Injectable()
export class DisableUserService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DisableUserService.name);
  }

  async execute(command: DisableUserCommand): Promise<DisableUserResult> {
    const now = this.clock.now();
    const key = { id: command.userId, merchantId: command.merchantId };
    const result = await this.database
      .transaction()
      .execute(async (trx): Promise<DisableUserResult> => {
        const disabled = await disableEnabledUser(trx, {
          ...key,
          updatedAt: now,
        });
        if (disabled === undefined) {
          const existing = await findUserOfMerchant(trx, key);
          return existing === undefined
            ? { ok: false, code: 'USER_NOT_FOUND' }
            : {
                ok: true,
                outcome: 'ALREADY_DISABLED',
                user: summarizeUser(existing),
              };
        }
        const revokedSessions = await revokeActiveSessionsOfUser(trx, {
          userId: disabled.id,
          revokedAt: now,
        });
        await appendAuditEvent(trx, {
          id: randomUUID(),
          occurredAt: now,
          actorType: command.actor.actorType,
          actorId: command.actor.actorId,
          action: 'USER_DISABLED',
          targetType: 'USER',
          targetId: disabled.id,
          merchantId: command.merchantId,
          correlationId: command.correlationId,
          metadata: { revoked_sessions: revokedSessions },
        });
        return { ok: true, outcome: 'DISABLED', user: summarizeUser(disabled) };
      });

    if (result.ok) {
      this.logger.info(
        {
          userId: result.user.id,
          merchantId: command.merchantId,
          outcome: result.outcome,
          correlationId: command.correlationId,
        },
        'user disabled',
      );
    }
    return result;
  }
}
