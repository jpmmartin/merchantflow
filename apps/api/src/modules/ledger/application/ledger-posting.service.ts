import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@merchantflow/database';
import {
  ledgerAccountDefinition,
  salePostingLines,
  type JournalEntryFailure,
  type PositiveMoney,
} from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../clock/clock.js';
import {
  ensureLedgerAccount,
  findJournalEntryIdBySource,
  insertJournalEntry,
} from '../infrastructure/ledger-queries.js';
import type { JournalEntry, JournalLine } from './ledger.js';

export interface PostPaymentSaleCommand {
  /** The merchant of the payment, from the payment's own row. */
  readonly merchantId: string;
  readonly paymentIntentId: string;
  /** The successful attempt: the source of the entry, posted at most once. */
  readonly paymentAttemptId: string;
  /** The captured amount, gross of processor fees. */
  readonly amount: PositiveMoney;
  /** The merchant's order reference, for the entry's description. */
  readonly merchantReference: string;
}

export type PostPaymentSaleResult =
  | { readonly ok: true; readonly entry: JournalEntry }
  /** The posting rule produced lines that break an entry invariant. */
  | {
      readonly ok: false;
      readonly code: 'INVALID_ENTRY';
      readonly reason: JournalEntryFailure['code'];
    };

export type PostMissingPaymentSaleResult =
  | PostPaymentSaleResult
  /** The attempt's sale was already posted; nothing was written. */
  | {
      readonly ok: false;
      readonly code: 'ALREADY_POSTED';
      readonly entryId: string;
    };

/**
 * The only way other modules write to the ledger. It posts inside the
 * caller's transaction, which it never opens, commits, or rolls back, so the
 * entry commits or rolls back with the state change that caused it.
 *
 * A sale is posted by the domain rule `salePostingLines`: debit Processor
 * receivable, credit Sales, by the gross amount, in the payment's currency.
 * The accounts are created when first needed. The source is the successful
 * attempt (`PAYMENT_SALE`, attempt ID), and the unique source constraint
 * makes a second posting of the same attempt fail, which rolls the caller's
 * transaction back; the deferred trigger checks the balance at commit.
 */
@Injectable()
export class LedgerPostingService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async postPaymentSale(
    trx: DatabaseTransaction,
    command: PostPaymentSaleCommand,
  ): Promise<PostPaymentSaleResult> {
    const rule = salePostingLines(command.amount);
    if (!rule.ok) {
      return { ok: false, code: 'INVALID_ENTRY', reason: rule.code };
    }
    const now = this.clock.now();
    const lines: JournalLine[] = [];
    for (const [index, line] of rule.entry.lines.entries()) {
      const definition = ledgerAccountDefinition(line.accountCode);
      const account = await ensureLedgerAccount(trx, {
        id: randomUUID(),
        merchantId: command.merchantId,
        code: line.accountCode,
        name: definition.name,
        classification: definition.classification,
        currency: rule.entry.currency,
        createdAt: now,
      });
      if (account.classification !== definition.classification) {
        throw new Error(
          `ledger account ${account.id} (${account.code}) is ${account.classification}, the chart says ${definition.classification}`,
        );
      }
      lines.push({
        lineNumber: index + 1,
        ledgerAccountId: account.id,
        accountCode: account.code,
        accountName: account.name,
        side: line.side,
        amount: line.amount,
      });
    }
    const entry: JournalEntry = {
      id: randomUUID(),
      merchantId: command.merchantId,
      sourceType: 'PAYMENT_SALE',
      sourceId: command.paymentAttemptId,
      paymentIntentId: command.paymentIntentId,
      description: `Card sale, order ${command.merchantReference}`,
      postedAt: now,
      lines,
    };
    await insertJournalEntry(trx, {
      ...entry,
      lines: lines.map((line) => ({
        id: randomUUID(),
        ledgerAccountId: line.ledgerAccountId,
        side: line.side,
        amount: line.amount,
      })),
    });
    return { ok: true, entry };
  }

  /**
   * Posts the sale of a successful attempt only if no entry has its source
   * yet, for a backfill of sales that succeeded before the ledger existed.
   * The caller serializes runs; the unique source constraint stays the last
   * defense, and a sale that Apply posts commits with its success, so a
   * committed success always shows its entry here.
   */
  async postMissingPaymentSale(
    trx: DatabaseTransaction,
    command: PostPaymentSaleCommand,
  ): Promise<PostMissingPaymentSaleResult> {
    const existing = await findJournalEntryIdBySource(trx, {
      sourceType: 'PAYMENT_SALE',
      sourceId: command.paymentAttemptId,
    });
    if (existing !== undefined) {
      return { ok: false, code: 'ALREADY_POSTED', entryId: existing };
    }
    return this.postPaymentSale(trx, command);
  }
}
