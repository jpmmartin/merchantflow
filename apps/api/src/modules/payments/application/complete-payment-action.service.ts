import type { Database } from '@merchantflow/database';
import type { ProcessorAdapterRegistry } from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import type { IdempotentResponse } from '../../idempotency/application/idempotency-record.js';
import { ProcessorAccountsForPaymentsService } from '../../merchants/application/processor-accounts-for-payments.service.js';
import { PROCESSOR_REGISTRY } from '../../processors/application/processor-registry.js';
import { findOpenPaymentAttempt } from '../infrastructure/payment-attempt-queries.js';
import { findPaymentIntentByIdForMerchant } from '../infrastructure/payment-intent-queries.js';
import {
  ApplyAttemptResolutionService,
  type PresentPaymentConfirmation,
} from './apply-attempt-resolution.service.js';
import { resolutionOf } from './payment-attempt.js';

/** Audit action of a completion that applied the provider's result. */
export const PAYMENT_INTENT_ACTION_COMPLETED =
  'PAYMENT_INTENT_ACTION_COMPLETED';

export interface CompletePaymentActionCommand {
  readonly principal: Principal;
  readonly correlationId: string;
  readonly paymentIntentId: string;
  readonly present: PresentPaymentConfirmation;
}

export type CompletePaymentActionFailureCode =
  /** Not a `MERCHANT_ADMIN` of the intent's merchant. Nothing changed. */
  | 'FORBIDDEN'
  /** No intent with this id belongs to the merchant. */
  | 'NOT_FOUND'
  /** The intent is not waiting for customer action. Nothing changed. */
  | 'ACTION_NOT_PENDING'
  /** No master key decrypts the account's secret. Nothing changed. */
  | 'CREDENTIALS_KEY_NOT_CONFIGURED'
  /** The account's provider has no adapter that can look a payment up. */
  | 'PROVIDER_UNSUPPORTED'
  /** The provider gave no usable answer. Nothing changed; retry later. */
  | 'LOOKUP_UNAVAILABLE';

export type CompletePaymentActionResult =
  | { readonly ok: true; readonly response: IdempotentResponse }
  | { readonly ok: false; readonly code: CompletePaymentActionFailureCode };

/**
 * Completes a payment that waits for customer action, such as 3D Secure,
 * after the browser ran the step: it asks the provider for the payment's
 * current state, outside any transaction, and applies it to the attempt and
 * the intent with the conditional updates of `ApplyAttemptResolutionService`
 * (expected status `REQUIRES_ACTION`).
 *
 * It is safe to call more than once. A payment that still requires action
 * changes nothing and answers with the client secret again, so a browser that
 * lost the confirmation's answer can run the step. Once a result is applied,
 * the intent is no longer `REQUIRES_ACTION` and a further call is
 * `ACTION_NOT_PENDING`; of two concurrent calls, the conditional update lets
 * only one apply. A failed lookup changes nothing either.
 *
 * Only `MERCHANT_ADMIN` may call it. The merchant's status is not checked: the
 * customer's step already happened at the provider, and recording its outcome
 * moves no new money. The lookup uses the attempt's own account, whether or
 * not it is still enabled or the default.
 */
@Injectable()
export class CompletePaymentActionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PROCESSOR_REGISTRY)
    private readonly registry: ProcessorAdapterRegistry,
    private readonly accounts: ProcessorAccountsForPaymentsService,
    private readonly applyResolution: ApplyAttemptResolutionService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(CompletePaymentActionService.name);
  }

  async execute(
    command: CompletePaymentActionCommand,
  ): Promise<CompletePaymentActionResult> {
    const { principal } = command;
    if (principal.kind !== 'MERCHANT') return { ok: false, code: 'FORBIDDEN' };
    const merchantId = principal.merchantId;

    const intent = await findPaymentIntentByIdForMerchant(
      this.database,
      merchantId,
      command.paymentIntentId,
    );
    if (intent === undefined) return { ok: false, code: 'NOT_FOUND' };
    if (principal.role !== 'MERCHANT_ADMIN') {
      return { ok: false, code: 'FORBIDDEN' };
    }
    if (intent.status !== 'REQUIRES_ACTION') {
      return { ok: false, code: 'ACTION_NOT_PENDING' };
    }
    const attempt = await findOpenPaymentAttempt(this.database, {
      merchantId,
      paymentIntentId: intent.id,
    });
    if (attempt?.status !== 'REQUIRES_ACTION') {
      // Another call resolved it after the intent was read.
      return { ok: false, code: 'ACTION_NOT_PENDING' };
    }
    const providerTransactionId = attempt.providerTransactionId;
    if (providerTransactionId === null) {
      throw new Error(
        `payment attempt ${attempt.id} requires action without a provider transaction`,
      );
    }

    const resolved = await this.accounts.forExistingPayment(this.database, {
      merchantId,
      processorAccountId: attempt.processorAccountId,
    });
    if (!resolved.ok) {
      if (resolved.code === 'CREDENTIALS_KEY_NOT_CONFIGURED') {
        return { ok: false, code: 'CREDENTIALS_KEY_NOT_CONFIGURED' };
      }
      // The composite foreign key keeps the attempt's account in place.
      throw new Error(
        `processor account ${attempt.processorAccountId} of attempt ${attempt.id} is ${resolved.code}`,
      );
    }
    const { account } = resolved;
    const adapter = this.registry.findWithCapability(
      account.provider,
      'TRANSACTION_LOOKUP',
    );
    if (adapter === undefined) {
      return { ok: false, code: 'PROVIDER_UNSUPPORTED' };
    }

    const lookup = await adapter.getTransaction({
      credentials: account.credentials,
      providerTransactionId,
    });
    if (lookup.outcome === 'unavailable') {
      this.logger.warn(
        {
          paymentIntentId: intent.id,
          paymentAttemptId: attempt.id,
          category: lookup.category,
          correlationId: command.correlationId,
        },
        'processor lookup unavailable; nothing changed',
      );
      return { ok: false, code: 'LOOKUP_UNAVAILABLE' };
    }

    const resolution = resolutionOf(lookup.result, intent.captureMode);
    if (resolution.kind === 'REQUIRES_ACTION') {
      // Still waiting for the customer: nothing changes, and the browser gets
      // the client secret again to run the step.
      return {
        ok: true,
        response: command.present({
          intent,
          attempt,
          nextAction: { clientSecret: resolution.clientSecret },
        }),
      };
    }

    const applied = await this.database
      .transaction()
      .setIsolationLevel('read committed')
      .execute((trx) =>
        this.applyResolution.execute(trx, {
          actor: auditActorOf(principal),
          correlationId: command.correlationId,
          intent,
          attempt,
          resolution,
          auditAction: PAYMENT_INTENT_ACTION_COMPLETED,
          present: command.present,
        }),
      );
    if (applied.outcome === 'NOT_CURRENT') {
      return { ok: false, code: 'ACTION_NOT_PENDING' };
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
      'payment action completion applied',
    );
    return { ok: true, response: applied.response };
  }
}
