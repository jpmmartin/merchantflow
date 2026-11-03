import type { DatabaseTransaction } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../clock/clock.js';
import {
  completeInProgressIdempotencyRecord,
  findIdempotencyRecordStatus,
} from '../infrastructure/idempotency-record-queries.js';
import {
  idempotencyExpiryFrom,
  type IdempotencyRecordIdentity,
  type IdempotentResponse,
} from './idempotency-record.js';

export interface CompleteIdempotencyRecordCommand {
  /** The record that the caller's claim created. */
  readonly record: IdempotencyRecordIdentity;
  readonly response: IdempotentResponse;
}

export type CompleteIdempotencyRecordResult =
  | {
      readonly ok: true;
      readonly completedAt: Date;
      /** Restarted from the completion, so a response is kept for the full retention. */
      readonly expiresAt: Date;
    }
  | {
      readonly ok: false;
      /** Nothing changed in either case. */
      readonly code: 'RECORD_NOT_FOUND' | 'ALREADY_COMPLETED';
    };

/**
 * Stores the response of a command on its record, inside the caller's
 * transaction, and marks the record completed. The update applies only to that
 * record of that merchant, and only while it is in progress, so a stored
 * response is never replaced. It never opens, commits, or rolls back a
 * transaction.
 */
@Injectable()
export class CompleteIdempotencyRecordService {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async execute(
    trx: DatabaseTransaction,
    command: CompleteIdempotencyRecordCommand,
  ): Promise<CompleteIdempotencyRecordResult> {
    const completedAt = this.clock.now();
    const expiresAt = idempotencyExpiryFrom(completedAt);

    const changed = await completeInProgressIdempotencyRecord(trx, {
      identity: command.record,
      response: command.response,
      completedAt,
      expiresAt,
    });
    if (changed === 1) {
      return { ok: true, completedAt, expiresAt };
    }

    const status = await findIdempotencyRecordStatus(trx, command.record);
    switch (status) {
      case undefined:
        return { ok: false, code: 'RECORD_NOT_FOUND' };
      case 'COMPLETED':
        return { ok: false, code: 'ALREADY_COMPLETED' };
      case 'IN_PROGRESS':
        // The conditional update skips a record in progress only if another
        // transaction completed it meanwhile, and a completion is never undone.
        throw new Error(
          `idempotency record ${command.record.id} is in progress but was not completed`,
        );
      default: {
        const unreachable: never = status;
        return unreachable;
      }
    }
  }
}
