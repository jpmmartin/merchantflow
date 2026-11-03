import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import type { ApiKeySummary } from '../../auth/application/find-api-key.service.js';
import { ListApiKeysService } from '../../auth/application/list-api-keys.service.js';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { findMerchantById } from '../infrastructure/merchant-queries.js';
import { canAddressMerchant } from './merchant-access.js';

export interface ListMerchantApiKeysCommand {
  readonly principal: Principal;
  readonly merchantId: string;
}

export type ListMerchantApiKeysResult =
  | { readonly ok: true; readonly apiKeys: readonly ApiKeySummary[] }
  | { readonly ok: false; readonly code: 'MERCHANT_NOT_FOUND' };

/**
 * Lists the keys of a merchant, revoked ones included, with no secret, hash,
 * or lookup id. Every role may read the keys of a merchant it can address;
 * another merchant, existing or not, is "not found".
 */
@Injectable()
export class ListMerchantApiKeysService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly listApiKeys: ListApiKeysService,
  ) {}

  async execute(
    command: ListMerchantApiKeysCommand,
  ): Promise<ListMerchantApiKeysResult> {
    if (!canAddressMerchant(command.principal, command.merchantId)) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    const merchant = await findMerchantById(this.database, command.merchantId);
    if (merchant === undefined) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    return {
      ok: true,
      apiKeys: await this.listApiKeys.execute(command.merchantId),
    };
  }
}
