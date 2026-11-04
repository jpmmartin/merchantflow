/**
 * The outcome of processing a provider event:
 *
 * - `PROCESSED`: the event was handled; the platform's state now matches what
 *   the provider reported, whether or not anything changed. Final.
 * - `IGNORED`: the event is of a type the platform does not handle, or names
 *   no object the platform knows. Final.
 * - `FAILED`: processing could not finish, for example because the provider
 *   lookup was unavailable or the object's own request is still executing.
 *   The event is processed again when the provider redelivers it.
 */
export const PROCESSOR_EVENT_OUTCOMES = [
  'PROCESSED',
  'IGNORED',
  'FAILED',
] as const;

export type ProcessorEventOutcome = (typeof PROCESSOR_EVENT_OUTCOMES)[number];

/** A received provider event as the inbox stores it. No secret or payload. */
export interface ProcessorEventRecord {
  readonly id: string;
  readonly merchantId: string;
  readonly processorAccountId: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly objectType: string | null;
  readonly objectId: string | null;
  readonly receivedAt: Date;
  readonly attempts: number;
  /** `null` until processing ends for the first time. */
  readonly outcome: ProcessorEventOutcome | null;
  /** A short code of what processing did, such as `REFUND_SUCCEEDED`. */
  readonly detail: string | null;
  readonly processedAt: Date | null;
}

/** Whether an event's outcome is final, so a redelivery changes nothing. */
export function isFinalOutcome(outcome: ProcessorEventOutcome | null): boolean {
  return outcome === 'PROCESSED' || outcome === 'IGNORED';
}
