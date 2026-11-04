import type {
  Database,
  DatabaseTransaction,
  RefundRow,
} from '@merchantflow/database';
import { createMoney, toPositiveMoney } from '@merchantflow/domain';
import type { Refund } from '../application/refund.js';

/**
 * Maps a stored row back to the application. The table's checks guarantee a
 * positive amount; a currency that `Money` does not support is a row this
 * version cannot represent, so it throws.
 */
function toRefund(row: RefundRow): Refund {
  const money = createMoney(row.amount_minor, row.currency);
  if (!money.ok) {
    throw new Error(
      `refunds row ${row.id} has an amount that Money rejects: ${money.code}`,
    );
  }
  const amount = toPositiveMoney(money.money);
  if (!amount.ok) {
    throw new Error(`refunds row ${row.id} has a non-positive amount`);
  }
  return {
    id: row.id,
    merchantId: row.merchant_id,
    paymentIntentId: row.payment_intent_id,
    paymentAttemptId: row.payment_attempt_id,
    processorAccountId: row.processor_account_id,
    operationId: row.operation_id,
    idempotencyRecordId: row.idempotency_record_id,
    amount: amount.money,
    status: row.status,
    providerRefundId: row.provider_refund_id,
    failureCode: row.failure_code,
    errorCategory: row.error_category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Inserts a new refund and returns it as stored. The
 * `refunds_within_captured` trigger refuses a refund of an intent that is not
 * `SUCCEEDED` or `PARTIALLY_REFUNDED`, or one that would take the refunds that
 * did not fail above the intent's amount; callers check both first, under the
 * intent's row lock, so the trigger is the last line of defense.
 */
export async function insertRefund(
  trx: DatabaseTransaction,
  refund: Refund,
): Promise<Refund> {
  const row = await trx
    .insertInto('refunds')
    .values({
      id: refund.id,
      merchant_id: refund.merchantId,
      payment_intent_id: refund.paymentIntentId,
      payment_attempt_id: refund.paymentAttemptId,
      processor_account_id: refund.processorAccountId,
      operation_id: refund.operationId,
      idempotency_record_id: refund.idempotencyRecordId,
      amount_minor: refund.amount.amountMinor,
      currency: refund.amount.currency,
      status: refund.status,
      provider_refund_id: refund.providerRefundId,
      failure_code: refund.failureCode,
      error_category: refund.errorCategory,
      created_at: refund.createdAt,
      updated_at: refund.updatedAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRefund(row);
}

/** Every refund of an intent of the merchant, oldest first. */
export async function listRefunds(
  db: Database,
  key: { readonly merchantId: string; readonly paymentIntentId: string },
): Promise<Refund[]> {
  const rows = await db
    .selectFrom('refunds')
    .selectAll()
    .where('merchant_id', '=', key.merchantId)
    .where('payment_intent_id', '=', key.paymentIntentId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(toRefund);
}

/**
 * Applies a provider result to a refund only while it is still `EXECUTING`,
 * and returns the refund as stored; `undefined` when no row matched, because
 * the refund is not the merchant's or another writer already moved it. The
 * refund ID and `EXECUTING` are the guard: refunds have no lease yet (INC-04).
 */
export async function updateRefundIfExecuting(
  trx: DatabaseTransaction,
  change: {
    readonly merchantId: string;
    readonly id: string;
    readonly status: Refund['status'];
    readonly providerRefundId: string | null;
    readonly failureCode: string | null;
    readonly errorCategory: Refund['errorCategory'];
    readonly updatedAt: Date;
  },
): Promise<Refund | undefined> {
  const row = await trx
    .updateTable('refunds')
    .set({
      status: change.status,
      provider_refund_id: change.providerRefundId,
      failure_code: change.failureCode,
      error_category: change.errorCategory,
      updated_at: change.updatedAt,
    })
    .where('merchant_id', '=', change.merchantId)
    .where('id', '=', change.id)
    .where('status', '=', 'EXECUTING')
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? undefined : toRefund(row);
}
