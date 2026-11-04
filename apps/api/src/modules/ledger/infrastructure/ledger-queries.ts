import type {
  Database,
  DatabaseTransaction,
  JournalEntryRow,
  LedgerAccountRow,
} from '@merchantflow/database';
import {
  createMoney,
  toPositiveMoney,
  type LedgerAccountClassification,
  type Money,
  type PositiveMoney,
} from '@merchantflow/domain';
import type { KeysetPosition } from '../../pagination/keyset-cursor.js';
import type {
  JournalEntry,
  JournalLine,
  JournalSourceType,
  LedgerAccount,
} from '../application/ledger.js';

/** Money read from a `BIGINT` column; a value the domain refuses is a defect. */
function moneyOf(amountMinor: bigint, currency: string): Money {
  const money = createMoney(amountMinor, currency);
  if (!money.ok) {
    throw new Error(
      `stored ledger amount cannot be represented: ${money.code}`,
    );
  }
  return money.money;
}

function positiveMoneyOf(amountMinor: bigint, currency: string): PositiveMoney {
  const positive = toPositiveMoney(moneyOf(amountMinor, currency));
  if (!positive.ok) {
    throw new Error('stored journal line amount is not positive');
  }
  return positive.money;
}

function toLedgerAccount(row: LedgerAccountRow): LedgerAccount {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    code: row.code,
    name: row.name,
    classification: row.classification,
    currency: row.currency,
    createdAt: row.created_at,
  };
}

/**
 * Returns the merchant's account of a code and currency, creating it first if
 * it does not exist. The insert does nothing when the account exists, also
 * when another transaction has just created it: under READ COMMITTED the
 * insert waits for that transaction, and the select that follows, a new
 * statement, reads its committed row.
 */
export async function ensureLedgerAccount(
  trx: DatabaseTransaction,
  account: {
    readonly id: string;
    readonly merchantId: string;
    readonly code: string;
    readonly name: string;
    readonly classification: LedgerAccountClassification;
    readonly currency: string;
    readonly createdAt: Date;
  },
): Promise<LedgerAccount> {
  await trx
    .insertInto('ledger_accounts')
    .values({
      id: account.id,
      merchant_id: account.merchantId,
      code: account.code,
      name: account.name,
      classification: account.classification,
      currency: account.currency,
      created_at: account.createdAt,
    })
    .onConflict((conflict) =>
      conflict.columns(['merchant_id', 'code', 'currency']).doNothing(),
    )
    .execute();
  const row = await trx
    .selectFrom('ledger_accounts')
    .selectAll()
    .where('merchant_id', '=', account.merchantId)
    .where('code', '=', account.code)
    .where('currency', '=', account.currency)
    .executeTakeFirstOrThrow();
  return toLedgerAccount(row);
}

/** Inserts an entry and its lines; the balance is checked at commit. */
export async function insertJournalEntry(
  trx: DatabaseTransaction,
  entry: {
    readonly id: string;
    readonly merchantId: string;
    readonly sourceType: JournalSourceType;
    readonly sourceId: string;
    readonly paymentIntentId: string | null;
    readonly description: string;
    readonly postedAt: Date;
    readonly lines: readonly {
      readonly id: string;
      readonly ledgerAccountId: string;
      readonly side: 'DEBIT' | 'CREDIT';
      readonly amount: PositiveMoney;
    }[];
  },
): Promise<void> {
  await trx
    .insertInto('journal_entries')
    .values({
      id: entry.id,
      merchant_id: entry.merchantId,
      source_type: entry.sourceType,
      source_id: entry.sourceId,
      payment_intent_id: entry.paymentIntentId,
      description: entry.description,
      line_count: entry.lines.length,
      posted_at: entry.postedAt,
    })
    .execute();
  await trx
    .insertInto('journal_lines')
    .values(
      entry.lines.map((line, index) => ({
        id: line.id,
        merchant_id: entry.merchantId,
        journal_entry_id: entry.id,
        line_number: index + 1,
        ledger_account_id: line.ledgerAccountId,
        side: line.side,
        amount_minor: line.amount.amountMinor,
        currency: line.amount.currency,
      })),
    )
    .execute();
}

/** Every account of a merchant with the totals of its debit and credit lines. */
export async function listLedgerAccountTotals(
  db: Database,
  merchantId: string,
): Promise<
  {
    readonly account: LedgerAccount;
    readonly debits: Money;
    readonly credits: Money;
  }[]
> {
  const rows = await db
    .selectFrom('ledger_accounts as a')
    .leftJoin('journal_lines as l', (join) =>
      join
        .onRef('l.merchant_id', '=', 'a.merchant_id')
        .onRef('l.ledger_account_id', '=', 'a.id'),
    )
    .where('a.merchant_id', '=', merchantId)
    .groupBy('a.id')
    .select((eb) => [
      'a.id',
      'a.merchant_id',
      'a.code',
      'a.name',
      'a.classification',
      'a.currency',
      'a.created_at',
      // The sum of a BIGINT column is numeric; the cast keeps it a BIGINT,
      // which the pool reads as a bigint, and fails rather than round.
      eb
        .cast<bigint>(
          eb.fn.coalesce(
            eb.fn.sum('l.amount_minor').filterWhere('l.side', '=', 'DEBIT'),
            eb.lit(0),
          ),
          'bigint',
        )
        .as('debit_total'),
      eb
        .cast<bigint>(
          eb.fn.coalesce(
            eb.fn.sum('l.amount_minor').filterWhere('l.side', '=', 'CREDIT'),
            eb.lit(0),
          ),
          'bigint',
        )
        .as('credit_total'),
    ])
    .orderBy('a.code')
    .orderBy('a.currency')
    .execute();
  return rows.map((row) => ({
    account: toLedgerAccount(row),
    debits: moneyOf(row.debit_total, row.currency),
    credits: moneyOf(row.credit_total, row.currency),
  }));
}

/** The lines of some entries of a merchant, with their account's code and name. */
async function linesOf(
  db: Database,
  merchantId: string,
  entryIds: readonly string[],
): Promise<Map<string, JournalLine[]>> {
  const lines = new Map<string, JournalLine[]>();
  if (entryIds.length === 0) return lines;
  const rows = await db
    .selectFrom('journal_lines as l')
    .innerJoin('ledger_accounts as a', (join) =>
      join
        .onRef('a.merchant_id', '=', 'l.merchant_id')
        .onRef('a.id', '=', 'l.ledger_account_id'),
    )
    .where('l.merchant_id', '=', merchantId)
    .where('l.journal_entry_id', 'in', entryIds)
    .select([
      'l.journal_entry_id',
      'l.line_number',
      'l.ledger_account_id',
      'l.side',
      'l.amount_minor',
      'l.currency',
      'a.code',
      'a.name',
    ])
    .orderBy('l.journal_entry_id')
    .orderBy('l.line_number')
    .execute();
  for (const row of rows) {
    const list = lines.get(row.journal_entry_id) ?? [];
    list.push({
      lineNumber: row.line_number,
      ledgerAccountId: row.ledger_account_id,
      accountCode: row.code,
      accountName: row.name,
      side: row.side,
      amount: positiveMoneyOf(row.amount_minor, row.currency),
    });
    lines.set(row.journal_entry_id, list);
  }
  return lines;
}

function toJournalEntry(
  row: JournalEntryRow,
  lines: Map<string, JournalLine[]>,
): JournalEntry {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    paymentIntentId: row.payment_intent_id,
    description: row.description,
    postedAt: row.posted_at,
    lines: lines.get(row.id) ?? [],
  };
}

/**
 * A page of a merchant's entries, newest first by posting time and then id,
 * optionally of one payment intent, each with its lines.
 */
export async function listJournalEntries(
  db: Database,
  page: {
    readonly merchantId: string;
    readonly limit: number;
    readonly after?: KeysetPosition | undefined;
    readonly paymentIntentId?: string | undefined;
  },
): Promise<JournalEntry[]> {
  let query = db
    .selectFrom('journal_entries')
    .selectAll()
    .where('merchant_id', '=', page.merchantId);
  if (page.paymentIntentId !== undefined) {
    query = query.where('payment_intent_id', '=', page.paymentIntentId);
  }
  if (page.after !== undefined) {
    // The position's time is the posting time of the last entry of the page.
    const { createdAt, id } = page.after;
    query = query.where((eb) =>
      eb(eb.refTuple('posted_at', 'id'), '<', eb.tuple(createdAt, id)),
    );
  }
  const rows = await query
    .orderBy('posted_at', 'desc')
    .orderBy('id', 'desc')
    .limit(page.limit)
    .execute();
  const lines = await linesOf(
    db,
    page.merchantId,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toJournalEntry(row, lines));
}

/** One entry of a merchant with its lines, or undefined. */
export async function findJournalEntry(
  db: Database,
  key: { readonly merchantId: string; readonly id: string },
): Promise<JournalEntry | undefined> {
  const row = await db
    .selectFrom('journal_entries')
    .selectAll()
    .where('merchant_id', '=', key.merchantId)
    .where('id', '=', key.id)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return toJournalEntry(row, await linesOf(db, key.merchantId, [row.id]));
}

/** The id of the entry posted for a source, or undefined. */
export async function findJournalEntryIdBySource(
  trx: DatabaseTransaction,
  source: { readonly sourceType: JournalSourceType; readonly sourceId: string },
): Promise<string | undefined> {
  const row = await trx
    .selectFrom('journal_entries')
    .select('id')
    .where('source_type', '=', source.sourceType)
    .where('source_id', '=', source.sourceId)
    .executeTakeFirst();
  return row?.id;
}
