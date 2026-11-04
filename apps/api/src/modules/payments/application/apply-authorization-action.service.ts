import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@merchantflow/database';
import {
  evaluatePaymentIntentTransition,
  toAmountMinorString,
  type PaymentIntent,
} from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { CompleteIdempotencyRecordService } from '../../idempotency/application/complete-idempotency-record.service.js';
import type { IdempotentResponse } from '../../idempotency/application/idempotency-record.js';
import { LedgerPostingService } from '../../ledger/application/ledger-posting.service.js';
import { updateAuthorizationActionIfStatus } from '../infrastructure/authorization-action-queries.js';
import { updatePaymentAttemptIfStatus } from '../infrastructure/payment-attempt-queries.js';
import {
  findPaymentIntentByIdForMerchantForUpdate,
  updatePaymentIntentStatusIfCurrent,
} from '../infrastructure/payment-intent-queries.js';
import type { AuditActor } from './apply-attempt-resolution.service.js';
import type {
  AuthorizationAction,
  AuthorizationActionResolution,
} from './authorization-action.js';
import type { PaymentAttempt } from './payment-attempt.js';

/** What a capture or void answers with: the action, its intent, and its attempt. */
export interface AuthorizationActionView {
  readonly action: AuthorizationAction;
  readonly intent: PaymentIntent;
  readonly attempt: PaymentAttempt;
}

/** Builds the HTTP answer of a view; supplied by the controller. */
export type PresentAuthorizationAction = (
  view: AuthorizationActionView,
) => IdempotentResponse;

export interface ApplyAuthorizationActionCommand {
  readonly actor: AuditActor;
  readonly correlationId: string;
  /** The action as the caller last read it; its status is the guard. */
  readonly action: AuthorizationAction;
  /** The authorized attempt the action acts on. */
  readonly attempt: PaymentAttempt;
  readonly resolution: AuthorizationActionResolution;
  /**
   * `PAYMENT_AUTHORIZATION_ACTION_APPLIED` after the command's own provider
   * call, or `PAYMENT_AUTHORIZATION_ACTION_RESOLVED` after a lookup.
   */
  readonly auditAction: string;
  readonly present: PresentAuthorizationAction;
}

export type ApplyAuthorizationActionResult =
  | {
      readonly outcome: 'APPLIED';
      readonly view: AuthorizationActionView;
      readonly response: IdempotentResponse;
      /** True when the response was stored under the request's key. */
      readonly stored: boolean;
    }
  /**
   * The action no longer has the status the caller read, because another
   * writer applied a result first. Nothing was changed.
   */
  | { readonly outcome: 'NOT_CURRENT' };

/**
 * Apply of a capture or void, inside the caller's transaction, which must
 * hold nothing else. In order:
 *
 * 1. the intent row is locked `FOR UPDATE`, the order every change of the
 *    intent uses;
 * 2. a conditional update of the action that requires its ID and the status
 *    the caller read (`EXECUTING` after Execute, `UNKNOWN` after a lookup); no
 *    row means another writer was first, and nothing changes;
 * 3. for a success: the attempt moves from `AUTHORIZED` to `SUCCEEDED` (a
 *    capture) or `CANCELED` (a void), and the intent from `REQUIRES_CAPTURE`
 *    to `SUCCEEDED` or `CANCELED` through the transition policy, each by a
 *    conditional update whose row count is checked; a capture posts the
 *    sale's journal entry (AD-76) with the attempt as its source, so a sale is
 *    posted once whatever path recognizes it; a void posts nothing;
 * 4. one audit event naming the journal entry, if any;
 * 5. for a conclusive outcome (succeeded or failed), completion of the
 *    request's idempotency record with the response; an unknown outcome leaves
 *    it in progress.
 *
 * A failed or unknown action changes neither the attempt nor the intent: the
 * hold stays as it was, or may have changed, and an unknown action keeps any
 * new capture or void out until it is resolved. A transition the policy
 * refuses, an attempt or intent that moved under the lock, or a posting that
 * fails, is a defect: it throws, and the transaction rolls back.
 */
@Injectable()
export class ApplyAuthorizationActionService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly completeRecord: CompleteIdempotencyRecordService,
    private readonly ledger: LedgerPostingService,
  ) {}

  async execute(
    trx: DatabaseTransaction,
    command: ApplyAuthorizationActionCommand,
  ): Promise<ApplyAuthorizationActionResult> {
    const { action, attempt, resolution } = command;
    const merchantId = action.merchantId;
    const now = this.clock.now();

    const intent = await findPaymentIntentByIdForMerchantForUpdate(
      trx,
      merchantId,
      action.paymentIntentId,
    );
    if (intent === undefined) {
      throw new Error(`payment intent ${action.paymentIntentId} disappeared`);
    }
    const updated = await updateAuthorizationActionIfStatus(trx, {
      merchantId,
      id: action.id,
      expectedStatus: action.status,
      status: resolution.status,
      failureCode: resolution.failureCode,
      errorCategory: resolution.errorCategory,
      updatedAt: now,
    });
    if (updated === undefined) return { outcome: 'NOT_CURRENT' };

    let currentIntent = intent;
    let currentAttempt = attempt;
    let journalEntryId: string | null = null;
    if (updated.status === 'SUCCEEDED') {
      const captured = updated.action === 'CAPTURE';
      const movedAttempt = await updatePaymentAttemptIfStatus(trx, {
        merchantId,
        id: attempt.id,
        expectedStatus: 'AUTHORIZED',
        status: captured ? 'SUCCEEDED' : 'CANCELED',
        providerTransactionId: attempt.providerTransactionId,
        declineCode: null,
        errorCategory: null,
        updatedAt: now,
      });
      if (movedAttempt === undefined) {
        throw new Error(
          `payment attempt ${attempt.id} was not AUTHORIZED when action ${updated.id} succeeded`,
        );
      }
      currentAttempt = movedAttempt;

      const target = captured ? 'SUCCEEDED' : 'CANCELED';
      const transition = evaluatePaymentIntentTransition(intent.status, target);
      if (!transition.ok) {
        throw new Error(
          `payment intent ${intent.id} cannot move from ${intent.status} to ${target}: ${transition.code}`,
        );
      }
      const movedIntent = await updatePaymentIntentStatusIfCurrent(trx, {
        merchantId,
        id: intent.id,
        from: intent.status,
        to: target,
        updatedAt: now,
      });
      if (movedIntent === undefined) {
        throw new Error(
          `payment intent ${intent.id} changed under its row lock`,
        );
      }
      currentIntent = movedIntent;

      if (captured) {
        const posting = await this.ledger.postPaymentSale(trx, {
          merchantId,
          paymentIntentId: movedIntent.id,
          paymentAttemptId: movedAttempt.id,
          amount: movedIntent.amount,
          merchantReference: movedIntent.merchantReference,
        });
        if (!posting.ok) {
          throw new Error(
            `capture ${updated.id} of payment attempt ${movedAttempt.id} cannot be posted: ${posting.reason}`,
          );
        }
        journalEntryId = posting.entry.id;
      }
    }

    await appendAuditEvent(trx, {
      id: randomUUID(),
      occurredAt: now,
      ...command.actor,
      action: command.auditAction,
      targetType: 'PAYMENT_INTENT',
      targetId: intent.id,
      merchantId,
      correlationId: command.correlationId,
      metadata: {
        authorization_action_id: updated.id,
        action: updated.action,
        action_status: updated.status,
        previous_action_status: action.status,
        payment_attempt_id: updated.paymentAttemptId,
        processor_account_id: updated.processorAccountId,
        previous_status: intent.status,
        status: currentIntent.status,
        provider_transaction_id: currentAttempt.providerTransactionId,
        failure_code: updated.failureCode,
        error_category: updated.errorCategory,
        amount_minor: toAmountMinorString(updated.amount),
        currency: updated.amount.currency,
        journal_entry_id: journalEntryId,
      },
    });

    const view: AuthorizationActionView = {
      action: updated,
      intent: currentIntent,
      attempt: currentAttempt,
    };
    const response = command.present(view);
    const conclusive = updated.status !== 'UNKNOWN';
    if (conclusive) {
      const completion = await this.completeRecord.execute(trx, {
        record: { id: updated.idempotencyRecordId, merchantId },
        response,
      });
      if (!completion.ok) {
        // The record stays in progress while its action is executing or
        // unknown, and only the writer that moved the action out of that
        // status completes it.
        throw new Error(
          `idempotency record ${updated.idempotencyRecordId} of action ${updated.id} could not be completed: ${completion.code}`,
        );
      }
    }
    return { outcome: 'APPLIED', view, response, stored: conclusive };
  }
}
