import type { Database } from '@merchantflow/database';
import type { ProcessorAdapterRegistry } from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DATABASE } from '../../database/database.module.js';
import { ProcessorAccountsForPaymentsService } from '../../merchants/application/processor-accounts-for-payments.service.js';
import { PROCESSOR_REGISTRY } from '../../processors/application/processor-registry.js';
import { findPaymentAttemptForProviderObject } from '../infrastructure/payment-attempt-queries.js';
import { findPaymentIntentByIdForMerchant } from '../infrastructure/payment-intent-queries.js';
import {
  ApplyAttemptResolutionService,
  type AuditActor,
  type PresentPaymentConfirmation,
} from './apply-attempt-resolution.service.js';
import { resolutionOf } from './payment-attempt.js';

/** Audit action of an attempt resolved because the provider reported it. */
export const PAYMENT_ATTEMPT_RESOLVED_BY_PROVIDER_EVENT =
  'PAYMENT_ATTEMPT_RESOLVED_BY_PROVIDER_EVENT';

export interface ResolvePaymentAttemptCommand {
  readonly actor: AuditActor;
  readonly correlationId: string;
  readonly merchantId: string;
  readonly processorAccountId: string;
  /** The provider payment the event is about, such as a `pi_` ID. */
  readonly providerTransactionId: string;
  /** The platform attempt ID the provider object carries, if any. */
  readonly paymentAttemptId: string | null;
  /** Bounds the provider lookup, with no retry. */
  readonly lookupTimeoutMs?: number;
  /** Builds the answer stored under the confirmation's key. */
  readonly present: PresentPaymentConfirmation;
}

export type ResolvePaymentAttemptResult =
  /**
   * A conclusive result was applied: the attempt succeeded, was authorized
   * (a `MANUAL` intent now `REQUIRES_CAPTURE`), or failed.
   */
  | {
      readonly outcome: 'RESOLVED';
      readonly detail:
        'ATTEMPT_SUCCEEDED' | 'ATTEMPT_AUTHORIZED' | 'ATTEMPT_UNSUCCESSFUL';
    }
  /**
   * The attempt is not waiting for an outcome, another writer applied one
   * first, or the provider still reports no conclusive outcome.
   */
  | { readonly outcome: 'NO_CHANGE' }
  /** No attempt of the account matches the provider payment. */
  | { readonly outcome: 'NOT_MATCHED' }
  /** The attempt's own confirmation is still executing; try again later. */
  | { readonly outcome: 'EXECUTING' }
  /** The provider gave no usable answer. Nothing changed. */
  | { readonly outcome: 'LOOKUP_UNAVAILABLE' }
  | { readonly outcome: 'CREDENTIALS_KEY_NOT_CONFIGURED' }
  | { readonly outcome: 'PROVIDER_UNSUPPORTED' };

/**
 * Resolves a payment attempt that waits for an outcome (`REQUIRES_ACTION` or
 * `UNKNOWN`) from the provider's current state, as `complete-action` does:
 * the payment is read from the provider with no transaction open, and a
 * conclusive result is applied through `ApplyAttemptResolutionService` with the
 * attempt's status as read, so a late or repeated trigger finds no row and
 * changes nothing. The attempt is matched by the provider transaction ID or,
 * when it never learned one (an unknown outcome after a timeout), by the
 * platform attempt ID in the provider object's metadata, within the account's
 * merchant and the account itself. A conclusive result completes the
 * confirmation's idempotency record with the answer the confirmation would
 * have stored. A payment that still requires action or is still unknown
 * changes nothing: an unknown attempt cannot move to `REQUIRES_ACTION`.
 */
@Injectable()
export class ResolvePaymentAttemptService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PROCESSOR_REGISTRY)
    private readonly registry: ProcessorAdapterRegistry,
    private readonly accounts: ProcessorAccountsForPaymentsService,
    private readonly applyResolution: ApplyAttemptResolutionService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ResolvePaymentAttemptService.name);
  }

  async execute(
    command: ResolvePaymentAttemptCommand,
  ): Promise<ResolvePaymentAttemptResult> {
    const { merchantId } = command;
    const attempt = await findPaymentAttemptForProviderObject(this.database, {
      merchantId,
      processorAccountId: command.processorAccountId,
      providerTransactionId: command.providerTransactionId,
      paymentAttemptId: command.paymentAttemptId,
    });
    if (attempt === undefined) return { outcome: 'NOT_MATCHED' };
    if (attempt.status === 'EXECUTING') return { outcome: 'EXECUTING' };
    if (attempt.status !== 'REQUIRES_ACTION' && attempt.status !== 'UNKNOWN') {
      return { outcome: 'NO_CHANGE' };
    }
    const intent = await findPaymentIntentByIdForMerchant(
      this.database,
      merchantId,
      attempt.paymentIntentId,
    );
    if (intent === undefined) {
      throw new Error(`payment intent ${attempt.paymentIntentId} disappeared`);
    }

    const resolved = await this.accounts.forExistingPayment(this.database, {
      merchantId,
      processorAccountId: attempt.processorAccountId,
    });
    if (!resolved.ok) {
      if (resolved.code === 'CREDENTIALS_KEY_NOT_CONFIGURED') {
        return { outcome: 'CREDENTIALS_KEY_NOT_CONFIGURED' };
      }
      throw new Error(
        `processor account ${attempt.processorAccountId} of attempt ${attempt.id} is ${resolved.code}`,
      );
    }
    const adapter = this.registry.findWithCapability(
      resolved.account.provider,
      'TRANSACTION_LOOKUP',
    );
    if (adapter === undefined) return { outcome: 'PROVIDER_UNSUPPORTED' };

    const lookup = await adapter.getTransaction({
      credentials: resolved.account.credentials,
      // An attempt that learned its transaction is read by it; one that did
      // not is read by the transaction the provider object names.
      providerTransactionId:
        attempt.providerTransactionId ?? command.providerTransactionId,
      ...(command.lookupTimeoutMs === undefined
        ? {}
        : { timeoutMs: command.lookupTimeoutMs }),
    });
    if (lookup.outcome === 'unavailable') {
      this.logger.warn(
        {
          paymentAttemptId: attempt.id,
          category: lookup.category,
          correlationId: command.correlationId,
        },
        'payment lookup unavailable; nothing changed',
      );
      return { outcome: 'LOOKUP_UNAVAILABLE' };
    }
    const resolution = resolutionOf(lookup.result, intent.captureMode);
    if (
      resolution.kind === 'REQUIRES_ACTION' ||
      resolution.kind === 'UNKNOWN'
    ) {
      return { outcome: 'NO_CHANGE' };
    }

    const applied = await this.database
      .transaction()
      .setIsolationLevel('read committed')
      .execute((trx) =>
        this.applyResolution.execute(trx, {
          actor: command.actor,
          correlationId: command.correlationId,
          intent,
          attempt,
          resolution,
          auditAction: PAYMENT_ATTEMPT_RESOLVED_BY_PROVIDER_EVENT,
          present: command.present,
        }),
      );
    if (applied.outcome === 'NOT_CURRENT') return { outcome: 'NO_CHANGE' };
    this.logger.info(
      {
        paymentIntentId: intent.id,
        paymentAttemptId: attempt.id,
        previousAttemptStatus: attempt.status,
        attemptStatus: applied.view.attempt.status,
        intentStatus: applied.view.intent.status,
        storedUnderKey: applied.stored,
        correlationId: command.correlationId,
      },
      'payment attempt resolved from a provider event',
    );
    return {
      outcome: 'RESOLVED',
      detail:
        resolution.kind === 'SUCCEEDED'
          ? 'ATTEMPT_SUCCEEDED'
          : resolution.kind === 'AUTHORIZED'
            ? 'ATTEMPT_AUTHORIZED'
            : 'ATTEMPT_UNSUCCESSFUL',
    };
  }
}
