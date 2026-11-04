import { encodeKeysetCursor } from '../../pagination/keyset-cursor.js';
import type { ActorView } from '../application/actor-view.js';
import type { PaymentTimeline } from '../application/get-payment-timeline.service.js';
import type { AuditLogPage } from '../application/list-audit-log.service.js';
import type {
  ActorResponse,
  AuditEventListResponse,
  PaymentTimelineResponse,
} from './operations.schemas.js';

export function toActorResponse(actor: ActorView): ActorResponse {
  switch (actor.type) {
    case 'USER':
      return {
        type: 'USER',
        label: actor.label,
        user_id: actor.userId,
        display_name: actor.displayName,
        email: actor.email,
      };
    case 'API_KEY':
      return {
        type: 'API_KEY',
        label: actor.label,
        api_key_id: actor.apiKeyId,
        role: actor.role,
      };
    case 'SYSTEM':
      return { type: 'SYSTEM', label: actor.label, component: actor.component };
    case 'PLATFORM_ADMINISTRATOR':
      return { type: 'PLATFORM_ADMINISTRATOR', label: actor.label };
    case 'UNKNOWN':
      return {
        type: 'UNKNOWN',
        label: actor.label,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
      };
  }
}

export function toAuditEventListResponse(
  page: AuditLogPage,
): AuditEventListResponse {
  return {
    data: page.entries.map((entry) => ({
      id: entry.id,
      occurred_at: entry.occurredAt.toISOString(),
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      merchant_id: entry.merchantId,
      correlation_id: entry.correlationId,
      actor: toActorResponse(entry.actor),
      summary: entry.summary,
      metadata: entry.metadata,
    })),
    next_cursor: page.next === undefined ? null : encodeKeysetCursor(page.next),
  };
}

export function toPaymentTimelineResponse(
  timeline: PaymentTimeline,
): PaymentTimelineResponse {
  return {
    payment_intent_id: timeline.paymentIntentId,
    merchant_id: timeline.merchantId,
    data: timeline.items.map((item) => ({
      kind: item.kind,
      source_id: item.sourceId,
      occurred_at: item.occurredAt.toISOString(),
      summary: item.summary,
      status: item.status,
      amount_minor: item.amountMinor,
      currency: item.currency,
      actor: item.actor === null ? null : toActorResponse(item.actor),
      audit_action: item.auditAction,
    })),
  };
}
