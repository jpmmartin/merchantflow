import { randomUUID } from 'node:crypto';
import type { Database } from '@merchantflow/database';
import {
  evaluateMerchantTransition,
  type Merchant,
  type MerchantStatus,
} from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import type { Principal } from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import {
  findMerchantById,
  updateMerchantStatus,
} from '../infrastructure/merchant-queries.js';
import { auditActorOf, canAddressMerchant } from './merchant-access.js';

export interface ChangeMerchantStatusCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly target: MerchantStatus;
  readonly correlationId: string;
}

export type ChangeMerchantStatusResult =
  | { readonly ok: true; readonly merchant: Merchant }
  | {
      readonly ok: false;
      readonly code:
        | 'MERCHANT_NOT_FOUND'
        | 'FORBIDDEN'
        | 'TRANSITION_NOT_ALLOWED'
        | 'STATUS_CONFLICT';
    };

/**
 * Moves a merchant to another status and writes one audit event in the same
 * transaction. Only a platform key may do it.
 *
 * The merchant must be addressable by the caller first (otherwise "not found",
 * whatever the role), then the role is checked, so a merchant key never causes
 * a read or a write, including on its own suspended merchant. The domain
 * policy decides whether the transition is allowed. The update requires the
 * status that was read, so when another request changed it in between, this
 * one changes nothing and reports `STATUS_CONFLICT`.
 */
@Injectable()
export class ChangeMerchantStatusService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    command: ChangeMerchantStatusCommand,
  ): Promise<ChangeMerchantStatusResult> {
    const { principal } = command;
    if (!canAddressMerchant(principal, command.merchantId)) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    if (principal.kind !== 'PLATFORM') {
      return { ok: false, code: 'FORBIDDEN' };
    }

    const now = this.clock.now();
    return this.database
      .transaction()
      .execute(async (trx): Promise<ChangeMerchantStatusResult> => {
        const current = await findMerchantById(trx, command.merchantId);
        if (current === undefined) {
          return { ok: false, code: 'MERCHANT_NOT_FOUND' };
        }
        const transition = evaluateMerchantTransition(
          current.status,
          command.target,
        );
        if (!transition.ok) {
          return { ok: false, code: 'TRANSITION_NOT_ALLOWED' };
        }

        const changedRows = await updateMerchantStatus(trx, {
          id: current.id,
          expected: transition.from,
          next: transition.to,
          updatedAt: now,
        });
        if (changedRows !== 1) {
          return { ok: false, code: 'STATUS_CONFLICT' };
        }
        await appendAuditEvent(trx, {
          id: randomUUID(),
          occurredAt: now,
          ...auditActorOf(principal),
          action: 'MERCHANT_STATUS_CHANGED',
          targetType: 'MERCHANT',
          targetId: current.id,
          merchantId: current.id,
          correlationId: command.correlationId,
          metadata: { from: transition.from, to: transition.to },
        });
        return {
          ok: true,
          merchant: { ...current, status: transition.to, updatedAt: now },
        };
      });
  }
}
