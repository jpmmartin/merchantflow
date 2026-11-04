import type { Database, ProcessorEventRow } from '@merchantflow/database';
import type {
  ProcessorEventOutcome,
  ProcessorEventRecord,
} from '../application/processor-event.js';

function toRecord(row: ProcessorEventRow): ProcessorEventRecord {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    processorAccountId: row.processor_account_id,
    providerEventId: row.provider_event_id,
    eventType: row.event_type,
    objectType: row.object_type,
    objectId: row.object_id,
    receivedAt: row.received_at,
    attempts: row.attempts,
    outcome: row.outcome,
    detail: row.detail,
    processedAt: row.processed_at,
  };
}

/**
 * Stores a received event unless the account already has one with the same
 * provider event ID, and returns the stored row: the new one, or the one an
 * earlier delivery stored. `processor_events_delivery_key` is the arbiter.
 */
export async function insertProcessorEventIfAbsent(
  db: Database,
  event: Omit<
    ProcessorEventRecord,
    'attempts' | 'outcome' | 'detail' | 'processedAt'
  >,
): Promise<{
  readonly record: ProcessorEventRecord;
  readonly inserted: boolean;
}> {
  const inserted = await db
    .insertInto('processor_events')
    .values({
      id: event.id,
      merchant_id: event.merchantId,
      processor_account_id: event.processorAccountId,
      provider_event_id: event.providerEventId,
      event_type: event.eventType,
      object_type: event.objectType,
      object_id: event.objectId,
      received_at: event.receivedAt,
      attempts: 0,
      outcome: null,
      detail: null,
      processed_at: null,
    })
    .onConflict((oc) =>
      oc.columns(['processor_account_id', 'provider_event_id']).doNothing(),
    )
    .returningAll()
    .executeTakeFirst();
  if (inserted !== undefined) {
    return { record: toRecord(inserted), inserted: true };
  }
  const existing = await db
    .selectFrom('processor_events')
    .selectAll()
    .where('merchant_id', '=', event.merchantId)
    .where('processor_account_id', '=', event.processorAccountId)
    .where('provider_event_id', '=', event.providerEventId)
    .executeTakeFirstOrThrow();
  return { record: toRecord(existing), inserted: false };
}

/**
 * Counts one more processing run of an event whose outcome is not final, and
 * returns it; `undefined` when another delivery recorded a final outcome
 * first.
 */
export async function startProcessorEventAttempt(
  db: Database,
  key: { readonly merchantId: string; readonly id: string },
): Promise<ProcessorEventRecord | undefined> {
  const row = await db
    .updateTable('processor_events')
    .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
    .where('merchant_id', '=', key.merchantId)
    .where('id', '=', key.id)
    .where((eb) =>
      eb.or([eb('outcome', 'is', null), eb('outcome', '=', 'FAILED')]),
    )
    .returningAll()
    .executeTakeFirst();
  return row === undefined ? undefined : toRecord(row);
}

/**
 * Records the outcome of a processing run, only while the event's outcome is
 * not final; returns whether it was recorded.
 */
export async function recordProcessorEventOutcome(
  db: Database,
  change: {
    readonly merchantId: string;
    readonly id: string;
    readonly outcome: ProcessorEventOutcome;
    readonly detail: string;
    readonly processedAt: Date;
  },
): Promise<boolean> {
  const result = await db
    .updateTable('processor_events')
    .set({
      outcome: change.outcome,
      detail: change.detail,
      processed_at: change.processedAt,
    })
    .where('merchant_id', '=', change.merchantId)
    .where('id', '=', change.id)
    .where((eb) =>
      eb.or([eb('outcome', 'is', null), eb('outcome', '=', 'FAILED')]),
    )
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/** The latest events of one account of the merchant, newest first. */
export async function listRecentProcessorEvents(
  db: Database,
  key: {
    readonly merchantId: string;
    readonly processorAccountId: string;
    readonly limit: number;
  },
): Promise<readonly ProcessorEventRecord[]> {
  const rows = await db
    .selectFrom('processor_events')
    .selectAll()
    .where('merchant_id', '=', key.merchantId)
    .where('processor_account_id', '=', key.processorAccountId)
    .orderBy('received_at', 'desc')
    .orderBy('id', 'desc')
    .limit(key.limit)
    .execute();
  return rows.map(toRecord);
}
