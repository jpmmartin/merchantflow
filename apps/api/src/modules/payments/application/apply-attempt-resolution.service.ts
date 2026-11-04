import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@merchantflow/database';
import {
  MAX_UNSUCCESSFUL_ATTEMPTS,
  evaluatePaymentIntentTransition,
  toAmountMinorString,
  type PaymentIntent,
  type PaymentIntentStatus,
} from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { AuditEvent } from '../../audit/application/audit-event.js';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { CompleteIdempotencyRecordService } from '../../idempotency/application/complete-idempotency-record.service.js';
import type { IdempotentResponse } from '../../idempotency/application/idempotency-record.js';
import { LedgerPostingService } from '../../ledger/application/ledger-posting.service.js';
import {
  countUnsuccessfulPaymentAttempts,
  updatePaymentAttemptIfStatus,
} from '../infrastructure/payment-attempt-queries.js';
import { updatePaymentIntentStatusIfCurrent } from '../infrastructure/payment-intent-queries.js';
import {
  attemptStatusOf,
  type AttemptResolution,
  type PaymentAttempt,
} from './payment-attempt.js';

/**
 * The state a confirmation or a completion answers with: the intent, the
 * attempt, and, only while the customer must authenticate, the client secret
 * the browser needs. The client secret is never stored or logged.
 */
export interface PaymentConfirmationView {
  readonly intent: PaymentIntent;
  readonly attempt: PaymentAttempt;
  readonly nextAction: { readonly clientSecret: string } | null;
}

/** Builds the HTTP answer of a view; supplied by the controller. */
export type PresentPaymentConfirmation = (
  view: PaymentConfirmationView,
) => IdempotentResponse;

/** Who caused an Apply, as its audit event records it. */
export type AuditActor = Pick<AuditEvent, 'actorType' | 'actorId'>;

export interface ApplyAttemptResolutionCommand {
  /** The key or user of a request, or `SYSTEM` for a provider event. */
  readonly actor: AuditActor;
  readonly correlationId: string;
  /** The intent and the attempt as the caller last read them. */
  readonly intent: PaymentIntent;
  readonly attempt: PaymentAttempt;
  readonly resolution: AttemptResolution;
  /**
   * `PAYMENT_INTENT_CONFIRMED`, `PAYMENT_INTENT_ACTION_COMPLETED`, or
   * `PAYMENT_ATTEMPT_RESOLVED_BY_PROVIDER_EVENT`.
   */
  readonly auditAction: string;
  readonly present: PresentPaymentConfirmation;
}

export type ApplyAttemptResolutionResult =
  | {
      readonly outcome: 'APPLIED';
      readonly view: PaymentConfirmationView;
      readonly response: IdempotentResponse;
      /** True when the response was stored under the confirmation's key. */
      readonly stored: boolean;
    }
  /**
   * The attempt no longer has the status the caller read, because another
   * writer applied a result first. Nothing was changed.
   */
  | { readonly outcome: 'NOT_CURRENT' };

/** The intent status a resolution leads to, and the count its guard needs. */
async function targetOf(
  trx: DatabaseTransaction,
  attempt: PaymentAttempt,
  resolution: AttemptResolution,
): Promise<{
  readonly to: PaymentIntentStatus;
  readonly unsuccessfulAttempts?: number;
}> {
  switch (resolution.kind) {
    case 'SUCCEEDED':
      return { to: 'SUCCEEDED' };
    case 'REQUIRES_ACTION':
      return { to: 'REQUIRES_ACTION' };
    case 'UNKNOWN':
      return { to: 'UNKNOWN' };
    case 'UNSUCCESSFUL': {
      // The count includes the attempt this transaction has just updated.
      const unsuccessfulAttempts = await countUnsuccessfulPaymentAttempts(trx, {
        merchantId: attempt.merchantId,
        paymentIntentId: attempt.paymentIntentId,
      });
      return {
        to:
          unsuccessfulAttempts >= MAX_UNSUCCESSFUL_ATTEMPTS
            ? 'FAILED'
            : 'CREATED',
        unsuccessfulAttempts,
      };
    }
  }
}

/**
 * Apply: records a provider result on an attempt and its intent, inside the
 * caller's transaction, which must hold nothing else. In order:
 *
 * 1. a conditional update of the attempt that requires its ID and the status
 *    the caller read (`EXECUTING` after Execute, `REQUIRES_ACTION` after a
 *    completion lookup); no row means another writer was first, and nothing
 *    changes;
 * 2. the intent's target from the policy (`evaluatePaymentIntentTransition`),
 *    counting the unsuccessful attempts for a decline or a non-execution, so
 *    the third one fails the intent;
 * 3. a conditional update of the intent that requires the status the caller
 *    read;
 * 4. for a success, the sale's journal entry through the ledger module, with
 *    the successful attempt as its source, so the same success can never post
 *    twice; a decline, a failure, a pending customer action, or an unknown
 *    outcome posts nothing;
 * 5. one audit event, without the client secret, naming the journal entry;
 * 6. for a conclusive result (succeeded, declined, failed), completion of the
 *    confirmation's idempotency record with the response, so a retry of the
 *    confirmation replays it. A result that requires action or is unknown
 *    leaves the record in progress.
 *
 * A transition the policy refuses, an intent that moved although its attempt
 * had not, or a posting that fails, is a defect: it throws, and the
 * transaction rolls back, the payment state change included.
 */
@Injectable()
export class ApplyAttemptResolutionService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly completeRecord: CompleteIdempotencyRecordService,
    private readonly ledger: LedgerPostingService,
  ) {}

  async execute(
    trx: DatabaseTransaction,
    command: ApplyAttemptResolutionCommand,
  ): Promise<ApplyAttemptResolutionResult> {
    const { attempt, intent, resolution } = command;
    const now = this.clock.now();

    const updatedAttempt = await updatePaymentAttemptIfStatus(trx, {
      merchantId: attempt.merchantId,
      id: attempt.id,
      expectedStatus: attempt.status,
      status: attemptStatusOf(resolution),
      // A provider transaction ID once learned is kept.
      providerTransactionId:
        attempt.providerTransactionId ?? resolution.providerTransactionId,
      declineCode:
        resolution.kind === 'UNSUCCESSFUL' ? resolution.declineCode : null,
      errorCategory:
        resolution.kind === 'UNSUCCESSFUL' || resolution.kind === 'UNKNOWN'
          ? resolution.errorCategory
          : null,
      updatedAt: now,
    });
    if (updatedAttempt === undefined) return { outcome: 'NOT_CURRENT' };

    const target = await targetOf(trx, updatedAttempt, resolution);
    const transition = evaluatePaymentIntentTransition(
      intent.status,
      target.to,
      target.unsuccessfulAttempts === undefined
        ? {}
        : { unsuccessfulAttempts: target.unsuccessfulAttempts },
    );
    if (!transition.ok) {
      throw new Error(
        `payment intent ${intent.id} cannot move from ${intent.status} to ${target.to}: ${transition.code}`,
      );
    }
    const updatedIntent = await updatePaymentIntentStatusIfCurrent(trx, {
      merchantId: intent.merchantId,
      id: intent.id,
      from: intent.status,
      to: target.to,
      updatedAt: now,
    });
    if (updatedIntent === undefined) {
      throw new Error(
        `payment intent ${intent.id} left ${intent.status} while its attempt ${attempt.id} was ${attempt.status}`,
      );
    }

    let journalEntryId: string | null = null;
    if (resolution.kind === 'SUCCEEDED') {
      const posting = await this.ledger.postPaymentSale(trx, {
        merchantId: updatedIntent.merchantId,
        paymentIntentId: updatedIntent.id,
        paymentAttemptId: updatedAttempt.id,
        amount: updatedIntent.amount,
        merchantReference: updatedIntent.merchantReference,
      });
      if (!posting.ok) {
        throw new Error(
          `sale of payment attempt ${updatedAttempt.id} cannot be posted: ${posting.reason}`,
        );
      }
      journalEntryId = posting.entry.id;
    }

    await appendAuditEvent(trx, {
      id: randomUUID(),
      occurredAt: now,
      ...command.actor,
      action: command.auditAction,
      targetType: 'PAYMENT_INTENT',
      targetId: updatedIntent.id,
      merchantId: updatedIntent.merchantId,
      correlationId: command.correlationId,
      metadata: {
        payment_attempt_id: updatedAttempt.id,
        processor_account_id: updatedAttempt.processorAccountId,
        attempt_status: updatedAttempt.status,
        previous_status: intent.status,
        status: updatedIntent.status,
        provider_transaction_id: updatedAttempt.providerTransactionId,
        decline_code: updatedAttempt.declineCode,
        error_category: updatedAttempt.errorCategory,
        amount_minor: toAmountMinorString(updatedIntent.amount),
        currency: updatedIntent.amount.currency,
        journal_entry_id: journalEntryId,
      },
    });

    const view: PaymentConfirmationView = {
      intent: updatedIntent,
      attempt: updatedAttempt,
      nextAction:
        resolution.kind === 'REQUIRES_ACTION'
          ? { clientSecret: resolution.clientSecret }
          : null,
    };
    const response = command.present(view);
    const conclusive =
      resolution.kind === 'SUCCEEDED' || resolution.kind === 'UNSUCCESSFUL';
    if (conclusive) {
      const completion = await this.completeRecord.execute(trx, {
        record: {
          id: updatedAttempt.idempotencyRecordId,
          merchantId: updatedAttempt.merchantId,
        },
        response,
      });
      if (!completion.ok) {
        // The record stays in progress while its attempt is open, and only
        // the writer that moved the attempt out of that status completes it.
        throw new Error(
          `idempotency record ${updatedAttempt.idempotencyRecordId} of attempt ${updatedAttempt.id} could not be completed: ${completion.code}`,
        );
      }
    }
    return { outcome: 'APPLIED', view, response, stored: conclusive };
  }
}
