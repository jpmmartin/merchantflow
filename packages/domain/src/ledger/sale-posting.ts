import type { PositiveMoney } from '../money/money.js';
import {
  PROCESSOR_RECEIVABLE_ACCOUNT,
  SALES_ACCOUNT,
} from './ledger-account.js';
import {
  validateJournalEntry,
  type JournalEntryValidationResult,
} from './journal-entry.js';

/**
 * The posting rule of a captured card sale: debit Processor receivable and
 * credit Sales by the gross amount, in the sale's currency. Processor fees
 * are not part of it: the processor reports them later, and they will be
 * posted as their own entry. The lines are checked by `validateJournalEntry`,
 * so the result carries the same guarantees as any other entry.
 */
export function salePostingLines(
  amount: PositiveMoney,
): JournalEntryValidationResult {
  return validateJournalEntry([
    { accountCode: PROCESSOR_RECEIVABLE_ACCOUNT, side: 'DEBIT', amount },
    { accountCode: SALES_ACCOUNT, side: 'CREDIT', amount },
  ]);
}
