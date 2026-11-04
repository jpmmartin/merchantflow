import { randomUUID } from 'node:crypto';
import type { Database } from '@merchantflow/database';
import { toAmountMinorString } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { LedgerPostingService } from '../../ledger/application/ledger-posting.service.js';
import type { KeysetPosition } from '../../pagination/keyset-cursor.js';
import { listSucceededSales } from '../infrastructure/payment-intent-queries.js';

/** Audit action of a sale posted by the backfill. */
export const LEDGER_SALE_BACKFILLED = 'LEDGER_SALE_BACKFILLED';

/** Actor recorded on the backfill's audit events. */
export const LEDGER_BACKFILL_ACTOR_ID = 'ledger-backfill';

const PAGE_SIZE = 100;

/** One sale the backfill posted. */
export interface BackfilledSale {
  readonly merchantId: string;
  readonly paymentIntentId: string;
  readonly paymentAttemptId: string;
  readonly journalEntryId: string;
  readonly amountMinor: string;
  readonly currency: string;
}

export interface BackfillSaleEntriesSummary {
  /** Successful attempts read. */
  readonly examined: number;
  /** Sales posted by this run, oldest success first. */
  readonly posted: readonly BackfilledSale[];
  /** Successful attempts whose sale already had its entry. */
  readonly alreadyPosted: number;
}

/**
 * Posts the sale entry of every successful attempt that has none, such as the
 * payments that succeeded before the ledger existed. Each sale is posted in
 * its own short transaction with one `LEDGER_SALE_BACKFILLED` audit event, by
 * the same posting rule as Apply, so its entry is the one Apply would have
 * written, except that its posting time is the time of the backfill. A sale
 * that already has its entry is skipped, so a second run posts nothing. The
 * caller must keep two runs from overlapping (the CLI holds an advisory
 * lock); the unique source of `journal_entries` is the last defense.
 */
@Injectable()
export class BackfillSaleEntriesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ledger: LedgerPostingService,
  ) {}

  async execute(): Promise<BackfillSaleEntriesSummary> {
    const correlationId = randomUUID();
    const posted: BackfilledSale[] = [];
    let examined = 0;
    let alreadyPosted = 0;
    let after: KeysetPosition | undefined;
    for (;;) {
      const sales = await listSucceededSales(this.database, {
        limit: PAGE_SIZE,
        after,
      });
      for (const sale of sales) {
        examined += 1;
        const { intent } = sale;
        const result = await this.database
          .transaction()
          .setIsolationLevel('read committed')
          .execute(async (trx) => {
            const posting = await this.ledger.postMissingPaymentSale(trx, {
              merchantId: intent.merchantId,
              paymentIntentId: intent.id,
              paymentAttemptId: sale.attemptId,
              amount: intent.amount,
              merchantReference: intent.merchantReference,
            });
            if (posting.ok) {
              await appendAuditEvent(trx, {
                id: randomUUID(),
                occurredAt: this.clock.now(),
                actorType: 'SYSTEM',
                actorId: LEDGER_BACKFILL_ACTOR_ID,
                action: LEDGER_SALE_BACKFILLED,
                targetType: 'PAYMENT_INTENT',
                targetId: intent.id,
                merchantId: intent.merchantId,
                correlationId,
                metadata: {
                  payment_attempt_id: sale.attemptId,
                  journal_entry_id: posting.entry.id,
                  amount_minor: toAmountMinorString(intent.amount),
                  currency: intent.amount.currency,
                },
              });
            }
            return posting;
          });
        if (result.ok) {
          posted.push({
            merchantId: intent.merchantId,
            paymentIntentId: intent.id,
            paymentAttemptId: sale.attemptId,
            journalEntryId: result.entry.id,
            amountMinor: toAmountMinorString(intent.amount),
            currency: intent.amount.currency,
          });
        } else if (result.code === 'ALREADY_POSTED') {
          alreadyPosted += 1;
        } else {
          throw new Error(
            `sale of payment attempt ${sale.attemptId} cannot be posted: ${result.reason}`,
          );
        }
      }
      const last = sales.at(-1);
      if (sales.length < PAGE_SIZE || last === undefined) break;
      after = { createdAt: last.attemptCreatedAt, id: last.attemptId };
    }
    return { examined, posted, alreadyPosted };
  }
}
