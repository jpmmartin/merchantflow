import { randomUUID } from 'node:crypto';
import {
  isLockNotAvailable,
  setLocalLockTimeout,
  type Database,
} from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { findMerchantByIdForUpdate } from '../infrastructure/merchant-queries.js';
import {
  disableEnabledProcessorAccount,
  findProcessorAccount,
} from '../infrastructure/processor-account-queries.js';
import {
  canAddressMerchant,
  canManageMerchantAccess,
} from './merchant-access.js';
import type { ProcessorAccount } from './processor-account.js';
import { PROCESSOR_ACCOUNT_LOCK_TIMEOUT_MILLIS } from './processor-account-locking.js';

export interface DisableProcessorAccountCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly processorAccountId: string;
  readonly correlationId: string;
}

export type DisableProcessorAccountResult =
  | {
      readonly ok: true;
      readonly account: ProcessorAccount;
      /** `ALREADY_DISABLED` means nothing changed and nothing was audited. */
      readonly outcome: 'DISABLED' | 'ALREADY_DISABLED';
    }
  | {
      readonly ok: false;
      readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'LOCK_TIMEOUT';
    };

/**
 * Disables a processor account of a merchant. The platform administrator may
 * do it for any merchant, and `MERCHANT_ADMIN` for its own. A disabled account
 * is never the default: disabling the default leaves the merchant without one
 * until a user sets another, so payments never move to an account nobody
 * chose. There is no re-enable; the account can be connected again. One
 * transaction locks the merchant row, applies a conditional update on the
 * enabled account, and writes `PROCESSOR_ACCOUNT_DISABLED`. An account of
 * another merchant and an unknown id are "not found"; disabling a disabled
 * account succeeds without a change.
 */
@Injectable()
export class DisableProcessorAccountService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DisableProcessorAccountService.name);
  }

  async execute(
    command: DisableProcessorAccountCommand,
  ): Promise<DisableProcessorAccountResult> {
    const { principal } = command;
    if (!canAddressMerchant(principal, command.merchantId)) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (!canManageMerchantAccess(principal)) {
      return { ok: false, code: 'FORBIDDEN' };
    }

    const now = this.clock.now();
    const key = {
      merchantId: command.merchantId,
      id: command.processorAccountId,
    };
    let result: DisableProcessorAccountResult;
    try {
      result = await this.database
        .transaction()
        .execute(async (trx): Promise<DisableProcessorAccountResult> => {
          await setLocalLockTimeout(trx, PROCESSOR_ACCOUNT_LOCK_TIMEOUT_MILLIS);
          if (
            (await findMerchantByIdForUpdate(trx, command.merchantId)) ===
            undefined
          ) {
            return { ok: false, code: 'NOT_FOUND' };
          }
          const before = await findProcessorAccount(trx, key);
          if (before === undefined) return { ok: false, code: 'NOT_FOUND' };
          const disabled = await disableEnabledProcessorAccount(trx, {
            ...key,
            updatedAt: now,
          });
          if (disabled === undefined) {
            return { ok: true, outcome: 'ALREADY_DISABLED', account: before };
          }
          await appendAuditEvent(trx, {
            id: randomUUID(),
            occurredAt: now,
            ...auditActorOf(principal),
            action: 'PROCESSOR_ACCOUNT_DISABLED',
            targetType: 'PROCESSOR_ACCOUNT',
            targetId: disabled.id,
            merchantId: command.merchantId,
            correlationId: command.correlationId,
            metadata: {
              provider: disabled.provider,
              provider_account_id: disabled.providerAccountId,
              was_default: before.isDefault,
            },
          });
          return { ok: true, outcome: 'DISABLED', account: disabled };
        });
    } catch (error) {
      if (isLockNotAvailable(error)) return { ok: false, code: 'LOCK_TIMEOUT' };
      throw error;
    }

    if (result.ok) {
      this.logger.info(
        {
          processorAccountId: result.account.id,
          merchantId: command.merchantId,
          outcome: result.outcome,
          correlationId: command.correlationId,
        },
        'processor account disabled',
      );
    }
    return result;
  }
}
