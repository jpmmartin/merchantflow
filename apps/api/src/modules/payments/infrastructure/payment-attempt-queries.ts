import type {
  Database,
  DatabaseTransaction,
  PaymentAttemptRow,
} from '@merchantflow/database';
import type { PaymentAttempt } from '../application/payment-attempt.js';

/** Statuses of an attempt that blocks a new attempt of its intent. */
const OPEN_STATUSES = ['EXECUTING', 'REQUIRES_ACTION', 'UNKNOWN'] as const;

function toPaymentAttempt(row: PaymentAttemptRow): PaymentAttempt {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    paymentIntentId: row.payment_intent_id,
    processorAccountId: row.processor_account_id,
    operationId: row.operation_id,
    idempotencyRecordId: row.idempotency_record_id,
    status: row.status,
    providerTransactionId: row.provider_transaction_id,
    declineCode: row.decline_code,
    errorCategory: row.error_category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Inserts a new attempt and returns it as stored. A second open attempt of
 * the same intent violates `payment_attempts_one_open_per_intent_idx` and
 * throws; callers check for an open attempt first, under the intent's row
 * lock, so the index is the last line of defense.
 */
export async function insertPaymentAttempt(
  trx: DatabaseTransaction,
  attempt: PaymentAttempt,
): Promise<PaymentAttempt> {
  const row = await trx
    .insertInto('payment_attempts')
    .values({
      id: attempt.id,
      merchant_id: attempt.merchantId,
      payment_intent_id: attempt.paymentIntentId,
      processor_account_id: attempt.processorAccountId,
      operation_id: attempt.operationId,
      idempotency_record_id: attempt.idempotencyRecordId,
      status: attempt.status,
      provider_transaction_id: attempt.providerTransactionId,
      decline_code: attempt.declineCode,
      error_category: attempt.errorCategory,
      created_at: attempt.createdAt,
      updated_at: attempt.updatedAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toPaymentAttempt(row);
}

/**
 * The open attempt (`EXECUTING`, `REQUIRES_ACTION`, or `UNKNOWN`) of an
 * intent of the merchant, or `undefined`. The partial unique index allows at
 * most one.
 */
export async function findOpenPaymentAttempt(
  db: Database,
  key: { readonly merchantId: string; readonly paymentIntentId: string },
): Promise<PaymentAttempt | undefined> {
  const row = await db
    .selectFrom('payment_attempts')
    .selectAll()
    .where('merchant_id', '=', key.merchantId)
    .where('payment_intent_id', '=', key.paymentIntentId)
    .where('status', 'in', OPEN_STATUSES)
    .executeTakeFirst();
  return row === undefined ? undefined : toPaymentAttempt(row);
}

/**
 * Applies a result to an attempt only while it still has the expected status,
 * and returns the attempt as stored; `undefined` when no row matched, because
 * the attempt is not the merchant's or another writer already moved it. The
 * attempt ID and the expected status are the guard: attempts have no lease
 * yet (INC-04).
 */
export async function updatePaymentAttemptIfStatus(
  trx: DatabaseTransaction,
  change: {
    readonly merchantId: string;
    readonly id: string;
    readonly expectedStatus: PaymentAttempt['status'];
    readonly status: PaymentAttempt['status'];
    readonly providerTransactionId: string | null;
    readonly declineCode: string | null;
    readonly errorCategory: PaymentAttempt['errorCategory'];
    readonly updatedAt: Date;
  },
): Promise<PaymentAttempt | undefined> {
  const row = await trx
    .updateTable('payment_attempts')
    .set({
      status: change.status,
      provider_transaction_id: change.providerTransactionId,
      decline_code: change.declineCode,
      error_category: change.errorCategory,
      updated_at: change.updatedAt,
    })
    .where('merchant_id', '=', change.merchantId)
    .where('id', '=', change.id)
    .where('status', '=', change.expectedStatus)
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? undefined : toPaymentAttempt(row);
}

/**
 * How many attempts of an intent ended unsuccessfully: declined, or failed
 * with proven non-execution. Run it in the transaction that applied the latest
 * result, so the count includes it.
 */
export async function countUnsuccessfulPaymentAttempts(
  trx: DatabaseTransaction,
  key: { readonly merchantId: string; readonly paymentIntentId: string },
): Promise<number> {
  const row = await trx
    .selectFrom('payment_attempts')
    // count(*) is a BIGINT, which the pool reads as a bigint (AD-34).
    .select((eb) => eb.fn.countAll<bigint>().as('count'))
    .where('merchant_id', '=', key.merchantId)
    .where('payment_intent_id', '=', key.paymentIntentId)
    .where('status', 'in', ['DECLINED', 'FAILED'])
    .executeTakeFirstOrThrow();
  // A count of an intent's attempts is a small whole number, not an amount.
  return Number(row.count);
}

/** Every attempt of an intent of the merchant, oldest first. */
export async function listPaymentAttempts(
  db: Database,
  key: { readonly merchantId: string; readonly paymentIntentId: string },
): Promise<PaymentAttempt[]> {
  const rows = await db
    .selectFrom('payment_attempts')
    .selectAll()
    .where('merchant_id', '=', key.merchantId)
    .where('payment_intent_id', '=', key.paymentIntentId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(toPaymentAttempt);
}

/**
 * The successful attempt of an intent of the merchant, or `undefined`. The
 * partial unique index `payment_attempts_one_succeeded_per_intent_idx` allows
 * at most one.
 */
export async function findSucceededPaymentAttempt(
  db: Database,
  key: { readonly merchantId: string; readonly paymentIntentId: string },
): Promise<PaymentAttempt | undefined> {
  const row = await db
    .selectFrom('payment_attempts')
    .selectAll()
    .where('merchant_id', '=', key.merchantId)
    .where('payment_intent_id', '=', key.paymentIntentId)
    .where('status', '=', 'SUCCEEDED')
    .executeTakeFirst();
  return row === undefined ? undefined : toPaymentAttempt(row);
}
