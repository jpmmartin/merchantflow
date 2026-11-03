/** Kinds of actor that can cause an audited action. */
export const AUDIT_ACTOR_TYPES = ['API_KEY', 'SYSTEM', 'USER'] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export type AuditJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly AuditJsonValue[]
  | { readonly [key: string]: AuditJsonValue };

/**
 * Structured context of an event. It must never contain secrets, API keys,
 * payment tokens, or payment credentials, because audit rows are immutable and
 * cannot be scrubbed afterwards.
 */
export type AuditMetadata = { readonly [key: string]: AuditJsonValue };

/** An entry of the append-only audit trail. */
export interface AuditEvent {
  readonly id: string;
  /** Supplied by the caller from the injected clock. */
  readonly occurredAt: Date;
  readonly actorType: AuditActorType;
  /**
   * API key identifier for `API_KEY`, user identifier for `USER`, or a fixed
   * component name for `SYSTEM`.
   */
  readonly actorId: string;
  /** Upper snake case code, for example `MERCHANT_STATUS_CHANGED`. */
  readonly action: string;
  /** Upper snake case kind of the target, for example `MERCHANT`. */
  readonly targetType: string;
  readonly targetId: string;
  /** The merchant the event concerns, when there is one. */
  readonly merchantId: string | null;
  readonly correlationId: string;
  readonly metadata: AuditMetadata;
}
