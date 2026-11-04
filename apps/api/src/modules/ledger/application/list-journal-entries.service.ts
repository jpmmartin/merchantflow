import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { GetMerchantService } from '../../merchants/application/get-merchant.service.js';
import type { KeysetPosition } from '../../pagination/keyset-cursor.js';
import { listJournalEntries } from '../infrastructure/ledger-queries.js';
import type { JournalEntry } from './ledger.js';

export interface ListJournalEntriesCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  /** Page size. The caller validates the bounds. */
  readonly limit: number;
  /** Where the previous page ended, to continue after it. */
  readonly after?: KeysetPosition | undefined;
  /** Only the entries of this payment intent; every entry when absent. */
  readonly paymentIntentId?: string | undefined;
}

export interface JournalEntryPage {
  readonly merchantId: string;
  readonly entries: readonly JournalEntry[];
  /** Pass it as `after` to get the next page; `undefined` on the last page. */
  readonly next: KeysetPosition | undefined;
}

export type ListJournalEntriesResult =
  | { readonly ok: true; readonly page: JournalEntryPage }
  | { readonly ok: false; readonly code: 'MERCHANT_NOT_FOUND' };

/**
 * Lists the journal entries of a merchant with their lines, newest first by
 * posting time, one page at a time, optionally only those of one payment
 * intent. The access rule is that of `ListLedgerBalancesService`. A payment
 * intent of another merchant matches no entry, because every row is read
 * through the merchant filter.
 */
@Injectable()
export class ListJournalEntriesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly getMerchant: GetMerchantService,
  ) {}

  async execute(
    command: ListJournalEntriesCommand,
  ): Promise<ListJournalEntriesResult> {
    const merchant = await this.getMerchant.execute(command);
    if (!merchant.ok) return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    // One extra row tells whether another page exists without a count query.
    const rows = await listJournalEntries(this.database, {
      merchantId: command.merchantId,
      limit: command.limit + 1,
      after: command.after,
      paymentIntentId: command.paymentIntentId,
    });
    const entries = rows.slice(0, command.limit);
    const last = entries.at(-1);
    return {
      ok: true,
      page: {
        merchantId: command.merchantId,
        entries,
        next:
          rows.length > command.limit && last !== undefined
            ? { createdAt: last.postedAt, id: last.id }
            : undefined,
      },
    };
  }
}
