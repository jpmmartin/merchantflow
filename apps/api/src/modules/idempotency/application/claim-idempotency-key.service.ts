import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../clock/clock.js';
import {
  findIdempotencyRecordByScope,
  insertIdempotencyRecordIfAbsent,
} from '../infrastructure/idempotency-record-queries.js';
import {
  idempotencyExpiryFrom,
  type ClaimedIdempotencyRecord,
  type IdempotencyRecord,
  type IdempotencyScope,
  type IdempotentResponse,
} from './idempotency-record.js';
import {
  computeRequestFingerprint,
  type FingerprintValue,
} from './request-fingerprint.js';

export interface ClaimIdempotencyKeyCommand extends IdempotencyScope {
  /**
   * Identifier of the business operation the command performs if it obtains
   * the key, for example the ID of the resource it will create. A retry under
   * the same key learns this identifier instead of its own.
   */
  readonly operationId: string;
  /**
   * The validated request, without the idempotency key, the correlation ID, or
   * other transport metadata. Amounts must be integer strings.
   */
  readonly request: FingerprintValue;
}

export type ClaimIdempotencyKeyOutcome =
  /** The caller owns the key and runs the command. */
  | { readonly outcome: 'CLAIMED'; readonly record: ClaimedIdempotencyRecord }
  /** The same request already completed under this key: return its response. */
  | {
      readonly outcome: 'REPLAY';
      readonly operationId: string;
      readonly response: IdempotentResponse;
      readonly completedAt: Date;
    }
  /** The same request is still running, or its outcome is not known yet. */
  | {
      readonly outcome: 'IN_PROGRESS';
      readonly operationId: string;
      readonly createdAt: Date;
    }
  /** The key was used for a different request. Nothing about it is revealed. */
  | { readonly outcome: 'KEY_REUSED' };

/**
 * Claims an idempotency key inside the caller's transaction, so the claim
 * commits or rolls back together with the command's own writes. It never opens,
 * commits, or rolls back a transaction.
 *
 * **Isolation:** the transaction must use READ COMMITTED, PostgreSQL's default.
 * A claim of a scope whose row another transaction inserted and has not
 * committed waits for it. If that transaction commits, nothing is inserted and
 * the next statement, which takes a new snapshot, reads the committed row; if
 * it rolls back, this claim inserts its row and owns the key. Under REPEATABLE
 * READ or SERIALIZABLE, a claim that waited for a transaction that then
 * committed fails with `serialization_failure` (`40001`) instead of returning
 * an outcome.
 *
 * **Expiry:** an expired record is answered exactly like a current one. Its
 * key is never claimed again while the row exists, in progress or completed,
 * so expiry alone can never let a command run twice.
 */
@Injectable()
export class ClaimIdempotencyKeyService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async execute(
    trx: DatabaseTransaction,
    command: ClaimIdempotencyKeyCommand,
  ): Promise<ClaimIdempotencyKeyOutcome> {
    const requestFingerprint = computeRequestFingerprint(
      command.operation,
      command.request,
    );
    const createdAt = this.clock.now();
    const record: ClaimedIdempotencyRecord = {
      id: randomUUID(),
      merchantId: command.merchantId,
      operation: command.operation,
      idempotencyKey: command.idempotencyKey,
      requestFingerprint,
      operationId: command.operationId,
      createdAt,
      expiresAt: idempotencyExpiryFrom(createdAt),
    };

    if (await insertIdempotencyRecordIfAbsent(trx, record)) {
      return { outcome: 'CLAIMED', record };
    }

    const existing = await findIdempotencyRecordByScope(trx, command);
    if (existing === undefined) {
      // Under READ COMMITTED the row that blocked the insert is committed and
      // visible to this later statement, and records are never deleted.
      throw new Error(
        'idempotency claim found a conflicting record that it cannot read',
      );
    }
    return answerExistingRecord(existing, requestFingerprint);
  }
}

function answerExistingRecord(
  existing: IdempotencyRecord,
  requestFingerprint: string,
): ClaimIdempotencyKeyOutcome {
  if (existing.requestFingerprint !== requestFingerprint) {
    return { outcome: 'KEY_REUSED' };
  }
  switch (existing.status) {
    case 'COMPLETED':
      return {
        outcome: 'REPLAY',
        operationId: existing.operationId,
        response: existing.response,
        completedAt: existing.completedAt,
      };
    case 'IN_PROGRESS':
      return {
        outcome: 'IN_PROGRESS',
        operationId: existing.operationId,
        createdAt: existing.createdAt,
      };
    default: {
      const unreachable: never = existing;
      return unreachable;
    }
  }
}
