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
  clearDefaultProcessorAccount,
  findProcessorAccount,
  makeDefaultProcessorAccount,
} from '../infrastructure/processor-account-queries.js';
import {
  canAddressMerchant,
  canManageMerchantAccess,
} from './merchant-access.js';
import type { ProcessorAccount } from './processor-account.js';
import { PROCESSOR_ACCOUNT_LOCK_TIMEOUT_MILLIS } from './processor-account-locking.js';

export interface SetDefaultProcessorAccountCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly processorAccountId: string;
  readonly correlationId: string;
}

export type SetDefaultProcessorAccountResult =
  | {
      readonly ok: true;
      readonly account: ProcessorAccount;
      /** `ALREADY_DEFAULT` means nothing changed and nothing was audited. */
      readonly outcome: 'DEFAULT_CHANGED' | 'ALREADY_DEFAULT';
    }
  | {
      readonly ok: false;
      readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'DISABLED' | 'LOCK_TIMEOUT';
    };

/**
 * Makes an enabled account the merchant's default, the one payments use. The
 * platform administrator may do it for any merchant, and `MERCHANT_ADMIN` for
 * its own. One transaction locks the merchant row, clears the current default,
 * sets the new one with a conditional update, and writes
 * `PROCESSOR_ACCOUNT_DEFAULT_CHANGED` with the previous default. A disabled
 * account cannot become the default. An account of another merchant and an
 * unknown id are "not found"; naming the current default succeeds without a
 * change.
 */
@Injectable()
export class SetDefaultProcessorAccountService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SetDefaultProcessorAccountService.name);
  }

  async execute(
    command: SetDefaultProcessorAccountCommand,
  ): Promise<SetDefaultProcessorAccountResult> {
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
    let result: SetDefaultProcessorAccountResult;
    try {
      result = await this.database
        .transaction()
        .execute(async (trx): Promise<SetDefaultProcessorAccountResult> => {
          await setLocalLockTimeout(trx, PROCESSOR_ACCOUNT_LOCK_TIMEOUT_MILLIS);
          if (
            (await findMerchantByIdForUpdate(trx, command.merchantId)) ===
            undefined
          ) {
            return { ok: false, code: 'NOT_FOUND' };
          }
          const account = await findProcessorAccount(trx, key);
          if (account === undefined) return { ok: false, code: 'NOT_FOUND' };
          if (!account.enabled) return { ok: false, code: 'DISABLED' };
          if (account.isDefault) {
            return { ok: true, outcome: 'ALREADY_DEFAULT', account };
          }
          const previousDefaultId = await clearDefaultProcessorAccount(trx, {
            merchantId: command.merchantId,
            updatedAt: now,
          });
          const updated = await makeDefaultProcessorAccount(trx, {
            ...key,
            updatedAt: now,
          });
          if (updated === undefined) {
            // The merchant row lock serializes every account change of the
            // merchant, so the account read above cannot have changed.
            throw new Error(
              `processor account ${account.id} changed under the merchant lock`,
            );
          }
          await appendAuditEvent(trx, {
            id: randomUUID(),
            occurredAt: now,
            ...auditActorOf(principal),
            action: 'PROCESSOR_ACCOUNT_DEFAULT_CHANGED',
            targetType: 'PROCESSOR_ACCOUNT',
            targetId: updated.id,
            merchantId: command.merchantId,
            correlationId: command.correlationId,
            metadata: { previous_default_id: previousDefaultId ?? null },
          });
          return { ok: true, outcome: 'DEFAULT_CHANGED', account: updated };
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
        'processor account default set',
      );
    }
    return result;
  }
}
