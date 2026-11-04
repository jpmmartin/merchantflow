import type {
  JournalLineSide,
  LedgerAccountClassification,
  Money,
  PositiveMoney,
} from '@merchantflow/domain';

/** The source types of `journal_entries_source_type_check`. */
export const JOURNAL_SOURCE_TYPES = ['PAYMENT_SALE'] as const;

export type JournalSourceType = (typeof JOURNAL_SOURCE_TYPES)[number];

/** A ledger account of a merchant, in one currency. */
export interface LedgerAccount {
  readonly id: string;
  readonly merchantId: string;
  readonly code: string;
  readonly name: string;
  readonly classification: LedgerAccountClassification;
  readonly currency: string;
  readonly createdAt: Date;
}

/** An account with the totals of its lines and its balance. */
export interface LedgerAccountBalance {
  readonly account: LedgerAccount;
  readonly normalSide: JournalLineSide;
  readonly debits: Money;
  readonly credits: Money;
  /** Positive on the account's normal side, negative on the other. */
  readonly balance: Money;
}

/** One line of a posted entry, with the code and name of its account. */
export interface JournalLine {
  readonly lineNumber: number;
  readonly ledgerAccountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly side: JournalLineSide;
  readonly amount: PositiveMoney;
}

/** A posted journal entry and its lines, in line order. */
export interface JournalEntry {
  readonly id: string;
  readonly merchantId: string;
  readonly sourceType: JournalSourceType;
  readonly sourceId: string;
  readonly paymentIntentId: string | null;
  readonly description: string;
  readonly postedAt: Date;
  readonly lines: readonly JournalLine[];
}
