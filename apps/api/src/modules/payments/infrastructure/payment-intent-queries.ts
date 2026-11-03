import type {
  Database,
  NewPaymentIntentRow,
  PaymentIntentRow,
} from '@merchantflow/database';
import {
  createMoney,
  toPositiveMoney,
  type PaymentIntent,
  type PaymentIntentStatus,
} from '@merchantflow/domain';

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
