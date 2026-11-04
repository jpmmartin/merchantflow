import { z } from 'zod';
import {
  PROCESSOR_EVENT_OUTCOMES,
  type ProcessorEventRecord,
} from '../application/processor-event.js';

export const idParamSchema = z.uuid();

export const processorEventResponseSchema = z.object({
  id: z.uuid(),
  provider_event_id: z.string().describe('The provider event, such as evt_...'),
  event_type: z
    .string()
    .describe('The provider event type, such as refund.updated.'),
  object_type: z.string().nullable(),
  object_id: z.string().nullable(),
  received_at: z.iso.datetime(),
  attempts: z.number().int().describe('How many times processing ran.'),
  outcome: z
    .enum(PROCESSOR_EVENT_OUTCOMES)
    .nullable()
    .describe(
      'PROCESSED or IGNORED are final; FAILED is processed again when the provider redelivers the event; null while the first run is in progress.',
    ),
  detail: z
    .string()
    .nullable()
    .describe('What processing did, such as REFUND_SUCCEEDED or NO_CHANGE.'),
  processed_at: z.iso.datetime().nullable(),
});

export const processorEventListResponseSchema = z.object({
  processor_account_id: z.uuid(),
  merchant_id: z.uuid(),
  data: z
    .array(processorEventResponseSchema)
    .describe('The latest events of the account, newest first, at most 20.'),
});

export type ProcessorEventListResponse = z.infer<
  typeof processorEventListResponseSchema
>;

export function toProcessorEventResponse(event: ProcessorEventRecord) {
  return {
    id: event.id,
    provider_event_id: event.providerEventId,
    event_type: event.eventType,
    object_type: event.objectType,
    object_id: event.objectId,
    received_at: event.receivedAt.toISOString(),
    attempts: event.attempts,
    outcome: event.outcome,
    detail: event.detail,
    processed_at: event.processedAt?.toISOString() ?? null,
  };
}
