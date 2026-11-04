import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { findMerchantById } from '../infrastructure/merchant-queries.js';
import { listProcessorAccounts } from '../infrastructure/processor-account-queries.js';
import { canAddressMerchant } from './merchant-access.js';
import type { ProcessorAccount } from './processor-account.js';

export interface ListProcessorAccountsCommand {
  readonly principal: Principal;
  readonly merchantId: string;
}

export type ListProcessorAccountsResult =
  | { readonly ok: true; readonly accounts: readonly ProcessorAccount[] }
  | { readonly ok: false; readonly code: 'MERCHANT_NOT_FOUND' };

/**
 * Lists the processor accounts of a merchant, disabled ones included, without
 * their secrets. Every role may read the accounts of a merchant it can
 * address; another merchant, existing or not, is "not found".
 */
@Injectable()
export class ListProcessorAccountsService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(
    command: ListProcessorAccountsCommand,
  ): Promise<ListProcessorAccountsResult> {
    if (!canAddressMerchant(command.principal, command.merchantId)) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    const merchant = await findMerchantById(this.database, command.merchantId);
    if (merchant === undefined) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    return {
      ok: true,
      accounts: await listProcessorAccounts(this.database, command.merchantId),
    };
  }
}
