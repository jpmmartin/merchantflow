import { Module } from '@nestjs/common';
import { ClockModule } from '../clock/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MerchantsModule } from '../merchants/merchants.module.js';
import { LedgerController } from './api/ledger.controller.js';
import { GetJournalEntryService } from './application/get-journal-entry.service.js';
import { LedgerPostingService } from './application/ledger-posting.service.js';
import { ListJournalEntriesService } from './application/list-journal-entries.service.js';
import { ListLedgerBalancesService } from './application/list-ledger-balances.service.js';

/**
 * Owns the merchant ledger: its accounts, journal entries, and lines, and the
 * endpoints that read them. Other modules post only through the exported
 * `LedgerPostingService`, inside their own transaction. Merchants are read
 * through the merchants module.
 */
@Module({
  imports: [DatabaseModule, ClockModule, MerchantsModule],
  controllers: [LedgerController],
  providers: [
    LedgerPostingService,
    ListLedgerBalancesService,
    ListJournalEntriesService,
    GetJournalEntryService,
  ],
  exports: [LedgerPostingService],
})
export class LedgerModule {}
