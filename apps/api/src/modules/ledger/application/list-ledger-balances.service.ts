import type { Database } from '@merchantflow/database';
import { accountBalance, normalBalanceSide } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { GetMerchantService } from '../../merchants/application/get-merchant.service.js';
import { listLedgerAccountTotals } from '../infrastructure/ledger-queries.js';
import type { LedgerAccountBalance } from './ledger.js';

export interface ListLedgerBalancesCommand {
  readonly principal: Principal;
  readonly merchantId: string;
}

export type ListLedgerBalancesResult =
  | {
      readonly ok: true;
      readonly merchantId: string;
      readonly balances: readonly LedgerAccountBalance[];
    }
  | { readonly ok: false; readonly code: 'MERCHANT_NOT_FOUND' };

/**
 * Lists every ledger account of a merchant with its balance, computed from
 * its lines on each read and signed by the account's normal side; no balance
 * is stored. Every role may read the ledger of a merchant it can address:
 * the platform administrator any merchant, a merchant role its own. Another
 * merchant, existing or not, is "not found". A merchant with no posting yet
 * has no accounts.
 */
@Injectable()
export class ListLedgerBalancesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly getMerchant: GetMerchantService,
  ) {}

  async execute(
    command: ListLedgerBalancesCommand,
  ): Promise<ListLedgerBalancesResult> {
    const merchant = await this.getMerchant.execute(command);
    if (!merchant.ok) return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    const totals = await listLedgerAccountTotals(
      this.database,
      command.merchantId,
    );
    const balances = totals.map(({ account, debits, credits }) => {
      const balance = accountBalance(account.classification, {
        debits,
        credits,
      });
      if (!balance.ok) {
        throw new Error(
          `balance of ledger account ${account.id} cannot be computed: ${balance.code}`,
        );
      }
      return {
        account,
        normalSide: normalBalanceSide(account.classification),
        debits,
        credits,
        balance: balance.money,
      };
    });
    return { ok: true, merchantId: command.merchantId, balances };
  }
}
