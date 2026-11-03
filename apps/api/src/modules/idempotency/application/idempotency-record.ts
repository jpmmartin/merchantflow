/** Processing states of an idempotency record. */
export const IDEMPOTENCY_RECORD_STATUSES = [
  'IN_PROGRESS',
  'COMPLETED',
] as const;

export type IdempotencyRecordStatus =
  (typeof IDEMPOTENCY_RECORD_STATUSES)[number];

/**
 * How long a record is kept, counted from its claim and again from its
 * completion: 30 days. Expiry only marks a record as eligible for removal; it
 * never changes how a claim of the record's scope is answered.
 */
export const IDEMPOTENCY_RETENTION_MILLIS = 30 * 24 * 60 * 60 * 1000;

/** Returns when a record claimed or completed at `from` expires. */
export function idempotencyExpiryFrom(from: Date): Date {
  return new Date(from.getTime() + IDEMPOTENCY_RETENTION_MILLIS);
}

export type IdempotencyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly IdempotencyJsonValue[]
  | { readonly [key: string]: IdempotencyJsonValue };

export type IdempotencyJsonObject = {
  readonly [key: string]: IdempotencyJsonValue;
};

/**
 * The response a command returned, stored so that a retry receives it again.
 * The body must never contain secrets, API keys, payment tokens, or payment
 * credentials.
 */
export interface IdempotentResponse {
  readonly statusCode: number;
  readonly body: IdempotencyJsonObject;
}

/** What makes a record unique: a merchant, an operation, and the client's key. */
export interface IdempotencyScope {
  readonly merchantId: string;
  /** Upper snake case code of the command, for example `CREATE_PAYMENT_INTENT`. */
  readonly operation: string;
  /** The key the client sent, already validated by the caller. */
  readonly idempotencyKey: string;
}

/** Identifies one record. Completion requires it, so it cannot reach another record. */
export interface IdempotencyRecordIdentity {
  readonly id: string;
  readonly merchantId: string;
}

/** The record a successful claim created. Completion takes its identity. */
export interface ClaimedIdempotencyRecord
  extends IdempotencyScope, IdempotencyRecordIdentity {
  readonly requestFingerprint: string;
  readonly operationId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** A stored record, as the store reads it back. */
export type IdempotencyRecord = IdempotencyScope &
  IdempotencyRecordIdentity & {
    readonly requestFingerprint: string;
    readonly operationId: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  } & (
    | { readonly status: 'IN_PROGRESS' }
    | {
        readonly status: 'COMPLETED';
        readonly response: IdempotentResponse;
        readonly completedAt: Date;
      }
  );
