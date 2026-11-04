import {
  describeDatabaseFailure,
  withTryAdvisoryLock,
  type Database,
} from '@merchantflow/database';
import { DATABASE } from '../modules/database/database.module.js';
import { LedgerModule } from '../modules/ledger/ledger.module.js';
import {
  BackfillSaleEntriesService,
  type BackfillSaleEntriesSummary,
} from '../modules/payments/application/backfill-sale-entries.service.js';
import {
  FAILURE,
  SUCCESS,
  openSeedContext,
  type SeedCliOptions,
} from './seed-context.js';

/** Advisory lock key that keeps two backfill runs from overlapping. */
export const LEDGER_BACKFILL_LOCK_KEY = 7_301_002;

/**
 * Posts the missing sale entries of successful payments (`pnpm
 * db:backfill-ledger`) and prints what it posted. Resolves with the exit
 * code: 0 when every successful payment has its entry afterwards, whether or
 * not this run posted any; 1 on any failure, when another run holds the lock,
 * and in production. A failure leaves the sales posted so far in place, and
 * running the command again posts only the rest.
 */
export async function runBackfillLedgerCli(
  options: SeedCliOptions,
): Promise<number> {
  const opened = await openSeedContext(options, {
    imports: [LedgerModule],
    providers: [BackfillSaleEntriesService],
    productionRefusal:
      'Refusing to backfill the ledger: NODE_ENV is "production". This command runs only in development and test.',
  });
  if (!opened.ok) return opened.exitCode;
  const { context } = opened;
  try {
    let locked;
    try {
      locked = await withTryAdvisoryLock(
        context.get<Database>(DATABASE),
        LEDGER_BACKFILL_LOCK_KEY,
        (): Promise<BackfillSaleEntriesSummary> =>
          context.get(BackfillSaleEntriesService).execute(),
      );
    } catch (error) {
      options.stderr.write(
        `The ledger backfill failed (cause: ${describeDatabaseFailure(error)}). Sales posted before the failure stay posted; run it again to post the rest.\n`,
      );
      return FAILURE;
    }
    if (!locked.acquired) {
      options.stderr.write(
        'Another ledger backfill is in progress. Wait for it to finish and run it again.\n',
      );
      return FAILURE;
    }
    const summary = locked.value;
    for (const sale of summary.posted) {
      options.stdout.write(
        `Posted entry ${sale.journalEntryId}: merchant ${sale.merchantId}, payment intent ${sale.paymentIntentId}, attempt ${sale.paymentAttemptId}, ${sale.amountMinor} ${sale.currency} (minor units).\n`,
      );
    }
    options.stdout.write(
      `Successful payments examined: ${summary.examined}. Sale entries posted now: ${summary.posted.length}. Already posted: ${summary.alreadyPosted}.\n`,
    );
    return SUCCESS;
  } finally {
    await context.close();
  }
}
