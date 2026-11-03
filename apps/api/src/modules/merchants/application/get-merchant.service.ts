import type { Database } from '@merchantflow/database';
import type { Merchant } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { findMerchantById } from '../infrastructure/merchant-queries.js';
import { canAddressMerchant } from './merchant-access.js';

export interface GetMerchantCommand {
  readonly principal: Principal;
  readonly merchantId: string;
}

export type GetMerchantResult =
  | { readonly ok: true; readonly merchant: Merchant }
  | { readonly ok: false; readonly code: 'MERCHANT_NOT_FOUND' };

/**
 * Reads one merchant. A merchant key can read only its own merchant; any other
 * id, existing or not, is reported as not found. Every role may read, and a
 * suspended merchant stays readable.
 */
@Injectable()
export class GetMerchantService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(command: GetMerchantCommand): Promise<GetMerchantResult> {
    if (!canAddressMerchant(command.principal, command.merchantId)) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    const merchant = await findMerchantById(this.database, command.merchantId);
    if (merchant === undefined) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    return { ok: true, merchant };
  }
}
