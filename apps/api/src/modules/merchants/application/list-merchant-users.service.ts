import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { ListUsersService } from '../../auth/application/list-users.service.js';
import type { Principal } from '../../auth/application/principal.js';
import type { UserSummary } from '../../auth/application/user.js';
import { DATABASE } from '../../database/database.module.js';
import { findMerchantById } from '../infrastructure/merchant-queries.js';
import { canAddressMerchant } from './merchant-access.js';

export interface ListMerchantUsersCommand {
  readonly principal: Principal;
  readonly merchantId: string;
}

export type ListMerchantUsersResult =
  | { readonly ok: true; readonly users: readonly UserSummary[] }
  | { readonly ok: false; readonly code: 'MERCHANT_NOT_FOUND' };

/**
 * Lists the users of a merchant, enabled or not, with no password hash. Every
 * role may read the users of a merchant it can address; another merchant,
 * existing or not, is "not found".
 */
@Injectable()
export class ListMerchantUsersService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly listUsers: ListUsersService,
  ) {}

  async execute(
    command: ListMerchantUsersCommand,
  ): Promise<ListMerchantUsersResult> {
    if (!canAddressMerchant(command.principal, command.merchantId)) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    const merchant = await findMerchantById(this.database, command.merchantId);
    if (merchant === undefined) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    return {
      ok: true,
      users: await this.listUsers.execute(command.merchantId),
    };
  }
}
