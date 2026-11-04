import {
  isLockNotAvailable,
  setLocalLockTimeout,
  type Database,
} from '@merchantflow/database';
import type { ProcessorAdapterRegistry } from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DATABASE } from '../../database/database.module.js';
import { ProcessorAccountsForPaymentsService } from '../../merchants/application/processor-accounts-for-payments.service.js';
import { PROCESSOR_REGISTRY } from '../../processors/application/processor-registry.js';
import { findBlockingAuthorizationAction } from '../infrastructure/authorization-action-queries.js';
import {
  findPaymentAttemptById,
  findPaymentAttemptForProviderObject,
} from '../infrastructure/payment-attempt-queries.js';
import type { AuditActor } from './apply-attempt-resolution.service.js';
import {
  ApplyAuthorizationActionService,
  type AuthorizationActionView,
  type PresentAuthorizationAction,
} from './apply-authorization-action.service.js';
import {
  authorizationActionResolutionFromLookup,
  type AuthorizationAction,
} from './authorization-action.js';
import { PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS } from './create-payment-intent.service.js';

/** Audit action of a capture or void resolved from the provider's state. */
export const PAYMENT_AUTHORIZATION_ACTION_RESOLVED =
  'PAYMENT_AUTHORIZATION_ACTION_RESOLVED';

/** What a resolution changed, as the inbox and the check report it. */
export type AuthorizationActionChange =
  'CAPTURE_SUCCEEDED' | 'CAPTURE_FAILED' | 'VOID_SUCCEEDED' | 'VOID_FAILED';

interface ResolutionCommon {
  readonly actor: AuditActor;
  readonly correlationId: string;
  readonly merchantId: string;
  /** Bounds the provider lookup, with no retry. */
  readonly lookupTimeoutMs?: number;
  /** Builds the answer stored under the request's key. */
  readonly present: PresentAuthorizationAction;
}

export interface ResolveAuthorizationActionCommand extends ResolutionCommon {
  /** The action as the caller read it. */
  readonly action: AuthorizationAction;
}

export interface ResolveAuthorizationActionForProviderCommand extends ResolutionCommon {
  readonly processorAccountId: string;
  /** The provider payment the event is about, such as a `pi_` ID. */
  readonly providerTransactionId: string;
}

export type ResolveAuthorizationActionResult =
  /** The provider's state proved the outcome, and it was applied. */
  | {
      readonly outcome: 'RESOLVED';
      readonly change: AuthorizationActionChange;
      readonly view: AuthorizationActionView;
    }
  /**
   * The action already has a final status, another writer applied one first,
   * or the provider's state proves nothing yet.
   */
  | { readonly outcome: 'NO_CHANGE' }
  /** No action of the account's payment waits for an outcome. */
  | { readonly outcome: 'NOT_MATCHED' }
  /** The action's own request is still executing; try again later. */
  | { readonly outcome: 'EXECUTING' }
  /** The provider gave no usable answer. Nothing changed. */
  | { readonly outcome: 'LOOKUP_UNAVAILABLE' }
  | { readonly outcome: 'CREDENTIALS_KEY_NOT_CONFIGURED' }
  | { readonly outcome: 'PROVIDER_UNSUPPORTED' }
  /** Another change of the intent held its lock too long. Nothing changed. */
  | { readonly outcome: 'LOCK_TIMEOUT' };

/**
 * Resolves a capture or void whose outcome is `UNKNOWN` from the provider's
 * current state of the payment, read with no transaction open. What the state
 * proves is decided by `authorizationActionResolutionFromLookup`: the state
 * the action leads to makes it `SUCCEEDED` (the intent becomes `SUCCEEDED`,
 * with its sale posted, or `CANCELED`), a payment that still holds its funds
 * or that reached the other final state makes it `FAILED`, and anything else
 * changes nothing. It is applied through `ApplyAuthorizationActionService`
 * with `UNKNOWN` as the expected status, so a late or repeated trigger finds
 * no row and changes nothing, and it completes the request's idempotency
 * record with the answer the request would have stored.
 *
 * `execute` resolves one action (the action check); `executeForProvider`
 * finds the action of the account's provider payment that waits for an
 * outcome (a webhook). A capture or void made outside the platform has no
 * action, so its events change nothing here.
 */
@Injectable()
export class ResolveAuthorizationActionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(PROCESSOR_REGISTRY)
    private readonly registry: ProcessorAdapterRegistry,
    private readonly accounts: ProcessorAccountsForPaymentsService,
    private readonly applyAction: ApplyAuthorizationActionService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ResolveAuthorizationActionService.name);
  }

  async executeForProvider(
    command: ResolveAuthorizationActionForProviderCommand,
  ): Promise<ResolveAuthorizationActionResult> {
    const attempt = await findPaymentAttemptForProviderObject(this.database, {
      merchantId: command.merchantId,
      processorAccountId: command.processorAccountId,
      providerTransactionId: command.providerTransactionId,
      paymentAttemptId: null,
    });
    if (attempt === undefined) return { outcome: 'NOT_MATCHED' };
    const action = await findBlockingAuthorizationAction(this.database, {
      merchantId: command.merchantId,
      paymentIntentId: attempt.paymentIntentId,
    });
    if (action === undefined || action.paymentAttemptId !== attempt.id) {
      return { outcome: 'NOT_MATCHED' };
    }
    return this.execute({ ...command, action });
  }

  async execute(
    command: ResolveAuthorizationActionCommand,
  ): Promise<ResolveAuthorizationActionResult> {
    const { action, merchantId } = command;
    if (action.status === 'EXECUTING') return { outcome: 'EXECUTING' };
    if (action.status !== 'UNKNOWN') return { outcome: 'NO_CHANGE' };

    const attempt = await findPaymentAttemptById(this.database, {
      merchantId,
      id: action.paymentAttemptId,
    });
    if (attempt === undefined || attempt.providerTransactionId === null) {
      throw new Error(
        `authorization action ${action.id} has no attempt with a provider transaction`,
      );
    }
    const resolved = await this.accounts.forExistingPayment(this.database, {
      merchantId,
      processorAccountId: action.processorAccountId,
    });
    if (!resolved.ok) {
      if (resolved.code === 'CREDENTIALS_KEY_NOT_CONFIGURED') {
        return { outcome: 'CREDENTIALS_KEY_NOT_CONFIGURED' };
      }
      throw new Error(
        `processor account ${action.processorAccountId} of action ${action.id} is ${resolved.code}`,
      );
    }
    const adapter = this.registry.findWithCapability(
      resolved.account.provider,
      'TRANSACTION_LOOKUP',
    );
    if (adapter === undefined) return { outcome: 'PROVIDER_UNSUPPORTED' };

    const lookup = await adapter.getTransaction({
      credentials: resolved.account.credentials,
      providerTransactionId: attempt.providerTransactionId,
      ...(command.lookupTimeoutMs === undefined
        ? {}
        : { timeoutMs: command.lookupTimeoutMs }),
    });
    if (lookup.outcome === 'unavailable') {
      this.logger.warn(
        {
          authorizationActionId: action.id,
          category: lookup.category,
          correlationId: command.correlationId,
        },
        'payment lookup unavailable; nothing changed',
      );
      return { outcome: 'LOOKUP_UNAVAILABLE' };
    }
    const resolution = authorizationActionResolutionFromLookup(
      action.action,
      lookup.result,
    );
    if (resolution === undefined) return { outcome: 'NO_CHANGE' };

    let applied;
    try {
      applied = await this.database
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          await setLocalLockTimeout(trx, PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS);
          return this.applyAction.execute(trx, {
            actor: command.actor,
            correlationId: command.correlationId,
            action,
            attempt,
            resolution,
            auditAction: PAYMENT_AUTHORIZATION_ACTION_RESOLVED,
            present: command.present,
          });
        });
    } catch (error) {
      if (isLockNotAvailable(error)) return { outcome: 'LOCK_TIMEOUT' };
      throw error;
    }
    if (applied.outcome === 'NOT_CURRENT') return { outcome: 'NO_CHANGE' };
    const change: AuthorizationActionChange =
      action.action === 'CAPTURE'
        ? resolution.status === 'SUCCEEDED'
          ? 'CAPTURE_SUCCEEDED'
          : 'CAPTURE_FAILED'
        : resolution.status === 'SUCCEEDED'
          ? 'VOID_SUCCEEDED'
          : 'VOID_FAILED';
    this.logger.info(
      {
        paymentIntentId: action.paymentIntentId,
        authorizationActionId: action.id,
        change,
        intentStatus: applied.view.intent.status,
        storedUnderKey: applied.stored,
        correlationId: command.correlationId,
      },
      'capture or void resolved from the provider',
    );
    return { outcome: 'RESOLVED', change, view: applied.view };
  }
}
