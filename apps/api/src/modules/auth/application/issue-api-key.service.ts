import { randomUUID } from 'node:crypto';
import { type Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { AuditEvent } from '../../audit/application/audit-event.js';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { insertApiKey } from '../infrastructure/api-key-queries.js';
import { isForeignKeyViolation } from '../infrastructure/constraint-violation.js';
import type { ApiKey } from './api-key.js';
import { generateApiKey } from './api-key-secret.js';
import type { ApiKeyScope } from './api-key-scope.js';

export interface IssueApiKeyCommand {
  /** Who issues the key. Authentication does not exist yet, so the caller says. */
  readonly actor: Pick<AuditEvent, 'actorType' | 'actorId'>;
  readonly scope: ApiKeyScope;
  readonly correlationId: string;
}

export type IssueApiKeyResult =
  | {
      readonly ok: true;
      /** The stored key. It holds the hash, never the secret. */
      readonly apiKey: ApiKey;
      /** The full key. This is the only time it exists outside the caller. */
      readonly key: string;
    }
  | { readonly ok: false; readonly code: 'MERCHANT_NOT_FOUND' };

/**
 * Issues an API key and writes its audit event in one transaction. The key is
 * issued whatever the merchant's status: the status is checked when a request
 * is authorized, and a suspended or draft merchant still needs its credentials
 * created or replaced. The full key is returned to the caller and appears
 * nowhere else: not in the database, the audit metadata, or the logs.
 */
@Injectable()
export class IssueApiKeyService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IssueApiKeyService.name);
  }

  async execute(command: IssueApiKeyCommand): Promise<IssueApiKeyResult> {
    const now = this.clock.now();
    const generated = generateApiKey();
    const apiKey: ApiKey = {
      id: randomUUID(),
      lookupId: generated.lookupId,
      secretHash: generated.secretHash,
      scope: command.scope,
      createdAt: now,
      revokedAt: null,
    };
    const merchantId =
      command.scope.kind === 'MERCHANT' ? command.scope.merchantId : null;

    try {
      await this.database.transaction().execute(async (trx) => {
        await insertApiKey(trx, apiKey);
        await appendAuditEvent(trx, {
          id: randomUUID(),
          occurredAt: now,
          actorType: command.actor.actorType,
          actorId: command.actor.actorId,
          action: 'API_KEY_ISSUED',
          targetType: 'API_KEY',
          targetId: apiKey.id,
          merchantId,
          correlationId: command.correlationId,
          metadata: {
            lookup_id: apiKey.lookupId,
            role: command.scope.role,
            scope: command.scope.kind,
          },
        });
      });
    } catch (error) {
      // The foreign key is the authority on whether the merchant exists, so
      // there is no separate read that could race with it.
      if (isForeignKeyViolation(error, 'api_keys_merchant_id_fkey')) {
        return { ok: false, code: 'MERCHANT_NOT_FOUND' };
      }
      throw error;
    }

    this.logger.info(
      {
        apiKeyId: apiKey.id,
        lookupId: apiKey.lookupId,
        role: command.scope.role,
        merchantId,
        correlationId: command.correlationId,
      },
      'api key issued',
    );
    return { ok: true, apiKey, key: generated.key };
  }
}
