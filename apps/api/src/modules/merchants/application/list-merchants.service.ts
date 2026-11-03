import type { Database } from '@merchantflow/database';
import type { Merchant } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { listMerchants } from '../infrastructure/merchant-queries.js';
import type { MerchantListPosition } from './merchant-changes.js';

export interface ListMerchantsCommand {
  readonly principal: Principal;
  /** Page size. The caller validates the bounds. */
  readonly limit: number;
  /** Where the previous page ended, to continue after it. */
  readonly after?: MerchantListPosition | undefined;
}

export interface MerchantPage {
  readonly merchants: readonly Merchant[];
  /** Pass it as `after` to get the next page; `undefined` on the last page. */
  readonly next: MerchantListPosition | undefined;
}

/**
 * Lists merchants in a stable order, one page at a time. A platform key sees
 * every merchant; a merchant key sees only its own, taken from the key.
 */
@Injectable()
export class ListMerchantsService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(command: ListMerchantsCommand): Promise<MerchantPage> {
    const { principal, limit } = command;
    // One extra row tells whether another page exists without a count query.
    const rows = await listMerchants(this.database, {
      limit: limit + 1,
      after: command.after,
      merchantId:
        principal.kind === 'MERCHANT' ? principal.merchantId : undefined,
    });
    const merchants = rows.slice(0, limit);
    const last = merchants.at(-1);
    return {
      merchants,
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : undefined,
    };
  }
}
