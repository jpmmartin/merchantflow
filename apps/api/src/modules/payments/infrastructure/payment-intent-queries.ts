import type {
  Database,
  DatabaseTransaction,
  NewPaymentIntentRow,
  PaymentIntentRow,
} from '@merchantflow/database';
import {
  createMoney,
  toPositiveMoney,
  type PaymentIntent,
  type PaymentIntentStatus,
} from '@merchantflow/domain';
import type { KeysetPosition } from '../../pagination/keyset-cursor.js';

function toRow(intent: PaymentIntent): NewPaymentIntentRow {
  return {
    id: intent.id,
    merchant_id: intent.merchantId,
    amount_minor: intent.amount.amountMinor,
    currency: intent.amount.currency,
    merchant_reference: intent.merchantReference,
    // Assigning between the row union and the domain union in both directions
    // makes the compiler reject a status that only one of them lists.
    status: intent.status,
    created_at: intent.createdAt,
    updated_at: intent.updatedAt,
  };
}

/**
 * Maps a stored row back to the domain. The table's checks guarantee a
 * positive amount and a code of the right shape; a currency that `Money` does
 * not support is a row that this version of the application cannot represent,
 * so it is an error rather than a silent conversion.
 */
function toPaymentIntent(row: PaymentIntentRow): PaymentIntent {
  const status: PaymentIntentStatus = row.status;
  const money = createMoney(row.amount_minor, row.currency);
  if (!money.ok) {
    throw new Error(
      `payment_intents row ${row.id} has an amount that Money rejects: ${money.code}`,
    );
  }
  const amount = toPositiveMoney(money.money);
  if (!amount.ok) {
    throw new Error(`payment_intents row ${row.id} has a non-positive amount`);
  }
  return {
    id: row.id,
    merchantId: row.merchant_id,
    amount: amount.money,
    merchantReference: row.merchant_reference,
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Returns the intent with the given id that belongs to the given merchant, or
 * `undefined` when there is none. One statement filters by both, so another
 * merchant's intent and a missing one are the same empty result and the row of
 * another tenant is never read. A stored row that the domain cannot represent
 * throws, as in `toPaymentIntent`.
 */
export async function findPaymentIntentByIdForMerchant(
  db: Database,
  merchantId: string,
  id: string,
): Promise<PaymentIntent | undefined> {
  const row = await db
    .selectFrom('payment_intents')
    .selectAll()
    .where('merchant_id', '=', merchantId)
    .where('id', '=', id)
    .executeTakeFirst();
  return row === undefined ? undefined : toPaymentIntent(row);
}

/**
 * Like `findPaymentIntentByIdForMerchant`, and locks the row `FOR UPDATE` until
 * the caller's transaction ends, so no other command of the same intent can
 * change its status or start an attempt meanwhile.
 */
export async function findPaymentIntentByIdForMerchantForUpdate(
  trx: DatabaseTransaction,
  merchantId: string,
  id: string,
): Promise<PaymentIntent | undefined> {
  const row = await trx
    .selectFrom('payment_intents')
    .selectAll()
    .where('merchant_id', '=', merchantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? undefined : toPaymentIntent(row);
}

/**
 * Moves an intent of the merchant from one status to another only while it is
 * still in `from`, and returns it as stored; `undefined` when no row matched.
 * The caller asks `evaluatePaymentIntentTransition` first.
 */
export async function updatePaymentIntentStatusIfCurrent(
  trx: DatabaseTransaction,
  change: {
    readonly merchantId: string;
    readonly id: string;
    readonly from: PaymentIntentStatus;
    readonly to: PaymentIntentStatus;
    readonly updatedAt: Date;
  },
): Promise<PaymentIntent | undefined> {
  const row = await trx
    .updateTable('payment_intents')
    .set({ status: change.to, updated_at: change.updatedAt })
    .where('merchant_id', '=', change.merchantId)
    .where('id', '=', change.id)
    .where('status', '=', change.from)
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? undefined : toPaymentIntent(row);
}

/**
 * Inserts the intent unless its merchant already has one with the same
 * `merchant_reference`, and returns the intent as PostgreSQL stored it, read
 * back through `RETURNING`, or `undefined` when nothing was inserted. The conflict is
 * resolved by `payment_intents_merchant_reference_key` without raising an
 * error, so the caller's transaction stays usable. A reference that another
 * transaction inserted and has not committed yet makes this statement wait
 * until that transaction commits (nothing is inserted) or rolls back (this row
 * is inserted). Any other violation, such as of the primary key, still throws.
 */
export async function insertPaymentIntentIfReferenceAbsent(
  db: Database,
  intent: PaymentIntent,
): Promise<PaymentIntent | undefined> {
  const row = await db
    .insertInto('payment_intents')
    .values(toRow(intent))
    .onConflict((conflict) =>
      conflict.columns(['merchant_id', 'merchant_reference']).doNothing(),
    )
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? undefined : toPaymentIntent(row);
}

/**
 * Returns up to `limit` intents of one merchant, newest first: ordered by
 * `(created_at, id)` descending, starting after `after` when it is given, and
 * only those with `status` when it is given. The merchant filter is always
 * applied, so no row of another tenant is read. The index
 * `payment_intents_merchant_id_created_at_id_idx`, scanned backwards, serves
 * the filter, the order, and the continuation without a sort; the status is
 * checked on the rows the scan reaches. `id` makes the order total, so a walk
 * over pages neither repeats nor skips an intent that existed when it began.
 */
export async function listPaymentIntentsForMerchant(
  db: Database,
  page: {
    readonly merchantId: string;
    readonly limit: number;
    readonly after?: KeysetPosition | undefined;
    readonly status?: PaymentIntentStatus | undefined;
  },
): Promise<PaymentIntent[]> {
  let query = db
    .selectFrom('payment_intents')
    .selectAll()
    .where('merchant_id', '=', page.merchantId);
  if (page.status !== undefined) {
    query = query.where('status', '=', page.status);
  }
  if (page.after !== undefined) {
    // A row comparison, so that an intent with the same creation time as the
    // last one on the previous page is ordered by id instead of being skipped.
    const { createdAt, id } = page.after;
    query = query.where((eb) =>
      eb(eb.refTuple('created_at', 'id'), '<', eb.tuple(createdAt, id)),
    );
  }
  const rows = await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(page.limit)
    .execute();
  return rows.map(toPaymentIntent);
}

/** A successful attempt and its intent, as the ledger backfill reads them. */
export interface SucceededSale {
  readonly attemptId: string;
  readonly attemptCreatedAt: Date;
  readonly intent: PaymentIntent;
}

/**
 * A page of every merchant's successful attempts with their intents, oldest
 * first by the attempt's creation time and then its id. Only the ledger
 * backfill reads across merchants; each row keeps its own merchant.
 */
export async function listSucceededSales(
  db: Database,
  page: {
    readonly limit: number;
    readonly after?: KeysetPosition | undefined;
  },
): Promise<SucceededSale[]> {
  let query = db
    .selectFrom('payment_attempts as a')
    .innerJoin('payment_intents as i', (join) =>
      join
        .onRef('i.merchant_id', '=', 'a.merchant_id')
        .onRef('i.id', '=', 'a.payment_intent_id'),
    )
    .where('a.status', '=', 'SUCCEEDED')
    .selectAll('i')
    .select(['a.id as attempt_id', 'a.created_at as attempt_created_at']);
  if (page.after !== undefined) {
    const { createdAt, id } = page.after;
    query = query.where((eb) =>
      eb(eb.refTuple('a.created_at', 'a.id'), '>', eb.tuple(createdAt, id)),
    );
  }
  const rows = await query
    .orderBy('a.created_at')
    .orderBy('a.id')
    .limit(page.limit)
    .execute();
  return rows.map(({ attempt_id, attempt_created_at, ...intent }) => ({
    attemptId: attempt_id,
    attemptCreatedAt: attempt_created_at,
    intent: toPaymentIntent(intent),
  }));
}
