import type {
  Database,
  DatabaseTransaction,
  PaymentAuthorizationActionRow,
} from '@merchantflow/database';
import { createMoney, toPositiveMoney } from '@merchantflow/domain';
import type { AuthorizationAction } from '../application/authorization-action.js';

/** Statuses of an action that keeps any other action of its intent out. */
const BLOCKING_STATUSES = ['EXECUTING', 'UNKNOWN', 'SUCCEEDED'] as const;

/**
 * Maps a stored row back to the application. The table's checks guarantee a
 * positive amount; a currency that `Money` does not support is a row this
 * version cannot represent, so it throws.
 */
function toAuthorizationAction(
  row: PaymentAuthorizationActionRow,
): AuthorizationAction {
  const money = createMoney(row.amount_minor, row.currency);
  if (!money.ok) {
    throw new Error(
      `payment_authorization_actions row ${row.id} has an amount that Money rejects: ${money.code}`,
    );
  }
  const amount = toPositiveMoney(money.money);
  if (!amount.ok) {
    throw new Error(
      `payment_authorization_actions row ${row.id} has a non-positive amount`,
    );
  }
  return {
    id: row.id,
    merchantId: row.merchant_id,
    paymentIntentId: row.payment_intent_id,
    paymentAttemptId: row.payment_attempt_id,
    processorAccountId: row.processor_account_id,
    action: row.action,
    operationId: row.operation_id,
    idempotencyRecordId: row.idempotency_record_id,
    amount: amount.money,
    status: row.status,
    failureCode: row.failure_code,
    errorCategory: row.error_category,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Inserts a new action and returns it as stored. A second action of the same
 * intent that is not `FAILED` violates
 * `payment_authorization_actions_one_per_intent_idx`, and the
 * `payment_authorization_actions_capturable` trigger refuses an intent that is
 * not a `MANUAL` one in `REQUIRES_CAPTURE`; callers check both first, under
 * the intent's row lock, so the index and the trigger are the last defense.
 */
export async function insertAuthorizationAction(
  trx: DatabaseTransaction,
  action: AuthorizationAction,
): Promise<AuthorizationAction> {
  const row = await trx
    .insertInto('payment_authorization_actions')
    .values({
      id: action.id,
      merchant_id: action.merchantId,
      payment_intent_id: action.paymentIntentId,
      payment_attempt_id: action.paymentAttemptId,
      processor_account_id: action.processorAccountId,
      action: action.action,
      operation_id: action.operationId,
      idempotency_record_id: action.idempotencyRecordId,
      amount_minor: action.amount.amountMinor,
      currency: action.amount.currency,
      status: action.status,
      failure_code: action.failureCode,
      error_category: action.errorCategory,
      created_at: action.createdAt,
      updated_at: action.updatedAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toAuthorizationAction(row);
}

/** Every action of an intent of the merchant, oldest first. */
export async function listAuthorizationActions(
  db: Database,
  key: { readonly merchantId: string; readonly paymentIntentId: string },
): Promise<AuthorizationAction[]> {
  const rows = await db
    .selectFrom('payment_authorization_actions')
    .selectAll()
    .where('merchant_id', '=', key.merchantId)
    .where('payment_intent_id', '=', key.paymentIntentId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(toAuthorizationAction);
}

/**
 * The action of an intent of the merchant that keeps others out (`EXECUTING`,
 * `UNKNOWN`, or `SUCCEEDED`), or `undefined`. The partial unique index allows
 * at most one.
 */
export async function findBlockingAuthorizationAction(
  db: Database,
  key: { readonly merchantId: string; readonly paymentIntentId: string },
): Promise<AuthorizationAction | undefined> {
  const row = await db
    .selectFrom('payment_authorization_actions')
    .selectAll()
    .where('merchant_id', '=', key.merchantId)
    .where('payment_intent_id', '=', key.paymentIntentId)
    .where('status', 'in', BLOCKING_STATUSES)
    .executeTakeFirst();
  return row === undefined ? undefined : toAuthorizationAction(row);
}

/** An action of an intent of the merchant by its id, or `undefined`. */
export async function findAuthorizationAction(
  db: Database,
  key: {
    readonly merchantId: string;
    readonly paymentIntentId: string;
    readonly id: string;
  },
): Promise<AuthorizationAction | undefined> {
  const row = await db
    .selectFrom('payment_authorization_actions')
    .selectAll()
    .where('merchant_id', '=', key.merchantId)
    .where('payment_intent_id', '=', key.paymentIntentId)
    .where('id', '=', key.id)
    .executeTakeFirst();
  return row === undefined ? undefined : toAuthorizationAction(row);
}

/**
 * Applies a result to an action only while it still has the expected status
 * (`EXECUTING` after Execute, `UNKNOWN` after a lookup), and returns the
 * action as stored; `undefined` when no row matched, because the action is
 * not the merchant's or another writer already moved it. The action ID and
 * the expected status are the guard: actions have no lease yet (INC-04).
 */
export async function updateAuthorizationActionIfStatus(
  trx: DatabaseTransaction,
  change: {
    readonly merchantId: string;
    readonly id: string;
    readonly expectedStatus: AuthorizationAction['status'];
    readonly status: AuthorizationAction['status'];
    readonly failureCode: string | null;
    readonly errorCategory: AuthorizationAction['errorCategory'];
    readonly updatedAt: Date;
  },
): Promise<AuthorizationAction | undefined> {
  const row = await trx
    .updateTable('payment_authorization_actions')
    .set({
      status: change.status,
      failure_code: change.failureCode,
      error_category: change.errorCategory,
      updated_at: change.updatedAt,
    })
    .where('merchant_id', '=', change.merchantId)
    .where('id', '=', change.id)
    .where('status', '=', change.expectedStatus)
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? undefined : toAuthorizationAction(row);
}
