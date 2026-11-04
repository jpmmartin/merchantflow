/**
 * Classifications of a ledger account. Each one has a normal balance side:
 * the side whose movements increase the account.
 */
export const LEDGER_ACCOUNT_CLASSIFICATIONS = [
  'ASSET',
  'LIABILITY',
  'REVENUE',
  'EXPENSE',
] as const;

export type LedgerAccountClassification =
  (typeof LEDGER_ACCOUNT_CLASSIFICATIONS)[number];

/** The two sides of a journal line. */
export const JOURNAL_LINE_SIDES = ['DEBIT', 'CREDIT'] as const;

export type JournalLineSide = (typeof JOURNAL_LINE_SIDES)[number];

/**
 * The side that increases an account of a classification: debit for assets
 * and expenses, credit for liabilities and revenue.
 */
export function normalBalanceSide(
  classification: LedgerAccountClassification,
): JournalLineSide {
  switch (classification) {
    case 'ASSET':
    case 'EXPENSE':
      return 'DEBIT';
    case 'LIABILITY':
    case 'REVENUE':
      return 'CREDIT';
  }
}

/** What an account of the chart is: its name and its classification. */
export interface LedgerAccountDefinition {
  readonly name: string;
  readonly classification: LedgerAccountClassification;
}

/**
 * The chart of accounts of a merchant's payments ledger. Every merchant gets
 * the same accounts, one per currency, created when a posting first needs
 * them. The ledger records the merchant's side of its own processor account:
 * the funds move from the processor straight to the merchant, and the
 * platform never holds them or owes them.
 *
 * - `1100` Processor receivable (asset): what the merchant's processor
 *   account owes the merchant for captured sales, gross of processor fees.
 * - `4000` Sales (revenue): the gross amount of the merchant's captured card
 *   sales.
 */
export const LEDGER_ACCOUNTS = {
  '1100': { name: 'Processor receivable', classification: 'ASSET' },
  '4000': { name: 'Sales', classification: 'REVENUE' },
} as const satisfies Readonly<Record<string, LedgerAccountDefinition>>;

export type LedgerAccountCode = keyof typeof LEDGER_ACCOUNTS;

/** The account debited by a sale. */
export const PROCESSOR_RECEIVABLE_ACCOUNT: LedgerAccountCode = '1100';

/** The account credited by a sale. */
export const SALES_ACCOUNT: LedgerAccountCode = '4000';

/** Whether a text is the code of an account of the chart. */
export function isLedgerAccountCode(value: string): value is LedgerAccountCode {
  return Object.hasOwn(LEDGER_ACCOUNTS, value);
}

/** The definition of an account of the chart. */
export function ledgerAccountDefinition(
  code: LedgerAccountCode,
): LedgerAccountDefinition {
  return LEDGER_ACCOUNTS[code];
}
