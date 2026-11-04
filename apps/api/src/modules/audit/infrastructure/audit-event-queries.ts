import type { AuditEventRow, Database } from '@merchantflow/database';
import type { KeysetPosition } from '../../pagination/keyset-cursor.js';
import type { AuditEvent } from '../application/audit-event.js';

/**
 * Appends one event to the audit trail. Pass the transaction of the change
 * being audited so that both commit together. PostgreSQL rejects an event that
 * breaks a constraint, which surfaces as a thrown database error.
 */
export async function appendAuditEvent(
  db: Database,
  event: AuditEvent,
): Promise<void> {
  await db
    .insertInto('audit_events')
    .values({
      id: event.id,
      occurred_at: event.occurredAt,
      actor_type: event.actorType,
      actor_id: event.actorId,
      action: event.action,
      target_type: event.targetType,
      target_id: event.targetId,
      merchant_id: event.merchantId,
      correlation_id: event.correlationId,
      metadata: JSON.stringify(event.metadata),
    })
    .execute();
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    merchantId: row.merchant_id,
    correlationId: row.correlation_id,
    metadata: row.metadata,
  };
}

/**
 * A page of the audit trail, newest first by `(occurred_at, id)`. With a
 * merchant, only that merchant's events (never those with no merchant); with
 * `ALL`, every event. `from` is inclusive and `to` exclusive.
 */
export async function listAuditEvents(
  db: Database,
  page: {
    readonly scope:
      | { readonly kind: 'ALL' }
      | { readonly kind: 'MERCHANT'; readonly merchantId: string };
    readonly limit: number;
    readonly after?: KeysetPosition | undefined;
    readonly action?: string | undefined;
    readonly from?: Date | undefined;
    readonly to?: Date | undefined;
  },
): Promise<AuditEvent[]> {
  let query = db.selectFrom('audit_events').selectAll();
  if (page.scope.kind === 'MERCHANT') {
    query = query.where('merchant_id', '=', page.scope.merchantId);
  }
  if (page.action !== undefined) {
    query = query.where('action', '=', page.action);
  }
  if (page.from !== undefined) {
    query = query.where('occurred_at', '>=', page.from);
  }
  if (page.to !== undefined) {
    query = query.where('occurred_at', '<', page.to);
  }
  if (page.after !== undefined) {
    // The position's time is the occurrence time of the last event of the page.
    const { createdAt, id } = page.after;
    query = query.where((eb) =>
      eb(eb.refTuple('occurred_at', 'id'), '<', eb.tuple(createdAt, id)),
    );
  }
  const rows = await query
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .limit(page.limit)
    .execute();
  return rows.map(toAuditEvent);
}

/**
 * Every event of a merchant about one target, oldest first by
 * `(occurred_at, id)`.
 */
export async function listAuditEventsForTarget(
  db: Database,
  key: {
    readonly merchantId: string;
    readonly targetType: string;
    readonly targetId: string;
  },
): Promise<AuditEvent[]> {
  const rows = await db
    .selectFrom('audit_events')
    .selectAll()
    .where('target_type', '=', key.targetType)
    .where('target_id', '=', key.targetId)
    .where('merchant_id', '=', key.merchantId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();
  return rows.map(toAuditEvent);
}
