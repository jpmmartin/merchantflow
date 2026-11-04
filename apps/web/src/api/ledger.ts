import { apiRequest } from './client';

export type LedgerAccountClassification =
  'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE';

export type JournalLineSide = 'DEBIT' | 'CREDIT';

/** An account with its totals and balance; amounts are integer strings. */
export interface LedgerAccountBalance {
  readonly account_id: string;
  readonly code: string;
  readonly name: string;
  readonly classification: LedgerAccountClassification;
  readonly normal_side: JournalLineSide;
  readonly currency: string;
  readonly debit_total_minor: string;
  readonly credit_total_minor: string;
  /** Signed: negative when the account is on the other side of its normal one. */
  readonly balance_minor: string;
  readonly created_at: string;
}

export interface LedgerBalances {
  readonly merchant_id: string;
  readonly data: readonly LedgerAccountBalance[];
}

export interface JournalLine {
  readonly line_number: number;
  readonly ledger_account_id: string;
  readonly account_code: string;
  readonly account_name: string;
  readonly side: JournalLineSide;
  readonly amount_minor: string;
  readonly currency: string;
}

export interface JournalEntry {
  readonly id: string;
  readonly merchant_id: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly payment_intent_id: string | null;
  readonly description: string;
  readonly posted_at: string;
  readonly lines: readonly JournalLine[];
}

export interface JournalEntryPage {
  readonly merchant_id: string;
  readonly data: readonly JournalEntry[];
  readonly next_cursor: string | null;
}

function ledgerPath(merchantId: string): string {
  return `/merchants/${encodeURIComponent(merchantId)}/ledger`;
}

/** Every ledger account of a merchant with its balance. */
export async function getLedgerBalances(
  merchantId: string,
): Promise<LedgerBalances> {
  return (await apiRequest(
    'GET',
    `${ledgerPath(merchantId)}/balances`,
  )) as LedgerBalances;
}

/**
 * One page of a merchant's journal entries, newest first, optionally only
 * those of one payment intent.
 */
export async function listJournalEntries(
  merchantId: string,
  page: {
    readonly cursor?: string | undefined;
    readonly paymentIntentId?: string | undefined;
  },
): Promise<JournalEntryPage> {
  const query = new URLSearchParams();
  if (page.paymentIntentId !== undefined) {
    query.set('payment_intent_id', page.paymentIntentId);
  }
  if (page.cursor !== undefined) query.set('cursor', page.cursor);
  const text = query.toString();
  return (await apiRequest(
    'GET',
    `${ledgerPath(merchantId)}/journal-entries${text === '' ? '' : `?${text}`}`,
  )) as JournalEntryPage;
}
