import type { PositiveMoney } from '../money/money.js';
import {
  PROCESSOR_RECEIVABLE_ACCOUNT,
  REFUNDS_ACCOUNT,
} from './ledger-account.js';
import {
  validateJournalEntry,
  type JournalEntryValidationResult,
} from './journal-entry.js';

/**
 * The posting rule of a successful refund of a captured card sale: debit
 * Refunds (contra-revenue) and credit Processor receivable by the refunded
 * amount, in the payment's currency. The processor returns the money to the
 * customer out of what it owes the merchant, so the receivable falls, and the
 * refund reduces revenue through its own account instead of a debit to Sales.
 * Processor fees are not part of it. The lines are checked by
 * `validateJournalEntry`, so the result carries the same guarantees as any
 * other entry.
 */
export function refundPostingLines(
  amount: PositiveMoney,
): JournalEntryValidationResult {
  return validateJournalEntry([
    { accountCode: REFUNDS_ACCOUNT, side: 'DEBIT', amount },
    { accountCode: PROCESSOR_RECEIVABLE_ACCOUNT, side: 'CREDIT', amount },
  ]);
}
