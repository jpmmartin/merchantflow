import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../../database/database.module.js';
import { listJournalEntriesOfPaymentIntent } from '../infrastructure/ledger-queries.js';
import type { JournalEntry } from './ledger.js';

/**
 * Reads every journal entry of one payment intent, with its lines, oldest
 * first, for other modules (the payment timeline, P-09). The caller has
 * already established that the intent belongs to the merchant; every row is
 * still read through the merchant filter, so an intent of another merchant
 * matches no entry.
 */
@Injectable()
export class ListPaymentJournalEntriesService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(key: {
    readonly merchantId: string;
    readonly paymentIntentId: string;
  }): Promise<readonly JournalEntry[]> {
    return listJournalEntriesOfPaymentIntent(this.database, key);
  }
}
