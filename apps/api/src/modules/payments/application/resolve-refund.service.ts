import { randomUUID } from 'node:crypto';
import {
  isLockNotAvailable,
  setLocalLockTimeout,
  type Database,
  type DatabaseTransaction,
} from '@merchantflow/database';
import {
  evaluatePaymentIntentTransition,
  refundTotals,
  refundedStatusOf,
  toAmountMinorString,
  type PaymentIntent,
} from '@merchantflow/domain';
import type { ProcessorAdapterRegistry } from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { CompleteIdempotencyRecordService } from '../../idempotency/application/complete-idempotency-record.service.js';
import { LedgerPostingService } from '../../ledger/application/ledger-posting.service.js';
import { ProcessorAccountsForPaymentsService } from '../../merchants/application/processor-accounts-for-payments.service.js';
import { PROCESSOR_REGISTRY } from '../../processors/application/processor-registry.js';
import { findPaymentAttemptById } from '../infrastructure/payment-attempt-queries.js';
import {
  findPaymentIntentByIdForMerchant,
  findPaymentIntentByIdForMerchantForUpdate,
  updatePaymentIntentStatusIfCurrent,
} from '../infrastructure/payment-intent-queries.js';
import {
  findRefundById,
  findRefundForProviderObject,
  listRefunds,
  updateRefundIfStatus,
} from '../infrastructure/refund-queries.js';
import type { AuditActor } from './apply-attempt-resolution.service.js';
import { PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS } from './create-payment-intent.service.js';
import type {
  PresentRefund,
  RefundView,
} from './refund-payment-intent.service.js';
import {
  countedRefunds,
  refundResolutionOf,
  refundSummaryOf,
  type Refund,
  type RefundResolution,
} from './refund.js';

/** Audit action of a refund whose status a provider lookup changed. */
export const PAYMENT_REFUND_RESOLVED = 'PAYMENT_REFUND_RESOLVED';

/**
 * What a resolution changed:
 *
 * - `REFUND_SUCCEEDED`: a pending or unknown refund succeeded; the intent
 *   moved and the refund entry was posted;
 * - `REFUND_FAILED`: a pending or unknown refund failed; its amount is
 *   refundable again;
 * - `REFUND_PENDING`: an unknown refund turned out to be pending;
 * - `REFUND_REVERSED`: a succeeded refund failed afterwards; a compensating
 *   entry was posted and the intent moved back.
 */
export type RefundResolutionDetail =
  'REFUND_SUCCEEDED' | 'REFUND_FAILED' | 'REFUND_PENDING' | 'REFUND_REVERSED';

export interface ResolveRefundCommand {
  readonly actor: AuditActor;
  readonly correlationId: string;
  readonly merchantId: string;
  /** The refund as the caller read it, within the merchant. */
  readonly refund: Refund;
  /**
   * The provider's refund ID from the event, for a refund that never learned
   * its own; ignored when the refund already has one.
   */
  readonly providerRefundId: string | null;
  /** Bounds the provider lookup, with no retry, for a caller that must answer quickly. */
  readonly lookupTimeoutMs?: number;
  /** Builds the answer stored under the key of an unknown refund it resolves. */
  readonly present: PresentRefund;
}

export type ResolveRefundResult =
  | {
      readonly outcome: 'RESOLVED';
      readonly detail: RefundResolutionDetail;
      readonly view: RefundView;
    }
  /**
   * The provider confirms the refund's current status, or reports one that
   * cannot move it (still unknown, or a status the refund already left).
   */
  | { readonly outcome: 'NO_CHANGE'; readonly view: RefundView }
  /** The refund's own request is still executing; try again later. */
  | { readonly outcome: 'EXECUTING' }
  /** Neither the refund nor the caller knows the provider's refund ID. */
  | { readonly outcome: 'NO_PROVIDER_ID' }
  /** The provider gave no usable answer. Nothing changed. */
  | { readonly outcome: 'LOOKUP_UNAVAILABLE' }
  /** No master key decrypts the account's secret. Nothing changed. */
  | { readonly outcome: 'CREDENTIALS_KEY_NOT_CONFIGURED' }
  /** The account's provider has no adapter that can look a refund up. */
  | { readonly outcome: 'PROVIDER_UNSUPPORTED' }
  /** A lock wait exceeded the limit. Nothing changed. */
  | { readonly outcome: 'LOCK_TIMEOUT' };

/** A provider refund a webhook event names, within one account. */
export interface ResolveProviderRefundCommand extends Omit<
  ResolveRefundCommand,
  'refund' | 'providerRefundId'
> {
  readonly processorAccountId: string;
  readonly providerRefundId: string;
  /** The platform refund ID the provider refund carries, if any. */
  readonly refundId: string | null;
}

/** The change a provider result makes to a refund in a given status. */
type RefundChange =
  | { readonly kind: 'NONE' }
  | {
      readonly kind: 'MOVE';
      readonly detail: RefundResolutionDetail;
      readonly resolution: Exclude<RefundResolution, { status: 'UNKNOWN' }>;
    };

/**
 * Decides what a provider result means for a refund in its current status.
 * Nothing moves a refund back: a finished failure never changes, a success
 * changes only to a failure (the provider failed it afterwards, a reversal),
 * and an unknown result changes nothing.
 */
function changeOf(
  status: Refund['status'],
  resolution: RefundResolution,
): RefundChange {
  if (resolution.status === 'UNKNOWN') return { kind: 'NONE' };
  switch (status) {
    case 'PENDING':
    case 'UNKNOWN':
      switch (resolution.status) {
        case 'SUCCEEDED':
          return { kind: 'MOVE', detail: 'REFUND_SUCCEEDED', resolution };
        case 'FAILED':
          return { kind: 'MOVE', detail: 'REFUND_FAILED', resolution };
        case 'PENDING':
          return status === 'UNKNOWN'
            ? { kind: 'MOVE', detail: 'REFUND_PENDING', resolution }
            : { kind: 'NONE' };
      }
      break;
    case 'SUCCEEDED':
      return resolution.status === 'FAILED'
        ? { kind: 'MOVE', detail: 'REFUND_REVERSED', resolution }
        : { kind: 'NONE' };
    case 'EXECUTING':
    case 'FAILED':
      return { kind: 'NONE' };
  }
}

/**
 * Brings a refund up to date with its provider: the current refund is read
 * from the provider with no transaction open, and the result is applied with
 * conditional updates, so a late, repeated, or out-of-order trigger cannot
 * move a status backwards. Both the webhook and the refresh endpoint use it,
 * and it is safe to repeat.
 *
 * Apply runs in one short READ COMMITTED transaction: the intent row is locked
 * first, as every refund Apply does, so it is ordered after them; the refund
 * is read again under that lock and changed only from the status read there;
 * then, by the change:
 *
 * - a success moves the intent to `PARTIALLY_REFUNDED` or `REFUNDED` and
 *   posts the refund entry (`PAYMENT_REFUND`), as the refund request does;
 * - a failure of a pending or unknown refund releases its amount, and the
 *   intent keeps its status;
 * - a failure of a succeeded refund (owner decision of 2026-11-03) posts the
 *   compensating entry (`PAYMENT_REFUND_REVERSAL` + the refund, once) and
 *   moves the intent back to `PARTIALLY_REFUNDED` or `SUCCEEDED` by the
 *   refunds that still succeeded, so the amount is refundable again.
 *
 * One `PAYMENT_REFUND_RESOLVED` audit event records the change. A refund that
 * was `UNKNOWN` had its request's idempotency record in progress; its
 * conclusive answer is stored under that key, as the refund request would
 * have stored it.
 */
@Injectable()
export class ResolveRefundService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROCESSOR_REGISTRY)
    private readonly registry: ProcessorAdapterRegistry,
    private readonly accounts: ProcessorAccountsForPaymentsService,
    private readonly ledger: LedgerPostingService,
    private readonly completeRecord: CompleteIdempotencyRecordService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ResolveRefundService.name);
  }

  /**
   * Resolves the refund a provider event names: matched by the provider
   * refund ID or, for a refund that never learned it, by the platform refund
   * ID in the provider refund's metadata, within the merchant and the account
   * of the event. `NOT_MATCHED` when the platform made no such refund, for
   * example one made in the provider's dashboard.
   */
  async executeForProviderRefund(
    command: ResolveProviderRefundCommand,
  ): Promise<ResolveRefundResult | { readonly outcome: 'NOT_MATCHED' }> {
    const refund = await findRefundForProviderObject(this.database, {
      merchantId: command.merchantId,
      processorAccountId: command.processorAccountId,
      providerRefundId: command.providerRefundId,
      refundId: command.refundId,
    });
    if (refund === undefined) return { outcome: 'NOT_MATCHED' };
    return this.execute({
      actor: command.actor,
      correlationId: command.correlationId,
      merchantId: command.merchantId,
      refund,
      providerRefundId: command.providerRefundId,
      present: command.present,
      ...(command.lookupTimeoutMs === undefined
        ? {}
        : { lookupTimeoutMs: command.lookupTimeoutMs }),
    });
  }

  async execute(command: ResolveRefundCommand): Promise<ResolveRefundResult> {
    const { refund, merchantId } = command;
    if (refund.status === 'EXECUTING') return { outcome: 'EXECUTING' };
    if (refund.status === 'FAILED') {
      return { outcome: 'NO_CHANGE', view: await this.viewOf(refund) };
    }
    const providerRefundId =
      refund.providerRefundId ?? command.providerRefundId;
    if (providerRefundId === null) return { outcome: 'NO_PROVIDER_ID' };

    const attempt = await findPaymentAttemptById(this.database, {
      merchantId,
      id: refund.paymentAttemptId,
    });
    const providerTransactionId = attempt?.providerTransactionId ?? null;
    if (providerTransactionId === null) {
      throw new Error(
        `refund ${refund.id} has no successful attempt with a provider transaction`,
      );
    }
    const resolved = await this.accounts.forExistingPayment(this.database, {
      merchantId,
      processorAccountId: refund.processorAccountId,
    });
    if (!resolved.ok) {
      if (resolved.code === 'CREDENTIALS_KEY_NOT_CONFIGURED') {
        return { outcome: 'CREDENTIALS_KEY_NOT_CONFIGURED' };
      }
      // The composite foreign key keeps the refund's account in place.
      throw new Error(
        `processor account ${refund.processorAccountId} of refund ${refund.id} is ${resolved.code}`,
      );
    }
    const adapter = this.registry.findWithCapability(
      resolved.account.provider,
      'TRANSACTION_LOOKUP',
    );
    if (adapter === undefined) return { outcome: 'PROVIDER_UNSUPPORTED' };

    const lookup = await adapter.getRefund({
      credentials: resolved.account.credentials,
      providerRefundId,
      providerTransactionId,
      amount: refund.amount,
      ...(command.lookupTimeoutMs === undefined
        ? {}
        : { timeoutMs: command.lookupTimeoutMs }),
    });
    if (lookup.outcome === 'unavailable') {
      this.logger.warn(
        {
          refundId: refund.id,
          category: lookup.category,
          correlationId: command.correlationId,
        },
        'refund lookup unavailable; nothing changed',
      );
      return { outcome: 'LOOKUP_UNAVAILABLE' };
    }

    const resolution = refundResolutionOf(lookup.result);
    let result: ResolveRefundResult;
    try {
      result = await this.database
        .transaction()
        .setIsolationLevel('read committed')
        .execute((trx) =>
          this.applyInTransaction(trx, command, providerRefundId, resolution),
        );
    } catch (error) {
      if (isLockNotAvailable(error)) return { outcome: 'LOCK_TIMEOUT' };
      throw error;
    }
    this.logger.info(
      {
        paymentIntentId: refund.paymentIntentId,
        refundId: refund.id,
        outcome: result.outcome,
        detail: result.outcome === 'RESOLVED' ? result.detail : null,
        providerStatus: resolution.status,
        correlationId: command.correlationId,
      },
      'refund resolution applied',
    );
    return result;
  }

  private async viewOf(refund: Refund): Promise<RefundView> {
    const intent = await findPaymentIntentByIdForMerchant(
      this.database,
      refund.merchantId,
      refund.paymentIntentId,
    );
    if (intent === undefined) {
      throw new Error(`payment intent ${refund.paymentIntentId} disappeared`);
    }
    const refunds = await listRefunds(this.database, {
      merchantId: refund.merchantId,
      paymentIntentId: intent.id,
    });
    return { refund, intent, summary: refundSummaryOf(intent, refunds) };
  }

  private async applyInTransaction(
    trx: DatabaseTransaction,
    command: ResolveRefundCommand,
    providerRefundId: string,
    resolution: RefundResolution,
  ): Promise<ResolveRefundResult> {
    await setLocalLockTimeout(trx, PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS);
    const { merchantId } = command;
    const intent = await findPaymentIntentByIdForMerchantForUpdate(
      trx,
      merchantId,
      command.refund.paymentIntentId,
    );
    if (intent === undefined) {
      throw new Error(
        `payment intent ${command.refund.paymentIntentId} disappeared`,
      );
    }
    // Read again under the intent's lock: another resolution, or the refund's
    // own Apply, may have moved it since the caller read it.
    const current = await findRefundById(trx, {
      merchantId,
      id: command.refund.id,
    });
    if (current === undefined) {
      throw new Error(`refund ${command.refund.id} disappeared`);
    }
    if (current.status === 'EXECUTING') return { outcome: 'EXECUTING' };
    const change = changeOf(current.status, resolution);
    if (change.kind === 'NONE') {
      const refunds = await listRefunds(trx, {
        merchantId,
        paymentIntentId: intent.id,
      });
      return {
        outcome: 'NO_CHANGE',
        view: {
          refund: current,
          intent,
          summary: refundSummaryOf(intent, refunds),
        },
      };
    }

    const now = this.clock.now();
    const updated = await updateRefundIfStatus(trx, {
      merchantId,
      id: current.id,
      expectedStatus: current.status,
      status: change.resolution.status,
      // A provider refund ID once learned is kept.
      providerRefundId:
        current.providerRefundId ??
        change.resolution.providerRefundId ??
        providerRefundId,
      failureCode: change.resolution.failureCode,
      errorCategory: change.resolution.errorCategory,
      updatedAt: now,
    });
    if (updated === undefined) {
      throw new Error(
        `refund ${current.id} changed under its intent's row lock`,
      );
    }

    const refunds = await listRefunds(trx, {
      merchantId,
      paymentIntentId: intent.id,
    });
    const moved = await this.moveIntent(trx, intent, refunds, now);
    let journalEntryId: string | null = null;
    if (change.detail === 'REFUND_SUCCEEDED') {
      const posting = await this.ledger.postPaymentRefund(trx, {
        merchantId,
        paymentIntentId: intent.id,
        refundId: updated.id,
        amount: updated.amount,
        merchantReference: intent.merchantReference,
      });
      if (!posting.ok) {
        throw new Error(
          `refund ${updated.id} cannot be posted: ${posting.reason}`,
        );
      }
      journalEntryId = posting.entry.id;
    }
    if (change.detail === 'REFUND_REVERSED') {
      const posting = await this.ledger.postPaymentRefundReversal(trx, {
        merchantId,
        paymentIntentId: intent.id,
        refundId: updated.id,
        amount: updated.amount,
        merchantReference: intent.merchantReference,
      });
      if (!posting.ok) {
        throw new Error(
          `reversal of refund ${updated.id} cannot be posted: ${posting.reason}`,
        );
      }
      journalEntryId = posting.entry.id;
    }

    await appendAuditEvent(trx, {
      id: randomUUID(),
      occurredAt: now,
      ...command.actor,
      action: PAYMENT_REFUND_RESOLVED,
      targetType: 'PAYMENT_INTENT',
      targetId: intent.id,
      merchantId,
      correlationId: command.correlationId,
      metadata: {
        refund_id: updated.id,
        change: change.detail,
        previous_refund_status: current.status,
        refund_status: updated.status,
        previous_status: intent.status,
        status: moved.status,
        provider_refund_id: updated.providerRefundId,
        failure_code: updated.failureCode,
        error_category: updated.errorCategory,
        amount_minor: toAmountMinorString(updated.amount),
        currency: updated.amount.currency,
        journal_entry_id: journalEntryId,
      },
    });

    const view: RefundView = {
      refund: updated,
      intent: moved,
      summary: refundSummaryOf(moved, refunds),
    };
    if (current.status === 'UNKNOWN') {
      // The refund request left its record in progress while the outcome was
      // unknown; its conclusive answer is stored now.
      const completion = await this.completeRecord.execute(trx, {
        record: { id: updated.idempotencyRecordId, merchantId },
        response: command.present(view),
      });
      if (!completion.ok) {
        throw new Error(
          `idempotency record ${updated.idempotencyRecordId} of refund ${updated.id} could not be completed: ${completion.code}`,
        );
      }
    }
    return { outcome: 'RESOLVED', detail: change.detail, view };
  }

  /**
   * Moves the intent to the status its successful refunds give, through the
   * transition policy and a conditional update, when that status differs from
   * the current one; returns the intent as it now is.
   */
  private async moveIntent(
    trx: DatabaseTransaction,
    intent: PaymentIntent,
    refunds: readonly Refund[],
    now: Date,
  ): Promise<PaymentIntent> {
    const computed = refundTotals(intent.amount, countedRefunds(refunds));
    if (!computed.ok) {
      throw new Error(
        `refunds of payment intent ${intent.id} break the refund rule: ${computed.code}`,
      );
    }
    const target = refundedStatusOf(computed.totals);
    if (target === intent.status) return intent;
    const transition = evaluatePaymentIntentTransition(intent.status, target);
    if (!transition.ok) {
      throw new Error(
        `payment intent ${intent.id} cannot move from ${intent.status} to ${target}: ${transition.code}`,
      );
    }
    const moved = await updatePaymentIntentStatusIfCurrent(trx, {
      merchantId: intent.merchantId,
      id: intent.id,
      from: intent.status,
      to: target,
      updatedAt: now,
    });
    if (moved === undefined) {
      throw new Error(`payment intent ${intent.id} changed under its row lock`);
    }
    return moved;
  }
}
