import { randomUUID } from 'node:crypto';
import type { Database } from '@merchantflow/database';
import type { Merchant } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import type { Principal } from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { insertMerchant } from '../infrastructure/merchant-queries.js';
import { auditActorOf } from './merchant-access.js';

/** The fields a merchant is created with. Its status is always `DRAFT`. */
export interface NewMerchant {
  readonly legalName: string;
  readonly displayName: string;
  readonly businessType: string;
  readonly industry: string;
  readonly countryCode: string;
  readonly defaultCurrency: string;
}

export interface CreateMerchantCommand {
  readonly principal: Principal;
  readonly merchant: NewMerchant;
  readonly correlationId: string;
}

export type CreateMerchantResult =
  | { readonly ok: true; readonly merchant: Merchant }
  | { readonly ok: false; readonly code: 'FORBIDDEN' };

/**
 * Registers a merchant in `DRAFT` and writes its audit event in one
 * transaction. Only a platform key may do it. No API key is issued here: that
 * is a separate, separately audited command.
 */
@Injectable()
export class CreateMerchantService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(command: CreateMerchantCommand): Promise<CreateMerchantResult> {
    const { principal } = command;
    if (principal.kind !== 'PLATFORM') {
      return { ok: false, code: 'FORBIDDEN' };
    }

    const now = this.clock.now();
    const merchant: Merchant = {
      id: randomUUID(),
      ...command.merchant,
      status: 'DRAFT',
      createdAt: now,
      updatedAt: now,
    };
    await this.database.transaction().execute(async (trx) => {
      await insertMerchant(trx, merchant);
      await appendAuditEvent(trx, {
        id: randomUUID(),
        occurredAt: now,
        ...auditActorOf(principal),
        action: 'MERCHANT_CREATED',
        targetType: 'MERCHANT',
        targetId: merchant.id,
        merchantId: merchant.id,
        correlationId: command.correlationId,
        metadata: {
          status: merchant.status,
          country_code: merchant.countryCode,
          default_currency: merchant.defaultCurrency,
        },
      });
    });
    return { ok: true, merchant };
  }
}
