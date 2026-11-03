import { randomUUID } from 'node:crypto';
import {
  isLockNotAvailable,
  setLocalLockTimeout,
  type Database,
  type DatabaseTransaction,
} from '@merchantflow/database';
import {
  toAmountMinorString,
  type PaymentIntent,
  type PositiveMoney,
} from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { ClaimIdempotencyKeyService } from '../../idempotency/application/claim-idempotency-key.service.js';
import { CompleteIdempotencyRecordService } from '../../idempotency/application/complete-idempotency-record.service.js';
import type { IdempotentResponse } from '../../idempotency/application/idempotency-record.js';
import { LockMerchantForPaymentService } from '../../merchants/application/lock-merchant-for-payment.service.js';
import { insertPaymentIntentIfReferenceAbsent } from '../infrastructure/payment-intent-queries.js';

/** Idempotency operation of intent creation; keys are scoped by it. */
export const CREATE_PAYMENT_INTENT_OPERATION = 'CREATE_PAYMENT_INTENT';

/**
 * How long one statement of the command may wait for a lock: on the claim of a
 * key that another request holds, on a `merchant_reference` that another
 * request is inserting, or on the merchant row while its status changes. The
 * command's own work takes milliseconds, so a longer wait means another
 * transaction is stuck. It is below the pool's 5 s query timeout (AD-33), so
 * PostgreSQL ends the wait with a definite error before the client gives up.
 */
export const PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS = 2_000;

export interface CreatePaymentIntentCommand {
  readonly principal: Principal;
  readonly correlationId: string;
  /** Already checked against the format of the idempotency store. */
  readonly idempotencyKey: string;
  readonly amount: PositiveMoney;
  /** Already checked against the format of `payment_intents`. */
  readonly merchantReference: string;
  /**
   * Builds the response for the created intent. It is returned and stored
   * under the key in the same transaction, so a retry receives exactly it.
   */
  readonly present: (intent: PaymentIntent) => IdempotentResponse;
}

export type CreatePaymentIntentFailureCode =
  /** The key is not a `MERCHANT_ADMIN` key. Nothing was read or written. */
  | 'FORBIDDEN'
  /** The merchant is not `ACTIVE`. Nothing was stored. */
  | 'MERCHANT_NOT_ACTIVE'
  /** The currency is not the merchant's default currency. Nothing was stored. */
  | 'CURRENCY_MISMATCH'
  /** Another key already created an intent for the reference. Nothing was stored. */
  | 'DUPLICATE_MERCHANT_REFERENCE'
  /** The same request under the same key has not completed. */
  | 'OPERATION_IN_PROGRESS'
  /** The key was used for a different request. */
  | 'KEY_REUSED'
  /** A lock wait exceeded the limit. Nothing was stored; the request can be sent again. */
  | 'LOCK_TIMEOUT';

export type CreatePaymentIntentResult =
  | {
      readonly ok: true;
      /** True when the response was stored by an earlier request under the key. */
      readonly replayed: boolean;
      readonly response: IdempotentResponse;
    }
  | { readonly ok: false; readonly code: CreatePaymentIntentFailureCode };

type CreatePaymentIntentFailure = Extract<
  CreatePaymentIntentResult,
  { ok: false }
>;

/**
 * Carries a refusal out of the transaction callback so that the transaction
 * rolls back, the idempotency claim included. It never leaves this file: the
 * service turns it back into its result.
 */
class RefusedInTransaction extends Error {
  constructor(readonly result: CreatePaymentIntentFailure) {
    super(result.code);
  }
}

/**
 * Creates a payment intent for the merchant of a `MERCHANT_ADMIN` key, once
 * per idempotency key. One short READ COMMITTED transaction claims the key,
 * share-locks the merchant and checks that it is `ACTIVE` and that the
 * currency is its default currency, inserts the intent unless the reference is
 * taken, writes the `PAYMENT_INTENT_CREATED` audit event, and stores the
 * response under the key. Creation has no external effect.
 *
 * **What is stored under the key:** only a created intent. Every refusal rolls
 * the whole transaction back, the claim included, so the key stays free: the
 * same request gets the same refusal while its cause lasts, and succeeds once
 * the cause is gone (for example after a reactivation). A replay returns the
 * stored response whatever the merchant's status is now, because the intent
 * exists. A duplicate reference stays a duplicate for good, since intents are
 * never deleted.
 *
 * The merchant comes only from the principal. The role is checked here as well
 * as at the route, because other callers (the worker, the MCP server) will not
 * pass through the guard.
 */
@Injectable()
export class CreatePaymentIntentService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly claimKey: ClaimIdempotencyKeyService,
    private readonly completeRecord: CompleteIdempotencyRecordService,
    private readonly lockMerchant: LockMerchantForPaymentService,
  ) {}

  async execute(
    command: CreatePaymentIntentCommand,
  ): Promise<CreatePaymentIntentResult> {
    const { principal } = command;
    if (principal.kind !== 'MERCHANT' || principal.role !== 'MERCHANT_ADMIN') {
      return { ok: false, code: 'FORBIDDEN' };
    }

    const now = this.clock.now();
    const intent: PaymentIntent = {
      id: randomUUID(),
      merchantId: principal.merchantId,
      amount: command.amount,
      merchantReference: command.merchantReference,
      status: 'CREATED',
      createdAt: now,
      updatedAt: now,
    };
    try {
      return await this.database
        .transaction()
        // The claim requires READ COMMITTED (AD-62); it is set explicitly so
        // that a different server default cannot change the outcome.
        .setIsolationLevel('read committed')
        .execute((trx) => this.createInTransaction(trx, command, intent));
    } catch (error) {
      if (error instanceof RefusedInTransaction) return error.result;
      if (isLockNotAvailable(error)) return { ok: false, code: 'LOCK_TIMEOUT' };
      throw error;
    }
  }

  private async createInTransaction(
    trx: DatabaseTransaction,
    command: CreatePaymentIntentCommand,
    intent: PaymentIntent,
  ): Promise<CreatePaymentIntentResult> {
    await setLocalLockTimeout(trx, PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS);

    const claim = await this.claimKey.execute(trx, {
      merchantId: intent.merchantId,
      operation: CREATE_PAYMENT_INTENT_OPERATION,
      idempotencyKey: command.idempotencyKey,
      operationId: intent.id,
      // The validated values in their one accepted spelling, never the raw
      // body, so the fingerprint ignores key order, whitespace, and headers.
      request: {
        amount_minor: toAmountMinorString(intent.amount),
        currency: intent.amount.currency,
        merchant_reference: intent.merchantReference,
      },
    });
    switch (claim.outcome) {
      case 'REPLAY':
        return { ok: true, replayed: true, response: claim.response };
      case 'IN_PROGRESS':
        return { ok: false, code: 'OPERATION_IN_PROGRESS' };
      case 'KEY_REUSED':
        return { ok: false, code: 'KEY_REUSED' };
      case 'CLAIMED':
        break;
      default: {
        const unreachable: never = claim;
        return unreachable;
      }
    }

    const merchant = await this.lockMerchant.execute(trx, intent.merchantId);
    if (merchant === undefined) {
      // The key row references the merchant, and merchants are never deleted.
      throw new Error(
        `merchant ${intent.merchantId} of the principal is missing`,
      );
    }
    if (merchant.status !== 'ACTIVE') {
      throw new RefusedInTransaction({
        ok: false,
        code: 'MERCHANT_NOT_ACTIVE',
      });
    }
    if (merchant.defaultCurrency !== intent.amount.currency) {
      throw new RefusedInTransaction({ ok: false, code: 'CURRENCY_MISMATCH' });
    }

    const stored = await insertPaymentIntentIfReferenceAbsent(trx, intent);
    if (stored === undefined) {
      throw new RefusedInTransaction({
        ok: false,
        code: 'DUPLICATE_MERCHANT_REFERENCE',
      });
    }
    await appendAuditEvent(trx, {
      id: randomUUID(),
      occurredAt: stored.createdAt,
      ...auditActorOf(command.principal),
      action: 'PAYMENT_INTENT_CREATED',
      targetType: 'PAYMENT_INTENT',
      targetId: stored.id,
      merchantId: stored.merchantId,
      correlationId: command.correlationId,
      metadata: {
        amount_minor: toAmountMinorString(stored.amount),
        currency: stored.amount.currency,
        status: stored.status,
      },
    });

    const response = command.present(stored);
    const completion = await this.completeRecord.execute(trx, {
      record: claim.record,
      response,
    });
    if (!completion.ok) {
      // The record was claimed in this transaction, so no one else can have
      // completed it.
      throw new Error(
        `idempotency record ${claim.record.id} could not be completed: ${completion.code}`,
      );
    }
    return { ok: true, replayed: false, response };
  }
}
