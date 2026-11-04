import { randomUUID } from 'node:crypto';
import {
  isLockNotAvailable,
  setLocalLockTimeout,
  type Database,
  type DatabaseTransaction,
} from '@merchantflow/database';
import {
  evaluatePaymentIntentTransition,
  type PaymentIntent,
} from '@merchantflow/domain';
import type {
  ProcessorAdapter,
  ProcessorAdapterRegistry,
  ProcessorPaymentResult,
} from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Principal } from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { ClaimIdempotencyKeyService } from '../../idempotency/application/claim-idempotency-key.service.js';
import type {
  ClaimedIdempotencyRecord,
  IdempotentResponse,
} from '../../idempotency/application/idempotency-record.js';
import { LockMerchantForPaymentService } from '../../merchants/application/lock-merchant-for-payment.service.js';
import {
  ProcessorAccountsForPaymentsService,
  type PaymentProcessorAccount,
  type PaymentProcessorAccountResult,
} from '../../merchants/application/processor-accounts-for-payments.service.js';
import { PROCESSOR_REGISTRY } from '../../processors/application/processor-registry.js';
import {
  findOpenPaymentAttempt,
  insertPaymentAttempt,
} from '../infrastructure/payment-attempt-queries.js';
import {
  findPaymentIntentByIdForMerchant,
  findPaymentIntentByIdForMerchantForUpdate,
  updatePaymentIntentStatusIfCurrent,
} from '../infrastructure/payment-intent-queries.js';
import {
  ApplyAttemptResolutionService,
  type PresentPaymentConfirmation,
} from './apply-attempt-resolution.service.js';
import { PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS } from './create-payment-intent.service.js';
import { resolutionOf, type PaymentAttempt } from './payment-attempt.js';

/** Idempotency operation of a confirmation; keys are scoped by it. */
export const CONFIRM_PAYMENT_INTENT_OPERATION = 'CONFIRM_PAYMENT_INTENT';

/** Audit action of a confirmation whose provider result was applied. */
export const PAYMENT_INTENT_CONFIRMED = 'PAYMENT_INTENT_CONFIRMED';

export interface ConfirmPaymentIntentCommand {
  readonly principal: Principal;
  readonly correlationId: string;
  /** Already checked against the format of the idempotency store. */
  readonly idempotencyKey: string;
  readonly paymentIntentId: string;
  /** A provider payment method token created in the browser; never card data. */
  readonly paymentMethod: string;
  /** The account whose publishable key created the payment method. */
  readonly processorAccountId: string;
  readonly present: PresentPaymentConfirmation;
}

export type ConfirmPaymentIntentFailureCode =
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
  /** An attempt of the intent has an unknown outcome. Nothing was stored. */
  | 'PAYMENT_OUTCOME_UNKNOWN'
  /** An attempt of the intent is executing or waits for the customer. */
  | 'ATTEMPT_IN_PROGRESS'
  /** The intent is `SUCCEEDED` or `FAILED`. Nothing was stored. */
  | 'INTENT_NOT_CONFIRMABLE'
  /** The account is not the merchant's. Nothing was stored. */
  | 'PROCESSOR_ACCOUNT_NOT_FOUND'
  /** The account is disabled. Nothing was stored. */
  | 'PROCESSOR_ACCOUNT_DISABLED'
  /** The account is not the merchant's default. Nothing was stored. */
  | 'PROCESSOR_ACCOUNT_NOT_DEFAULT'
  /** No master key decrypts the account's secret. Nothing was stored. */
  | 'CREDENTIALS_KEY_NOT_CONFIGURED'
  /** The account's provider has no adapter that can make a sale. */
  | 'PROVIDER_UNSUPPORTED';

export type ConfirmPaymentIntentResult =
  | {
      readonly ok: true;
      /** True when the response was stored by an earlier request under the key. */
      readonly replayed: boolean;
      readonly response: IdempotentResponse;
    }
  | { readonly ok: false; readonly code: ConfirmPaymentIntentFailureCode };

type ConfirmPaymentIntentFailure = Extract<
  ConfirmPaymentIntentResult,
  { ok: false }
>;

/**
 * Carries a refusal out of the Reserve transaction so that it rolls back, the
 * idempotency claim included. It never leaves this file.
 */
class RefusedInTransaction extends Error {
  constructor(readonly result: ConfirmPaymentIntentFailure) {
    super(result.code);
  }
}

/** What Reserve committed, and what Execute needs. */
interface Reservation {
  readonly intent: PaymentIntent;
  readonly attempt: PaymentAttempt;
  readonly record: ClaimedIdempotencyRecord;
  readonly account: PaymentProcessorAccount;
  readonly adapter: ProcessorAdapter;
}

type ReserveResult =
  | { readonly kind: 'RESERVED'; readonly reservation: Reservation }
  | { readonly kind: 'REPLAY'; readonly response: IdempotentResponse }
  | { readonly kind: 'REFUSED'; readonly failure: ConfirmPaymentIntentFailure };

function refuse(code: ConfirmPaymentIntentFailureCode): never {
  throw new RefusedInTransaction({ ok: false, code });
}

/**
 * Why an intent in this status cannot start an attempt, or `undefined` for
 * `CREATED`, the only status that can.
 */
function statusRefusal(
  status: PaymentIntent['status'],
): ConfirmPaymentIntentFailureCode | undefined {
  switch (status) {
    case 'CREATED':
      return undefined;
    case 'UNKNOWN':
      return 'PAYMENT_OUTCOME_UNKNOWN';
    case 'PROCESSING':
    case 'REQUIRES_ACTION':
      return 'ATTEMPT_IN_PROGRESS';
    case 'SUCCEEDED':
    case 'FAILED':
      return 'INTENT_NOT_CONFIRMABLE';
  }
}

/** The refusal of an account that a new payment cannot use. */
function accountRefusal(
  code: Extract<PaymentProcessorAccountResult, { ok: false }>['code'],
): ConfirmPaymentIntentFailureCode {
  switch (code) {
    case 'NOT_FOUND':
      return 'PROCESSOR_ACCOUNT_NOT_FOUND';
    case 'DISABLED':
      return 'PROCESSOR_ACCOUNT_DISABLED';
    case 'NOT_DEFAULT':
      return 'PROCESSOR_ACCOUNT_NOT_DEFAULT';
    case 'CREDENTIALS_KEY_NOT_CONFIGURED':
      return 'CREDENTIALS_KEY_NOT_CONFIGURED';
  }
}

/**
 * Confirms a payment intent: charges it once through the merchant's default
 * processor account, with the payment method the browser created. It follows
 * Reserve, Execute, and Apply, and no transaction is open during the provider
 * call.
 *
 * 1. **Reserve**, one short READ COMMITTED transaction: the intent must be the
 *    merchant's (404) and the principal a `MERCHANT_ADMIN` (403); the key is
 *    claimed (a completed request is replayed, one without a conclusive answer
 *    is `OPERATION_IN_PROGRESS`); the intent row is locked `FOR UPDATE`; the
 *    merchant must be `ACTIVE`; an open attempt is refused (`UNKNOWN` as
 *    `PAYMENT_OUTCOME_UNKNOWN`, the others as `ATTEMPT_IN_PROGRESS`) and so is
 *    a final intent; the account must be the merchant's enabled default and
 *    is decrypted for the call; the attempt is inserted as `EXECUTING` with a
 *    new operation ID, and the intent moves to `PROCESSING`. Every refusal
 *    rolls the whole transaction back, so the key stays free. The open
 *    attempt is found by reading, under the intent's lock: the partial unique
 *    index is a last defense, never the expected path.
 * 2. **Execute**: the adapter's `sale`, with the operation ID as the provider
 *    idempotency key. An adapter that throws is an unknown outcome.
 * 3. **Apply**: `ApplyAttemptResolutionService` in one short transaction.
 *
 * Attempts have no lease yet (INC-04): a crash between Reserve and Apply, or
 * an unknown result, leaves the attempt `EXECUTING` or `UNKNOWN`, which blocks
 * the intent until recovery exists.
 */
@Injectable()
export class ConfirmPaymentIntentService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROCESSOR_REGISTRY)
    private readonly registry: ProcessorAdapterRegistry,
    private readonly claimKey: ClaimIdempotencyKeyService,
    private readonly lockMerchant: LockMerchantForPaymentService,
    private readonly accounts: ProcessorAccountsForPaymentsService,
    private readonly applyResolution: ApplyAttemptResolutionService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ConfirmPaymentIntentService.name);
  }

  async execute(
    command: ConfirmPaymentIntentCommand,
  ): Promise<ConfirmPaymentIntentResult> {
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
    const result = await this.executeSale(command, reservation);
    return {
      ok: true,
      replayed: false,
      response: await this.apply(command, reservation, result),
    };
  }

  private async reserve(
    command: ConfirmPaymentIntentCommand,
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
    command: ConfirmPaymentIntentCommand,
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

    const attemptId = randomUUID();
    const operationId = randomUUID();
    const claim = await this.claimKey.execute(trx, {
      merchantId,
      operation: CONFIRM_PAYMENT_INTENT_OPERATION,
      idempotencyKey: command.idempotencyKey,
      operationId,
      request: {
        payment_intent_id: command.paymentIntentId,
        payment_method: command.paymentMethod,
        processor_account_id: command.processorAccountId,
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

    const open = await findOpenPaymentAttempt(trx, {
      merchantId,
      paymentIntentId: intent.id,
    });
    if (open?.status === 'UNKNOWN') refuse('PAYMENT_OUTCOME_UNKNOWN');
    if (open !== undefined) refuse('ATTEMPT_IN_PROGRESS');
    const blocked = statusRefusal(intent.status);
    if (blocked !== undefined) refuse(blocked);

    const resolved = await this.accounts.forNewPayment(trx, {
      merchantId,
      processorAccountId: command.processorAccountId,
    });
    if (!resolved.ok) refuse(accountRefusal(resolved.code));
    const { account } = resolved;
    const adapter = this.registry.findWithCapability(account.provider, 'SALE');
    if (adapter === undefined) refuse('PROVIDER_UNSUPPORTED');

    const transition = evaluatePaymentIntentTransition(
      intent.status,
      'PROCESSING',
    );
    if (!transition.ok) {
      throw new Error(
        `payment intent ${intent.id} cannot be reserved: ${transition.code}`,
      );
    }
    const now = this.clock.now();
    const attempt = await insertPaymentAttempt(trx, {
      id: attemptId,
      merchantId,
      paymentIntentId: intent.id,
      processorAccountId: account.id,
      operationId,
      idempotencyRecordId: claim.record.id,
      status: 'EXECUTING',
      providerTransactionId: null,
      declineCode: null,
      errorCategory: null,
      createdAt: now,
      updatedAt: now,
    });
    const processing = await updatePaymentIntentStatusIfCurrent(trx, {
      merchantId,
      id: intent.id,
      from: intent.status,
      to: 'PROCESSING',
      updatedAt: now,
    });
    if (processing === undefined) {
      throw new Error(`payment intent ${intent.id} changed under its row lock`);
    }
    return {
      kind: 'RESERVED',
      reservation: {
        intent: processing,
        attempt,
        record: claim.record,
        account,
        adapter,
      },
    };
  }

  /**
   * Execute: the provider call, with no transaction open. A thrown error is
   * not a provider answer, so the outcome is unknown: the request may have
   * reached the provider. It is logged by name only, never with a message
   * that could hold provider data.
   */
  private async executeSale(
    command: ConfirmPaymentIntentCommand,
    reservation: Reservation,
  ): Promise<ProcessorPaymentResult> {
    const { intent, attempt, account, adapter } = reservation;
    try {
      return await adapter.sale({
        credentials: account.credentials,
        amount: intent.amount,
        paymentMethod: command.paymentMethod,
        operationId: attempt.operationId,
        references: {
          merchantId: intent.merchantId,
          paymentIntentId: intent.id,
          paymentAttemptId: attempt.id,
        },
      });
    } catch (error) {
      this.logger.error(
        {
          paymentIntentId: intent.id,
          paymentAttemptId: attempt.id,
          errorName: error instanceof Error ? error.name : typeof error,
          correlationId: command.correlationId,
        },
        'processor sale failed with an error; the outcome is unknown',
      );
      return {
        status: 'unknown',
        category: 'UNKNOWN',
        providerTransactionId: null,
      };
    }
  }

  private async apply(
    command: ConfirmPaymentIntentCommand,
    reservation: Reservation,
    result: ProcessorPaymentResult,
  ): Promise<IdempotentResponse> {
    const { intent, attempt } = reservation;
    const resolution = resolutionOf(result);
    let applied;
    try {
      applied = await this.database
        .transaction()
        .setIsolationLevel('read committed')
        .execute((trx) =>
          this.applyResolution.execute(trx, {
            principal: command.principal,
            correlationId: command.correlationId,
            intent,
            attempt,
            resolution,
            auditAction: PAYMENT_INTENT_CONFIRMED,
            present: command.present,
          }),
        );
    } catch (error) {
      // The provider result is lost to the database: the attempt stays
      // EXECUTING and the intent PROCESSING until recovery (INC-04). The
      // provider transaction ID is logged for manual reconciliation.
      this.logger.error(
        {
          paymentIntentId: intent.id,
          paymentAttemptId: attempt.id,
          operationId: attempt.operationId,
          resolution: resolution.kind,
          providerTransactionId: resolution.providerTransactionId,
          correlationId: command.correlationId,
        },
        'payment attempt result could not be applied',
      );
      throw error;
    }
    if (applied.outcome === 'NOT_CURRENT') {
      throw new Error(
        `payment attempt ${attempt.id} left EXECUTING before its result was applied`,
      );
    }
    this.logger.info(
      {
        paymentIntentId: intent.id,
        paymentAttemptId: attempt.id,
        attemptStatus: applied.view.attempt.status,
        intentStatus: applied.view.intent.status,
        errorCategory: applied.view.attempt.errorCategory,
        storedUnderKey: applied.stored,
        correlationId: command.correlationId,
      },
      'payment confirmation applied',
    );
    return applied.response;
  }
}
