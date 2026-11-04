import { toAmountMinorString } from '@merchantflow/domain';
import { encodeKeysetCursor } from '../../pagination/keyset-cursor.js';
import type {
  JournalEntry,
  LedgerAccountBalance,
} from '../application/ledger.js';
import type { JournalEntryPage } from '../application/list-journal-entries.service.js';
import type {
  JournalEntryListResponse,
  JournalEntryResponse,
  LedgerBalancesResponse,
} from './ledger.schemas.js';

/** The balances of a merchant's accounts, amounts as integer strings. */
export function toLedgerBalancesResponse(
  merchantId: string,
  balances: readonly LedgerAccountBalance[],
): LedgerBalancesResponse {
  return {
    merchant_id: merchantId,
    data: balances.map(({ account, normalSide, debits, credits, balance }) => ({
      account_id: account.id,
      code: account.code,
      name: account.name,
      classification: account.classification,
      normal_side: normalSide,
      currency: account.currency,
      debit_total_minor: toAmountMinorString(debits),
      credit_total_minor: toAmountMinorString(credits),
      balance_minor: toAmountMinorString(balance),
      created_at: account.createdAt.toISOString(),
    })),
  };
}

/** The body of one journal entry with its lines. */
export function toJournalEntryResponse(
  entry: JournalEntry,
): JournalEntryResponse {
  return {
    id: entry.id,
    merchant_id: entry.merchantId,
    source_type: entry.sourceType,
    source_id: entry.sourceId,
    payment_intent_id: entry.paymentIntentId,
    description: entry.description,
    posted_at: entry.postedAt.toISOString(),
    lines: entry.lines.map((line) => ({
      line_number: line.lineNumber,
      ledger_account_id: line.ledgerAccountId,
      account_code: line.accountCode,
      account_name: line.accountName,
      side: line.side,
      amount_minor: toAmountMinorString(line.amount),
      currency: line.amount.currency,
    })),
  };
}

/** One page of a merchant's entries, each with the body of a single read. */
export function toJournalEntryListResponse(
  page: JournalEntryPage,
): JournalEntryListResponse {
  return {
    merchant_id: page.merchantId,
    data: page.entries.map(toJournalEntryResponse),
    next_cursor: page.next === undefined ? null : encodeKeysetCursor(page.next),
  };
}
