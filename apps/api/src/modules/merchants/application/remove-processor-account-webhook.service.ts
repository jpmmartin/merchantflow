import { randomUUID } from 'node:crypto';
import {
  isLockNotAvailable,
  setLocalLockTimeout,
  type Database,
} from '@merchantflow/database';
import type { ProcessorAdapterRegistry } from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import type { Env } from '../../config/env.schema.js';
import { DATABASE } from '../../database/database.module.js';
import { PROCESSOR_REGISTRY } from '../../processors/application/processor-registry.js';
import {
  findMerchantById,
  findMerchantByIdForUpdate,
} from '../infrastructure/merchant-queries.js';
import {
  clearProcessorAccountWebhook,
  findProcessorAccountWithWebhook,
  type ProcessorAccountWithWebhook,
} from '../infrastructure/processor-account-queries.js';
import type { ProcessorAccountWebhookView } from './get-processor-account-webhook.service.js';
import {
  canAddressMerchant,
  canManageMerchantAccess,
} from './merchant-access.js';
import { PROCESSOR_ACCOUNT_LOCK_TIMEOUT_MILLIS } from './processor-account-locking.js';
import { ProcessorAccountsForPaymentsService } from './processor-accounts-for-payments.service.js';
import { sameWebhook } from './webhook-endpoint-cleanup.js';
import { webhookEndpointUrl } from './webhook-endpoint-url.js';

/** Audit action of a removed webhook configuration. */
export const PROCESSOR_ACCOUNT_WEBHOOK_REMOVED =
  'PROCESSOR_ACCOUNT_WEBHOOK_REMOVED';

export interface RemoveProcessorAccountWebhookCommand {
  readonly principal: Principal;
  readonly correlationId: string;
  readonly merchantId: string;
  readonly processorAccountId: string;
}

export type RemoveProcessorAccountWebhookResult =
  | {
      readonly ok: true;
      readonly view: ProcessorAccountWebhookView;
      /** `ALREADY_REMOVED` means nothing changed and nothing was audited. */
      readonly outcome: 'REMOVED' | 'ALREADY_REMOVED';
    }
  | {
      readonly ok: false;
      readonly code:
        | 'NOT_FOUND'
        | 'FORBIDDEN'
        | 'CREDENTIALS_KEY_NOT_CONFIGURED'
        | 'PROVIDER_UNSUPPORTED'
        | 'PROCESSOR_UNAVAILABLE'
        | 'CONFIGURATION_CHANGED'
        | 'LOCK_TIMEOUT';
    };

/**
 * Removes the webhook configuration of a processor account, enabled or not.
 * The platform administrator may do it for any merchant, and
 * `MERCHANT_ADMIN` for its own. An endpoint the platform created is deleted at
 * the provider first, with no transaction open; if the provider gives no
 * usable answer, nothing changes and the request can be repeated. Then one
 * short transaction locks the merchant and the account, checks that the
 * configuration is still the one read, clears it, signing secret included,
 * and writes `PROCESSOR_ACCOUNT_WEBHOOK_REMOVED`. From then on every delivery
 * for the account is refused. Removing an account without a configuration
 * succeeds and changes nothing.
 */
@Injectable()
export class RemoveProcessorAccountWebhookService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROCESSOR_REGISTRY)
    private readonly registry: ProcessorAdapterRegistry,
    private readonly accounts: ProcessorAccountsForPaymentsService,
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RemoveProcessorAccountWebhookService.name);
  }

  async execute(
    command: RemoveProcessorAccountWebhookCommand,
  ): Promise<RemoveProcessorAccountWebhookResult> {
    const { principal } = command;
    if (!canAddressMerchant(principal, command.merchantId)) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (!canManageMerchantAccess(principal)) {
      return { ok: false, code: 'FORBIDDEN' };
    }
    if (
      (await findMerchantById(this.database, command.merchantId)) === undefined
    ) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    const key = {
      merchantId: command.merchantId,
      id: command.processorAccountId,
    };
    const before = await findProcessorAccountWithWebhook(this.database, key);
    if (before === undefined) return { ok: false, code: 'NOT_FOUND' };
    const publicBaseUrl = this.config.get('PUBLIC_API_BASE_URL', {
      infer: true,
    });
    const viewOf = (found: ProcessorAccountWithWebhook) => ({
      account: found.account,
      webhook: found.webhook,
      endpointUrl: webhookEndpointUrl(publicBaseUrl, found.account),
    });
    if (before.webhook === null) {
      return { ok: true, outcome: 'ALREADY_REMOVED', view: viewOf(before) };
    }

    const endpointId = before.webhook.endpointId;
    if (endpointId !== null) {
      const adapter = this.registry.findWithCapability(
        before.account.provider,
        'WEBHOOKS',
      );
      if (adapter === undefined) {
        return { ok: false, code: 'PROVIDER_UNSUPPORTED' };
      }
      const resolved = await this.accounts.forExistingPayment(this.database, {
        merchantId: command.merchantId,
        processorAccountId: command.processorAccountId,
      });
      if (!resolved.ok) {
        if (resolved.code === 'CREDENTIALS_KEY_NOT_CONFIGURED') {
          return { ok: false, code: 'CREDENTIALS_KEY_NOT_CONFIGURED' };
        }
        throw new Error(
          `processor account ${command.processorAccountId} disappeared: ${resolved.code}`,
        );
      }
      const deletion = await adapter.deleteWebhookEndpoint({
        credentials: resolved.account.credentials,
        endpointId,
      });
      if (deletion.outcome === 'unavailable') {
        this.logger.warn(
          {
            processorAccountId: before.account.id,
            webhookEndpointId: endpointId,
            category: deletion.category,
            correlationId: command.correlationId,
          },
          'webhook endpoint could not be deleted; the configuration is kept',
        );
        return { ok: false, code: 'PROCESSOR_UNAVAILABLE' };
      }
    }

    const now = this.clock.now();
    let result: RemoveProcessorAccountWebhookResult;
    try {
      result = await this.database.transaction().execute(async (trx) => {
        await setLocalLockTimeout(trx, PROCESSOR_ACCOUNT_LOCK_TIMEOUT_MILLIS);
        if (
          (await findMerchantByIdForUpdate(trx, command.merchantId)) ===
          undefined
        ) {
          return { ok: false, code: 'NOT_FOUND' } as const;
        }
        const current = await findProcessorAccountWithWebhook(trx, key, {
          forUpdate: true,
        });
        if (current === undefined) {
          return { ok: false, code: 'NOT_FOUND' } as const;
        }
        if (!sameWebhook(current.webhook, before.webhook)) {
          return { ok: false, code: 'CONFIGURATION_CHANGED' } as const;
        }
        const cleared = await clearProcessorAccountWebhook(trx, {
          ...key,
          updatedAt: now,
        });
        if (cleared === undefined) {
          throw new Error(
            `processor account ${command.processorAccountId} disappeared under its row lock`,
          );
        }
        await appendAuditEvent(trx, {
          id: randomUUID(),
          occurredAt: now,
          ...auditActorOf(principal),
          action: PROCESSOR_ACCOUNT_WEBHOOK_REMOVED,
          targetType: 'PROCESSOR_ACCOUNT',
          targetId: current.account.id,
          merchantId: command.merchantId,
          correlationId: command.correlationId,
          metadata: {
            provider: current.account.provider,
            previous_mode: current.webhook?.mode ?? null,
            previous_webhook_endpoint_id: current.webhook?.endpointId ?? null,
          },
        });
        return { ok: true, outcome: 'REMOVED', view: viewOf(cleared) } as const;
      });
    } catch (error) {
      if (isLockNotAvailable(error)) return { ok: false, code: 'LOCK_TIMEOUT' };
      throw error;
    }
    if (result.ok) {
      this.logger.info(
        {
          processorAccountId: before.account.id,
          merchantId: command.merchantId,
          webhookEndpointId: endpointId,
          correlationId: command.correlationId,
        },
        'processor account webhook removed',
      );
    }
    return result;
  }
}
