import { randomUUID } from 'node:crypto';
import { type Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { AuditEvent } from '../../audit/application/audit-event.js';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import {
  findApiKeyById,
  revokeActiveApiKey,
} from '../infrastructure/api-key-queries.js';

export interface RevokeApiKeyCommand {
  /** Who revokes the key. Authentication does not exist yet, so the caller says. */
  readonly actor: Pick<AuditEvent, 'actorType' | 'actorId'>;
  readonly apiKeyId: string;
  readonly correlationId: string;
}

export type RevokeApiKeyResult =
  | {
      readonly ok: true;
      /** `ALREADY_REVOKED` means nothing changed and nothing was audited. */
      readonly outcome: 'REVOKED' | 'ALREADY_REVOKED';
      /** When the key was revoked: now, or the earlier revocation. */
      readonly revokedAt: Date;
    }
  | { readonly ok: false; readonly code: 'API_KEY_NOT_FOUND' };

/**
 * Revokes an API key and writes its audit event in one transaction. Revoking
 * an already revoked key changes nothing, writes no audit event, and reports
 * `ALREADY_REVOKED`. Revocation does not depend on the merchant's status, so a
 * compromised key can always be cut off.
 */
@Injectable()
export class RevokeApiKeyService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RevokeApiKeyService.name);
  }

  async execute(command: RevokeApiKeyCommand): Promise<RevokeApiKeyResult> {
    const now = this.clock.now();

    const result = await this.database
      .transaction()
      .execute(async (trx): Promise<RevokeApiKeyResult> => {
        const revoked = await revokeActiveApiKey(trx, {
          id: command.apiKeyId,
          revokedAt: now,
        });
        if (revoked === undefined) {
          // The conditional update matched nothing: either the key does not
          // exist or another revocation got there first.
          const existing = await findApiKeyById(trx, command.apiKeyId);
          if (existing === undefined) {
            return { ok: false, code: 'API_KEY_NOT_FOUND' };
          }
          if (existing.revokedAt === null) {
            // The conditional update only skips an active key if it was
            // revoked meanwhile, and a revocation is never undone.
            throw new Error(
              `api key ${existing.id} is active but was not revoked`,
            );
          }
          return {
            ok: true,
            outcome: 'ALREADY_REVOKED',
            revokedAt: existing.revokedAt,
          };
        }

        await appendAuditEvent(trx, {
          id: randomUUID(),
          occurredAt: now,
          actorType: command.actor.actorType,
          actorId: command.actor.actorId,
          action: 'API_KEY_REVOKED',
          targetType: 'API_KEY',
          targetId: revoked.id,
          merchantId:
            revoked.scope.kind === 'MERCHANT' ? revoked.scope.merchantId : null,
          correlationId: command.correlationId,
          metadata: {
            lookup_id: revoked.lookupId,
            role: revoked.scope.role,
            scope: revoked.scope.kind,
          },
        });
        return { ok: true, outcome: 'REVOKED', revokedAt: now };
      });

    if (result.ok) {
      this.logger.info(
        {
          apiKeyId: command.apiKeyId,
          outcome: result.outcome,
          correlationId: command.correlationId,
        },
        'api key revocation processed',
      );
    }
    return result;
  }
}
