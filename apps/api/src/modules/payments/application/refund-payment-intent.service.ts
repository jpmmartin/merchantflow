import { randomUUID } from 'node:crypto';
import {
  isLockNotAvailable,
  setLocalLockTimeout,
  type Database,
  type DatabaseTransaction,
} from '@merchantflow/database';
import {
  createMoney,
  evaluatePaymentIntentTransition,
  evaluateRefundRequest,
  refundTotals,
  refundedStatusOf,
  toAmountMinorString,
  toPositiveMoney,
  type PaymentIntent,
  type PositiveMoney,
} from '@merchantflow/domain';
import type {
  ProcessorAdapter,
  ProcessorAdapterRegistry,
  ProcessorRefundResult,
} from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { ClaimIdempotencyKeyService } from '../../idempotency/application/claim-idempotency-key.service.js';
import { CompleteIdempotencyRecordService } from '../../idempotency/application/complete-idempotency-record.service.js';
import type {
  ClaimedIdempotencyRecord,
  IdempotentResponse,
} from '../../idempotency/application/idempotency-record.js';
import { LedgerPostingService } from '../../ledger/application/ledger-posting.service.js';
import { LockMerchantForPaymentService } from '../../merchants/application/lock-merchant-for-payment.service.js';
import {
  ProcessorAccountsForPaymentsService,
  type PaymentProcessorAccount,
} from '../../merchants/application/processor-accounts-for-payments.service.js';
import { PROCESSOR_REGISTRY } from '../../processors/application/processor-registry.js';
import { findSucceededPaymentAttempt } from '../infrastructure/payment-attempt-queries.js';
import {
  findPaymentIntentByIdForMerchant,
  findPaymentIntentByIdForMerchantForUpdate,
  updatePaymentIntentStatusIfCurrent,
} from '../infrastructure/payment-intent-queries.js';
import {
  insertRefund,
  listRefunds,
  updateRefundIfExecuting,
} from '../infrastructure/refund-queries.js';
import { PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS } from './create-payment-intent.service.js';
import {
  countedRefunds,
  refundResolutionOf,
  refundSummaryOf,
  type Refund,
  type RefundResolution,
  type RefundSummary,
} from './refund.js';

/** Idempotency operation of a refund request; keys are scoped by it. */
export const REFUND_PAYMENT_INTENT_OPERATION = 'REFUND_PAYMENT_INTENT';

/** Audit action of a refund whose provider result was applied. */
export const PAYMENT_REFUND_APPLIED = 'PAYMENT_REFUND_APPLIED';

/** What a refund request answers with: the refund, its intent, and the amounts. */
export interface RefundView {
  readonly refund: Refund;
  readonly intent: PaymentIntent;
  readonly summary: RefundSummary;
}

/** Builds the HTTP answer of a view; supplied by the controller. */
export type PresentRefund = (view: RefundView) => IdempotentResponse;

export interface RefundPaymentIntentCommand {
  readonly principal: Principal;
  readonly correlationId: string;
  /** Already checked against the format of the idempotency store. */
  readonly idempotencyKey: string;
  readonly paymentIntentId: string;
  /**
   * The requested amount in minor units of the intent's currency, already
   * parsed from its integer string and greater than zero.
   */
  readonly amountMinor: bigint;
  readonly present: PresentRefund;
}

export type RefundPaymentIntentFailureCode =
  /** Not a `MERCHANT_ADMIN` of the intent's merchant. Nothing was written. */
  | 'FORBIDDEN'
  /** No intent with this id belongs to the merchant. Nothing was written. */
  | 'NOT_FOUND'
  /** The merchant is not `ACTIVE`. Nothing was stored. */
  | 'MERCHANT_NOT_ACTIVE'
  /** The same request under the same key has no conclusive answer yet. */
  | 'OPERATION_IN_PROGRESS'
  /** The key was used for a different request. */
  | 'KEY_REUSED'
  /** A lock wait exceeded the limit. Nothing was stored. */
  | 'LOCK_TIMEOUT'
  /** The intent is not `SUCCEEDED` or `PARTIALLY_REFUNDED`. Nothing was stored. */
  | 'INTENT_NOT_REFUNDABLE'
  /** An earlier refund of the intent has an unknown outcome. Nothing was stored. */
  | 'REFUND_OUTCOME_UNKNOWN'
  /** The amount is above the refundable amount. Nothing was stored. */
  | 'AMOUNT_EXCEEDS_REFUNDABLE'
  /** No master key decrypts the account's secret. Nothing was stored. */
  | 'CREDENTIALS_KEY_NOT_CONFIGURED'
  /** The account's provider has no adapter that can make this refund. */
  | 'PROVIDER_UNSUPPORTED';

export type RefundPaymentIntentResult =
  | {
      readonly ok: true;
      /** True when the response was stored by an earlier request under the key. */
      readonly replayed: boolean;
      readonly response: IdempotentResponse;
    }
  | { readonly ok: false; readonly code: RefundPaymentIntentFailureCode };

type RefundPaymentIntentFailure = Extract<
  RefundPaymentIntentResult,
  { ok: false }
>;

/**
 * Carries a refusal out of the Reserve transaction so that it rolls back, the
 * idempotency claim included. It never leaves this file.
 */
class RefusedInTransaction extends Error {
  constructor(readonly result: RefundPaymentIntentFailure) {
    super(result.code);
  }
}

function refuse(code: RefundPaymentIntentFailureCode): never {
  throw new RefusedInTransaction({ ok: false, code });
}

/** What Reserve committed, and what Execute needs. */
interface Reservation {
  readonly intent: PaymentIntent;
  readonly refund: Refund;
  readonly providerTransactionId: string;
  readonly record: ClaimedIdempotencyRecord;
  readonly account: PaymentProcessorAccount;
  readonly adapter: ProcessorAdapter;
}

type ReserveResult =
  | { readonly kind: 'RESERVED'; readonly reservation: Reservation }
  | { readonly kind: 'REPLAY'; readonly response: IdempotentResponse }
  | { readonly kind: 'REFUSED'; readonly failure: RefundPaymentIntentFailure };

/** The requested amount as money of the intent's currency. */
function requestedAmount(
  intent: PaymentIntent,
  amountMinor: bigint,
): PositiveMoney {
  const money = createMoney(amountMinor, intent.amount.currency);
  if (!money.ok) {
    throw new Error(`refund amount is not money: ${money.code}`);
  }
  const positive = toPositiveMoney(money.money);
  if (!positive.ok) throw new Error('refund amount is not positive');
  return positive.money;
}

/**
 * Refunds part or all of a captured payment intent through the processor
 * account of its successful attempt. It follows Reserve, Execute, and Apply,
 * and no transaction is open during the provider call.
 *
 * 1. **Reserve**, one short READ COMMITTED transaction: the intent must be the
 *    merchant's (404) and the principal a `MERCHANT_ADMIN` (403); the key is
 *    claimed (a completed request is replayed, one without a conclusive answer
 *    is `OPERATION_IN_PROGRESS`); the intent row is locked `FOR UPDATE`; the
 *    merchant must be `ACTIVE`; the intent must be `SUCCEEDED` or
 *    `PARTIALLY_REFUNDED`; a refund of the intent with an unknown outcome
 *    blocks a new one; the domain's refund rule must accept the amount, counting
 *    every refund that succeeded or is still executing, pending, or unknown;
 *    the successful attempt's account is decrypted for the call, enabled or
 *    not and default or not; and the refund is inserted as `EXECUTING` with a
 *    new operation ID. The row lock is what keeps concurrent refunds from
 *    exceeding the captured amount: a second Reserve of the same intent waits
 *    for the first to commit and then counts its refund. Every refusal rolls
 *    the whole transaction back, so the key stays free.
 * 2. **Execute**: the adapter's `refund`, with the operation ID as the provider
 *    idempotency key. An adapter that throws is an unknown outcome.
 * 3. **Apply**, one short READ COMMITTED transaction: the intent row is locked
 *    again and the refund is updated only while it is `EXECUTING`; a success
 *    moves the intent to `PARTIALLY_REFUNDED` or `REFUNDED` through the
 *    transition policy and posts the refund's journal entry; one audit event
 *    is written; a conclusive outcome (succeeded, pending, failed) completes
 *    the idempotency record with the response, and an unknown one leaves it in
 *    progress.
 *
 * Refunds have no lease yet (INC-04): a crash between Reserve and Apply, or an
 * unknown result, leaves the refund `EXECUTING` or `UNKNOWN`. Its amount stays
 * counted, and an unknown refund blocks new refunds of the intent, until
 * recovery exists.
 */
@Injectable()
export class RefundPaymentIntentService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROCESSOR_REGISTRY)
    private readonly registry: ProcessorAdapterRegistry,
    private readonly claimKey: ClaimIdempotencyKeyService,
    private readonly completeRecord: CompleteIdempotencyRecordService,
    private readonly lockMerchant: LockMerchantForPaymentService,
    private readonly accounts: ProcessorAccountsForPaymentsService,
    private readonly ledger: LedgerPostingService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RefundPaymentIntentService.name);
  }

  async execute(
    command: RefundPaymentIntentCommand,
  ): Promise<RefundPaymentIntentResult> {
    if (command.principal.kind !== 'MERCHANT') {
      return { ok: false, code: 'FORBIDDEN' };
    }

    const reserved = await this.reserve(command, command.principal.merchantId);
    switch (reserved.kind) {
      case 'REPLAY':
        return { ok: true, replayed: true, response: reserved.response };
      case 'REFUSED':
        return reserved.failure;
      case 'RESERVED':
        break;
    }

    const { reservation } = reserved;
    const result = await this.executeRefund(command, reservation);
    return {
      ok: true,
      replayed: false,
      response: await this.apply(command, reservation, result),
    };
  }

  private async reserve(
    command: RefundPaymentIntentCommand,
    merchantId: string,
  ): Promise<ReserveResult> {
    try {
      return await this.database
        .transaction()
        // The claim requires READ COMMITTED (AD-62).
        .setIsolationLevel('read committed')
        .execute((trx) => this.reserveInTransaction(trx, command, merchantId));
    } catch (error) {
      if (error instanceof RefusedInTransaction) {
        return { kind: 'REFUSED', failure: error.result };
      }
      if (isLockNotAvailable(error)) {
        return {
          kind: 'REFUSED',
          failure: { ok: false, code: 'LOCK_TIMEOUT' },
        };
      }
      throw error;
    }
  }

  private async reserveInTransaction(
    trx: DatabaseTransaction,
    command: RefundPaymentIntentCommand,
    merchantId: string,
  ): Promise<ReserveResult> {
    await setLocalLockTimeout(trx, PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS);

    // AD-52 order: the intent is addressed first, then the role is checked,
    // and only then is the key claimed.
    const addressed = await findPaymentIntentByIdForMerchant(
      trx,
      merchantId,
      command.paymentIntentId,
    );
    if (addressed === undefined) refuse('NOT_FOUND');
    if (command.principal.role !== 'MERCHANT_ADMIN') refuse('FORBIDDEN');

    const refundId = randomUUID();
    const operationId = randomUUID();
    const claim = await this.claimKey.execute(trx, {
      merchantId,
      operation: REFUND_PAYMENT_INTENT_OPERATION,
      idempotencyKey: command.idempotencyKey,
      operationId,
      request: {
        payment_intent_id: command.paymentIntentId,
        amount_minor: command.amountMinor.toString(),
      },
    });
    switch (claim.outcome) {
      case 'REPLAY':
        return { kind: 'REPLAY', response: claim.response };
      case 'IN_PROGRESS':
        return refuse('OPERATION_IN_PROGRESS');
      case 'KEY_REUSED':
        return refuse('KEY_REUSED');
      case 'CLAIMED':
        break;
      default: {
        const unreachable: never = claim;
        return unreachable;
      }
    }

    // The lock that serializes every refund of this intent until commit.
    const intent = await findPaymentIntentByIdForMerchantForUpdate(
      trx,
      merchantId,
      command.paymentIntentId,
    );
    if (intent === undefined) {
      throw new Error(`payment intent ${command.paymentIntentId} disappeared`);
    }
    const merchant = await this.lockMerchant.execute(trx, merchantId);
    if (merchant === undefined) {
      throw new Error(`merchant ${merchantId} of the principal is missing`);
    }
    if (merchant.status !== 'ACTIVE') refuse('MERCHANT_NOT_ACTIVE');
    if (
      intent.status !== 'SUCCEEDED' &&
      intent.status !== 'PARTIALLY_REFUNDED'
    ) {
      refuse('INTENT_NOT_REFUNDABLE');
    }

    const refunds = await listRefunds(trx, {
      merchantId,
      paymentIntentId: intent.id,
    });
    if (refunds.some((refund) => refund.status === 'UNKNOWN')) {
      refuse('REFUND_OUTCOME_UNKNOWN');
    }
    const amount = requestedAmount(intent, command.amountMinor);
    const decision = evaluateRefundRequest(
      intent.amount,
      countedRefunds(refunds),
      amount,
    );
    if (!decision.ok) {
      if (decision.code === 'AMOUNT_EXCEEDS_REFUNDABLE') {
        refuse('AMOUNT_EXCEEDS_REFUNDABLE');
      }
      throw new Error(
        `refunds of payment intent ${intent.id} break the refund rule: ${decision.code}`,
      );
    }

    const attempt = await findSucceededPaymentAttempt(trx, {
      merchantId,
      paymentIntentId: intent.id,
    });
    if (attempt === undefined || attempt.providerTransactionId === null) {
      throw new Error(
        `payment intent ${intent.id} is ${intent.status} without a successful attempt`,
      );
    }
    // The refund goes through the account that captured the payment, whether
    // or not it is still enabled or the merchant's default.
    const resolved = await this.accounts.forExistingPayment(trx, {
      merchantId,
      processorAccountId: attempt.processorAccountId,
    });
    if (!resolved.ok) {
      if (resolved.code === 'CREDENTIALS_KEY_NOT_CONFIGURED') {
        refuse('CREDENTIALS_KEY_NOT_CONFIGURED');
      }
      // The composite foreign key keeps the attempt's account in place.
      throw new Error(
        `processor account ${attempt.processorAccountId} of attempt ${attempt.id} is ${resolved.code}`,
      );
    }
    const { account } = resolved;
    const partial = amount.amountMinor < intent.amount.amountMinor;
    const adapter = this.registry.findWithCapability(
      account.provider,
      partial ? 'PARTIAL_REFUND' : 'REFUND',
    );
    if (adapter === undefined || !adapter.capabilities.has('REFUND')) {
      refuse('PROVIDER_UNSUPPORTED');
    }

    const now = this.clock.now();
    const refund = await insertRefund(trx, {
      id: refundId,
      merchantId,
      paymentIntentId: intent.id,
      paymentAttemptId: attempt.id,
      processorAccountId: account.id,
      operationId,
      idempotencyRecordId: claim.record.id,
      amount,
      status: 'EXECUTING',
      providerRefundId: null,
      failureCode: null,
      errorCategory: null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      kind: 'RESERVED',
      reservation: {
        intent,
        refund,
        providerTransactionId: attempt.providerTransactionId,
        record: claim.record,
        account,
        adapter,
      },
    };
  }

  /**
   * Execute: the provider call, with no transaction open. A thrown error is
   * not a provider answer, so the outcome is unknown: the request may have
   * reached the provider. It is logged by name only.
   */
  private async executeRefund(
    command: RefundPaymentIntentCommand,
    reservation: Reservation,
  ): Promise<ProcessorRefundResult> {
    const { intent, refund, account, adapter } = reservation;
    try {
      return await adapter.refund({
        credentials: account.credentials,
        providerTransactionId: reservation.providerTransactionId,
        amount: refund.amount,
        operationId: refund.operationId,
        references: {
          merchantId: intent.merchantId,
          paymentIntentId: intent.id,
          refundId: refund.id,
        },
      });
    } catch (error) {
      this.logger.error(
        {
          paymentIntentId: intent.id,
          refundId: refund.id,
          errorName: error instanceof Error ? error.name : typeof error,
          correlationId: command.correlationId,
        },
        'processor refund failed with an error; the outcome is unknown',
      );
      return {
        status: 'unknown',
        category: 'UNKNOWN',
        providerRefundId: null,
      };
    }
  }

  private async apply(
    command: RefundPaymentIntentCommand,
    reservation: Reservation,
    result: ProcessorRefundResult,
  ): Promise<IdempotentResponse> {
    const { refund } = reservation;
    const resolution = refundResolutionOf(result);
    let applied: {
      readonly view: RefundView;
      readonly response: IdempotentResponse;
      readonly stored: boolean;
    };
    try {
      applied = await this.database
        .transaction()
        .setIsolationLevel('read committed')
        .execute((trx) =>
          this.applyInTransaction(trx, command, reservation, resolution),
        );
    } catch (error) {
      // The provider result is lost to the database: the refund stays
      // EXECUTING, its amount counted, until recovery (INC-04). The provider
      // refund ID is logged for manual reconciliation.
      this.logger.error(
        {
          paymentIntentId: refund.paymentIntentId,
          refundId: refund.id,
          operationId: refund.operationId,
          resolution: resolution.status,
          providerRefundId: resolution.providerRefundId,
          correlationId: command.correlationId,
        },
        'refund result could not be applied',
      );
      throw error;
    }
    this.logger.info(
      {
        paymentIntentId: refund.paymentIntentId,
        refundId: refund.id,
        refundStatus: applied.view.refund.status,
        intentStatus: applied.view.intent.status,
        errorCategory: applied.view.refund.errorCategory,
        storedUnderKey: applied.stored,
        correlationId: command.correlationId,
      },
      'refund applied',
    );
    return applied.response;
  }

  /**
   * Apply, inside one transaction. A transition the policy refuses, a refund
   * that left `EXECUTING`, an intent that moved under its row lock, or a
   * posting that fails, is a defect: it throws, and everything rolls back.
   */
  private async applyInTransaction(
    trx: DatabaseTransaction,
    command: RefundPaymentIntentCommand,
    reservation: Reservation,
    resolution: RefundResolution,
  ): Promise<{
    readonly view: RefundView;
    readonly response: IdempotentResponse;
    readonly stored: boolean;
  }> {
    const { refund } = reservation;
    const merchantId = refund.merchantId;
    const now = this.clock.now();

    // Other refunds of the intent may have been applied since Reserve; the
    // lock orders this Apply after them, and the status is read again.
    const intent = await findPaymentIntentByIdForMerchantForUpdate(
      trx,
      merchantId,
      refund.paymentIntentId,
    );
    if (intent === undefined) {
      throw new Error(`payment intent ${refund.paymentIntentId} disappeared`);
    }
    const updated = await updateRefundIfExecuting(trx, {
      merchantId,
      id: refund.id,
      status: resolution.status,
      providerRefundId: resolution.providerRefundId,
      failureCode: resolution.failureCode,
      errorCategory: resolution.errorCategory,
      updatedAt: now,
    });
    if (updated === undefined) {
      throw new Error(
        `refund ${refund.id} left EXECUTING before its result was applied`,
      );
    }

    const refunds = await listRefunds(trx, {
      merchantId,
      paymentIntentId: intent.id,
    });
    let current = intent;
    let journalEntryId: string | null = null;
    if (updated.status === 'SUCCEEDED') {
      const computed = refundTotals(intent.amount, countedRefunds(refunds));
      if (!computed.ok) {
        throw new Error(
          `refunds of payment intent ${intent.id} break the refund rule: ${computed.code}`,
        );
      }
      const target = refundedStatusOf(computed.totals);
      const transition = evaluatePaymentIntentTransition(intent.status, target);
      if (!transition.ok) {
        throw new Error(
          `payment intent ${intent.id} cannot move from ${intent.status} to ${target}: ${transition.code}`,
        );
      }
      const moved = await updatePaymentIntentStatusIfCurrent(trx, {
        merchantId,
        id: intent.id,
        from: intent.status,
        to: target,
        updatedAt: now,
      });
      if (moved === undefined) {
        throw new Error(
          `payment intent ${intent.id} changed under its row lock`,
        );
      }
      current = moved;
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

    await appendAuditEvent(trx, {
      id: randomUUID(),
      occurredAt: now,
      ...auditActorOf(command.principal),
      action: PAYMENT_REFUND_APPLIED,
      targetType: 'PAYMENT_INTENT',
      targetId: intent.id,
      merchantId,
      correlationId: command.correlationId,
      metadata: {
        refund_id: updated.id,
        payment_attempt_id: updated.paymentAttemptId,
        processor_account_id: updated.processorAccountId,
        refund_status: updated.status,
        previous_status: intent.status,
        status: current.status,
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
      intent: current,
      summary: refundSummaryOf(current, refunds),
    };
    const response = command.present(view);
    const conclusive = updated.status !== 'UNKNOWN';
    if (conclusive) {
      const completion = await this.completeRecord.execute(trx, {
        record: {
          id: updated.idempotencyRecordId,
          merchantId,
        },
        response,
      });
      if (!completion.ok) {
        throw new Error(
          `idempotency record ${updated.idempotencyRecordId} of refund ${updated.id} could not be completed: ${completion.code}`,
        );
      }
    }
    return { view, response, stored: conclusive };
  }
}
