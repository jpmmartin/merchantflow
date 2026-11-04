import type { CurrencyCode } from '../money/currency.js';
import {
  addMoney,
  createMoney,
  equalsMoney,
  type Money,
  type PositiveMoney,
} from '../money/money.js';
import type { JournalLineSide, LedgerAccountCode } from './ledger-account.js';

/** One line of a journal entry before it is posted. */
export interface JournalLineDraft {
  readonly accountCode: LedgerAccountCode;
  readonly side: JournalLineSide;
  readonly amount: Money;
}

/** A journal entry's lines, checked against every entry invariant. */
export interface BalancedJournalLines {
  readonly currency: CurrencyCode;
  readonly lines: readonly (JournalLineDraft & {
    readonly amount: PositiveMoney;
  })[];
  /** The sum of the debits, equal to the sum of the credits. */
  readonly total: Money;
}

export type JournalEntryFailure =
  /** An entry needs at least two lines. */
  | { readonly ok: false; readonly code: 'TOO_FEW_LINES' }
  /** A line amount is zero or negative. */
  | {
      readonly ok: false;
      readonly code: 'NON_POSITIVE_AMOUNT';
      readonly lineIndex: number;
    }
  /** A line has another currency than the first line. */
  | {
      readonly ok: false;
      readonly code: 'MIXED_CURRENCIES';
      readonly lineIndex: number;
    }
  /** The sum of one side leaves the `BIGINT` range. */
  | { readonly ok: false; readonly code: 'TOTAL_OUT_OF_RANGE' }
  /** The debits and the credits differ. */
  | { readonly ok: false; readonly code: 'UNBALANCED' };

export type JournalEntryValidationResult =
  | { readonly ok: true; readonly entry: BalancedJournalLines }
  | JournalEntryFailure;

/** Minimum number of lines of a journal entry. */
export const MIN_JOURNAL_LINES = 2;

/**
 * Checks the invariants of a journal entry, in order: at least two lines,
 * every amount greater than zero, every line in the currency of the first
 * one, and the debits equal to the credits. The first failure is returned,
 * with the index of the line at fault where there is one. Sums use exact
 * `bigint` arithmetic, and a sum outside the `BIGINT` range is a failure, not
 * a wrapped value.
 */
export function validateJournalEntry(
  lines: readonly JournalLineDraft[],
): JournalEntryValidationResult {
  const first = lines[0];
  if (first === undefined || lines.length < MIN_JOURNAL_LINES) {
    return { ok: false, code: 'TOO_FEW_LINES' };
  }
  const currency = first.amount.currency;
  const zero = createMoney(0n, currency);
  if (!zero.ok) throw new Error(`unsupported currency ${currency}`);
  let debits: Money = zero.money;
  let credits: Money = zero.money;
  const checked: (JournalLineDraft & { readonly amount: PositiveMoney })[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (line.amount.amountMinor <= 0n) {
      return { ok: false, code: 'NON_POSITIVE_AMOUNT', lineIndex };
    }
    if (line.amount.currency !== currency) {
      return { ok: false, code: 'MIXED_CURRENCIES', lineIndex };
    }
    const sum = addMoney(line.side === 'DEBIT' ? debits : credits, line.amount);
    if (!sum.ok) return { ok: false, code: 'TOTAL_OUT_OF_RANGE' };
    if (line.side === 'DEBIT') debits = sum.money;
    else credits = sum.money;
    checked.push({ ...line, amount: line.amount as PositiveMoney });
  }
  const equal = equalsMoney(debits, credits);
  if (!equal.ok || !equal.equal) return { ok: false, code: 'UNBALANCED' };
  return { ok: true, entry: { currency, lines: checked, total: debits } };
}
