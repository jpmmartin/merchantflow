import type { Database } from '@merchantflow/database';
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
