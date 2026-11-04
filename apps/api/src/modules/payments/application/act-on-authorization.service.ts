import { randomUUID } from 'node:crypto';
import {
  isLockNotAvailable,
  setLocalLockTimeout,
  type Database,
  type DatabaseTransaction,
} from '@merchantflow/database';
import type { PaymentIntent } from '@merchantflow/domain';
import type {
  ProcessorAdapter,
  ProcessorAdapterRegistry,
  ProcessorAuthorizationActionResult,
} from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { ClaimIdempotencyKeyService } from '../../idempotency/application/claim-idempotency-key.service.js';
import type { IdempotentResponse } from '../../idempotency/application/idempotency-record.js';
import { LockMerchantForPaymentService } from '../../merchants/application/lock-merchant-for-payment.service.js';
import {
  ProcessorAccountsForPaymentsService,
  type PaymentProcessorAccount,
} from '../../merchants/application/processor-accounts-for-payments.service.js';
import { PROCESSOR_REGISTRY } from '../../processors/application/processor-registry.js';
import {
  findBlockingAuthorizationAction,
  insertAuthorizationAction,
} from '../infrastructure/authorization-action-queries.js';
import { findAuthorizedPaymentAttempt } from '../infrastructure/payment-attempt-queries.js';
import {
  findPaymentIntentByIdForMerchant,
  findPaymentIntentByIdForMerchantForUpdate,
} from '../infrastructure/payment-intent-queries.js';
import {
  ApplyAuthorizationActionService,
  type PresentAuthorizationAction,
} from './apply-authorization-action.service.js';
import {
  authorizationActionResolutionOf,
  type AuthorizationAction,
  type AuthorizationActionKind,
} from './authorization-action.js';
import { PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS } from './create-payment-intent.service.js';
import type { PaymentAttempt } from './payment-attempt.js';

/**
 * Idempotency operation of a capture and of a void. Both share it, so a key
 * used for a capture of an intent is refused for its void, and the other way
 * round, as a key reused for a different request.
 */
export const CAPTURE_OR_VOID_PAYMENT_INTENT_OPERATION =
  'CAPTURE_OR_VOID_PAYMENT_INTENT';

/** Audit action of a capture or void whose provider result was applied. */
export const PAYMENT_AUTHORIZATION_ACTION_APPLIED =
  'PAYMENT_AUTHORIZATION_ACTION_APPLIED';

export interface ActOnAuthorizationCommand {
  readonly principal: Principal;
  readonly correlationId: string;
  /** Already checked against the format of the idempotency store. */
  readonly idempotencyKey: string;
  readonly paymentIntentId: string;
  readonly action: AuthorizationActionKind;
  readonly present: PresentAuthorizationAction;
}

export type ActOnAuthorizationFailureCode =
  /** Not a `MERCHANT_ADMIN` of the intent's merchant. Nothing was written. */
  | 'FORBIDDEN'
  /** No intent with this id belongs to the merchant. Nothing was written. */
  | 'NOT_FOUND'
  /** A capture of a merchant that is not `ACTIVE`. Nothing was stored. */
  | 'MERCHANT_NOT_ACTIVE'
  /** The same request under the same key has no conclusive answer yet. */
  | 'OPERATION_IN_PROGRESS'
  /** The key was used for a different request. */
  | 'KEY_REUSED'
  /** A lock wait exceeded the limit. Nothing was stored. */
  | 'LOCK_TIMEOUT'
  /** Another capture or void of the intent is executing. Nothing was stored. */
  | 'ACTION_IN_PROGRESS'
  /** An earlier capture or void of the intent has an unknown outcome. */
  | 'ACTION_OUTCOME_UNKNOWN'
  /** A capture of an intent that is not `REQUIRES_CAPTURE`. */
  | 'NOT_CAPTURABLE'
  /** A void of an intent that is not `REQUIRES_CAPTURE`. */
  | 'NOT_VOIDABLE'
  /** No master key decrypts the account's secret. Nothing was stored. */
  | 'CREDENTIALS_KEY_NOT_CONFIGURED'
  /** The account's provider has no adapter that can capture or void. */
  | 'PROVIDER_UNSUPPORTED';

export type ActOnAuthorizationResult =
  | {
      readonly ok: true;
      /** True when the response was stored by an earlier request under the key. */
      readonly replayed: boolean;
      readonly response: IdempotentResponse;
    }
  | { readonly ok: false; readonly code: ActOnAuthorizationFailureCode };

type ActOnAuthorizationFailure = Extract<
  ActOnAuthorizationResult,
  { ok: false }
>;

/**
 * Carries a refusal out of the Reserve transaction so that it rolls back, the
 * idempotency claim included. It never leaves this file.
 */
class RefusedInTransaction extends Error {
  constructor(readonly result: ActOnAuthorizationFailure) {
    super(result.code);
  }
}

function refuse(code: ActOnAuthorizationFailureCode): never {
  throw new RefusedInTransaction({ ok: false, code });
}

/** What Reserve committed, and what Execute needs. */
interface Reservation {
  readonly intent: PaymentIntent;
  readonly attempt: PaymentAttempt;
  readonly providerTransactionId: string;
  readonly action: AuthorizationAction;
  readonly account: PaymentProcessorAccount;
  readonly adapter: ProcessorAdapter;
}

type ReserveResult =
  | { readonly kind: 'RESERVED'; readonly reservation: Reservation }
  | { readonly kind: 'REPLAY'; readonly response: IdempotentResponse }
  | { readonly kind: 'REFUSED'; readonly failure: ActOnAuthorizationFailure };

/**
 * Captures the whole held amount of a `MANUAL` payment intent, or voids its
 * hold, through the processor account of its authorized attempt. It follows
 * Reserve, Execute, and Apply, and no transaction is open during the provider
 * call.
 *
 * 1. **Reserve**, one short READ COMMITTED transaction: the intent must be the
 *    merchant's (404) and the principal a `MERCHANT_ADMIN` (403); the key is
 *    claimed under one operation shared by capture and void (a completed
 *    request is replayed, one without a conclusive answer is
 *    `OPERATION_IN_PROGRESS`, and the key of the other action is
 *    `KEY_REUSED`); the intent row is locked `FOR UPDATE`; a capture needs an
 *    `ACTIVE` merchant, while a void, which moves no money, does not; an
 *    executing action of the intent is `ACTION_IN_PROGRESS` and an unknown one
 *    `ACTION_OUTCOME_UNKNOWN`; the intent must be `REQUIRES_CAPTURE`; the
 *    authorized attempt's account is decrypted for the call, enabled or not
 *    and default or not; and the action is inserted as `EXECUTING` with a new
 *    operation ID. The row lock is what makes a capture and a void of one
 *    intent exclude each other under concurrent requests: the second Reserve
 *    waits for the first to commit and then reads its action. The partial
 *    unique index of the table is the last defense. Every refusal rolls the
 *    whole transaction back, so the key stays free.
 * 2. **Execute**: the adapter's `capture` or `void`, with the operation ID as
 *    the provider idempotency key. An adapter that throws is an unknown
 *    outcome.
 * 3. **Apply**: `ApplyAuthorizationActionService` in one short transaction.
 *
 * Actions have no lease yet (INC-04): a crash between Reserve and Apply leaves
 * the action `EXECUTING`, which blocks the intent until recovery exists. An
 * unknown result is resolved by the account's webhook or by the action check
 * (`ResolveAuthorizationActionService`).
 */
@Injectable()
export class ActOnAuthorizationService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROCESSOR_REGISTRY)
    private readonly registry: ProcessorAdapterRegistry,
    private readonly claimKey: ClaimIdempotencyKeyService,
    private readonly lockMerchant: LockMerchantForPaymentService,
    private readonly accounts: ProcessorAccountsForPaymentsService,
    private readonly applyAction: ApplyAuthorizationActionService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ActOnAuthorizationService.name);
  }

  async execute(
    command: ActOnAuthorizationCommand,
  ): Promise<ActOnAuthorizationResult> {
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
    const result = await this.executeAction(command, reservation);
    return {
      ok: true,
      replayed: false,
      response: await this.apply(command, reservation, result),
    };
  }

  private async reserve(
    command: ActOnAuthorizationCommand,
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
    command: ActOnAuthorizationCommand,
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

    const actionId = randomUUID();
    const operationId = randomUUID();
    const claim = await this.claimKey.execute(trx, {
      merchantId,
      operation: CAPTURE_OR_VOID_PAYMENT_INTENT_OPERATION,
      idempotencyKey: command.idempotencyKey,
      operationId,
      request: {
        payment_intent_id: command.paymentIntentId,
        action: command.action,
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

    // The lock that serializes every capture and void of this intent.
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
    // A capture moves money; a void only releases the customer's funds.
    if (command.action === 'CAPTURE' && merchant.status !== 'ACTIVE') {
      refuse('MERCHANT_NOT_ACTIVE');
    }

    const blocking = await findBlockingAuthorizationAction(trx, {
      merchantId,
      paymentIntentId: intent.id,
    });
    if (blocking?.status === 'EXECUTING') refuse('ACTION_IN_PROGRESS');
    if (blocking?.status === 'UNKNOWN') refuse('ACTION_OUTCOME_UNKNOWN');
    if (intent.status !== 'REQUIRES_CAPTURE') {
      refuse(command.action === 'CAPTURE' ? 'NOT_CAPTURABLE' : 'NOT_VOIDABLE');
    }

    const attempt = await findAuthorizedPaymentAttempt(trx, {
      merchantId,
      paymentIntentId: intent.id,
    });
    if (attempt === undefined || attempt.providerTransactionId === null) {
      throw new Error(
        `payment intent ${intent.id} is REQUIRES_CAPTURE without an authorized attempt`,
      );
    }
    // The hold can only be captured or released by the Stripe account that
    // authorized it, whether or not it is still enabled or the default.
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
    const adapter = this.registry.findWithCapability(
      account.provider,
      command.action === 'CAPTURE' ? 'CAPTURE' : 'VOID',
    );
    if (adapter === undefined) refuse('PROVIDER_UNSUPPORTED');

    const now = this.clock.now();
    const action = await insertAuthorizationAction(trx, {
      id: actionId,
      merchantId,
      paymentIntentId: intent.id,
      paymentAttemptId: attempt.id,
      processorAccountId: account.id,
      action: command.action,
      operationId,
      idempotencyRecordId: claim.record.id,
      amount: intent.amount,
      status: 'EXECUTING',
      failureCode: null,
      errorCategory: null,
      createdAt: now,
      updatedAt: now,
    });
    return {
      kind: 'RESERVED',
      reservation: {
        intent,
        attempt,
        providerTransactionId: attempt.providerTransactionId,
        action,
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
  private async executeAction(
    command: ActOnAuthorizationCommand,
    reservation: Reservation,
  ): Promise<ProcessorAuthorizationActionResult> {
    const { intent, action, account, adapter, providerTransactionId } =
      reservation;
    const references = {
      merchantId: intent.merchantId,
      paymentIntentId: intent.id,
      authorizationActionId: action.id,
    };
    try {
      return action.action === 'CAPTURE'
        ? await adapter.capture({
            credentials: account.credentials,
            providerTransactionId,
            amount: action.amount,
            operationId: action.operationId,
            references,
          })
        : await adapter.void({
            credentials: account.credentials,
            providerTransactionId,
            operationId: action.operationId,
            references,
          });
    } catch (error) {
      this.logger.error(
        {
          paymentIntentId: intent.id,
          authorizationActionId: action.id,
          action: action.action,
          errorName: error instanceof Error ? error.name : typeof error,
          correlationId: command.correlationId,
        },
        'processor capture or void failed with an error; the outcome is unknown',
      );
      return { status: 'unknown', category: 'UNKNOWN' };
    }
  }

  private async apply(
    command: ActOnAuthorizationCommand,
    reservation: Reservation,
    result: ProcessorAuthorizationActionResult,
  ): Promise<IdempotentResponse> {
    const { action, attempt } = reservation;
    const resolution = authorizationActionResolutionOf(result);
    let applied;
    try {
      applied = await this.database
        .transaction()
        .setIsolationLevel('read committed')
        .execute((trx) =>
          this.applyAction.execute(trx, {
            actor: auditActorOf(command.principal),
            correlationId: command.correlationId,
            action,
            attempt,
            resolution,
            auditAction: PAYMENT_AUTHORIZATION_ACTION_APPLIED,
            present: command.present,
          }),
        );
    } catch (error) {
      // The provider result is lost to the database: the action stays
      // EXECUTING until recovery (INC-04). Its outcome is logged for manual
      // reconciliation.
      this.logger.error(
        {
          paymentIntentId: action.paymentIntentId,
          authorizationActionId: action.id,
          operationId: action.operationId,
          action: action.action,
          resolution: resolution.status,
          correlationId: command.correlationId,
        },
        'capture or void result could not be applied',
      );
      throw error;
    }
    if (applied.outcome === 'NOT_CURRENT') {
      throw new Error(
        `authorization action ${action.id} left EXECUTING before its result was applied`,
      );
    }
    this.logger.info(
      {
        paymentIntentId: action.paymentIntentId,
        authorizationActionId: action.id,
        action: action.action,
        actionStatus: applied.view.action.status,
        intentStatus: applied.view.intent.status,
        errorCategory: applied.view.action.errorCategory,
        storedUnderKey: applied.stored,
        correlationId: command.correlationId,
      },
      'capture or void applied',
    );
    return applied.response;
  }
}
