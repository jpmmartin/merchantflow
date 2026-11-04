import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { GetMerchantService } from '../../merchants/application/get-merchant.service.js';
import { findJournalEntry } from '../infrastructure/ledger-queries.js';
import type { JournalEntry } from './ledger.js';

export interface GetJournalEntryCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly journalEntryId: string;
}

export type GetJournalEntryResult =
  | { readonly ok: true; readonly entry: JournalEntry }
  | { readonly ok: false; readonly code: 'MERCHANT_NOT_FOUND' | 'NOT_FOUND' };

/**
 * Reads one journal entry of a merchant with its lines. The access rule is
 * that of `ListLedgerBalancesService`; an entry of another merchant and an
 * unknown id are both "not found".
 */
@Injectable()
export class GetJournalEntryService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly getMerchant: GetMerchantService,
  ) {}

  async execute(
    command: GetJournalEntryCommand,
  ): Promise<GetJournalEntryResult> {
    const merchant = await this.getMerchant.execute(command);
    if (!merchant.ok) return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    const entry = await findJournalEntry(this.database, {
      merchantId: command.merchantId,
      id: command.journalEntryId,
    });
    if (entry === undefined) return { ok: false, code: 'NOT_FOUND' };
    return { ok: true, entry };
  }
}
