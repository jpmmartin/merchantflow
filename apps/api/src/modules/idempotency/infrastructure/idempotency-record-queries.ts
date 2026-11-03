import type { Database, IdempotencyRecordRow } from '@merchantflow/database';
import type {
  ClaimedIdempotencyRecord,
  IdempotencyRecord,
  IdempotencyRecordIdentity,
  IdempotencyRecordStatus,
  IdempotencyScope,
  IdempotentResponse,
} from '../application/idempotency-record.js';

function toRecord(row: IdempotencyRecordRow): IdempotencyRecord {
  const base = {
    id: row.id,
    merchantId: row.merchant_id,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    operationId: row.operation_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  if (row.status === 'IN_PROGRESS') {
    return { ...base, status: row.status };
  }
  if (
    row.response_status_code !== null &&
    row.response_body !== null &&
    row.completed_at !== null
  ) {
    return {
      ...base,
      status: row.status,
      response: {
        statusCode: row.response_status_code,
        body: row.response_body,
      },
      completedAt: row.completed_at,
    };
  }
  // idempotency_records_status_response_check makes this row impossible to store.
  throw new Error(
    `idempotency_records row ${row.id} is completed without a response`,
  );
}

/**
 * Inserts the record in progress unless its scope already has one, and tells
 * whether it was inserted. A scope that has a row inserted by a transaction
 * that has not ended yet makes this statement wait until that transaction
 * commits (nothing is inserted) or rolls back (this row is inserted).
 */
export async function insertIdempotencyRecordIfAbsent(
  db: Database,
  record: ClaimedIdempotencyRecord,
): Promise<boolean> {
  const inserted = await db
    .insertInto('idempotency_records')
    .values({
      id: record.id,
      merchant_id: record.merchantId,
      operation: record.operation,
      idempotency_key: record.idempotencyKey,
      request_fingerprint: record.requestFingerprint,
      operation_id: record.operationId,
      status: 'IN_PROGRESS',
      response_status_code: null,
      response_body: null,
      created_at: record.createdAt,
      completed_at: null,
      expires_at: record.expiresAt,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['merchant_id', 'operation', 'idempotency_key'])
        .doNothing(),
    )
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}

/** Returns the record of a scope, or `undefined` when the scope has none. */
export async function findIdempotencyRecordByScope(
  db: Database,
  scope: IdempotencyScope,
): Promise<IdempotencyRecord | undefined> {
  const row = await db
    .selectFrom('idempotency_records')
    .selectAll()
    .where('merchant_id', '=', scope.merchantId)
    .where('operation', '=', scope.operation)
    .where('idempotency_key', '=', scope.idempotencyKey)
    .executeTakeFirst();
  return row === undefined ? undefined : toRecord(row);
}

/** Returns the status of a record, or `undefined` when it does not exist. */
export async function findIdempotencyRecordStatus(
  db: Database,
  identity: IdempotencyRecordIdentity,
): Promise<IdempotencyRecordStatus | undefined> {
  const row = await db
    .selectFrom('idempotency_records')
    .select('status')
    .where('id', '=', identity.id)
    .where('merchant_id', '=', identity.merchantId)
    .executeTakeFirst();
  return row?.status;
}

/**
 * Completes a record only if it is still in progress, and returns how many rows
 * changed: 1 when the record was completed, 0 when it does not exist or is
 * already completed.
 */
export async function completeInProgressIdempotencyRecord(
  db: Database,
  change: {
    readonly identity: IdempotencyRecordIdentity;
    readonly response: IdempotentResponse;
    readonly completedAt: Date;
    readonly expiresAt: Date;
  },
): Promise<number> {
  const result = await db
    .updateTable('idempotency_records')
    .set({
      status: 'COMPLETED',
      response_status_code: change.response.statusCode,
      response_body: JSON.stringify(change.response.body),
      completed_at: change.completedAt,
      expires_at: change.expiresAt,
    })
    .where('id', '=', change.identity.id)
    .where('merchant_id', '=', change.identity.merchantId)
    .where('status', '=', 'IN_PROGRESS')
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
