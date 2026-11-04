import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { findAuthorizationAction } from '../infrastructure/authorization-action-queries.js';
import { findPaymentAttemptById } from '../infrastructure/payment-attempt-queries.js';
import { findPaymentIntentByIdForMerchant } from '../infrastructure/payment-intent-queries.js';
import type {
  AuthorizationActionView,
  PresentAuthorizationAction,
} from './apply-authorization-action.service.js';
import type { AuthorizationAction } from './authorization-action.js';
import {
  ResolveAuthorizationActionService,
  type AuthorizationActionChange,
} from './resolve-authorization-action.service.js';

export interface RefreshAuthorizationActionCommand {
  readonly principal: Principal;
  readonly correlationId: string;
  readonly paymentIntentId: string;
  readonly actionId: string;
  readonly present: PresentAuthorizationAction;
}

export type RefreshAuthorizationActionFailureCode =
  /** Not a `MERCHANT_ADMIN` of the intent's merchant. Nothing changed. */
  | 'FORBIDDEN'
  /** No such intent of the merchant, or no such action of the intent. */
  | 'NOT_FOUND'
  /** The action's own request is still executing. */
  | 'NOT_REFRESHABLE'
  /** The provider gave no usable answer. Nothing changed. */
  | 'LOOKUP_UNAVAILABLE'
  | 'CREDENTIALS_KEY_NOT_CONFIGURED'
  | 'PROVIDER_UNSUPPORTED'
  | 'LOCK_TIMEOUT';

export type RefreshAuthorizationActionResult =
  | {
      readonly ok: true;
      readonly view: AuthorizationActionView;
      /** What changed, or `null` when nothing did. */
      readonly change: AuthorizationActionChange | null;
    }
  | {
      readonly ok: false;
      readonly code: RefreshAuthorizationActionFailureCode;
    };

/**
 * Checks one capture or void with the provider and applies what the
 * provider's state proves, through the same resolution as the webhook, without
 * any webhook. Only `MERCHANT_ADMIN` may call it; another merchant's intent,
 * and an action of another intent, are "not found" before the role or the
 * provider is involved. It is safe to repeat: an action whose outcome is
 * known, or that the provider's state does not settle, changes nothing. The
 * merchant's status is not checked: recording an outcome moves no new money.
 */
@Injectable()
export class RefreshAuthorizationActionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly resolve: ResolveAuthorizationActionService,
  ) {}

  async execute(
    command: RefreshAuthorizationActionCommand,
  ): Promise<RefreshAuthorizationActionResult> {
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
    const action = await findAuthorizationAction(this.database, {
      merchantId,
      paymentIntentId: intent.id,
      id: command.actionId,
    });
    if (action === undefined) return { ok: false, code: 'NOT_FOUND' };

    const result = await this.resolve.execute({
      actor: auditActorOf(principal),
      correlationId: command.correlationId,
      merchantId,
      action,
      present: command.present,
    });
    switch (result.outcome) {
      case 'RESOLVED':
        return { ok: true, view: result.view, change: result.change };
      case 'NO_CHANGE':
        return { ok: true, view: await this.currentView(action), change: null };
      case 'EXECUTING':
      case 'NOT_MATCHED':
        return { ok: false, code: 'NOT_REFRESHABLE' };
      case 'LOOKUP_UNAVAILABLE':
      case 'CREDENTIALS_KEY_NOT_CONFIGURED':
      case 'PROVIDER_UNSUPPORTED':
      case 'LOCK_TIMEOUT':
        return { ok: false, code: result.outcome };
    }
  }

  /** The action, its intent, and its attempt as they are stored now. */
  private async currentView(
    read: AuthorizationAction,
  ): Promise<AuthorizationActionView> {
    const [action, intent, attempt] = await Promise.all([
      findAuthorizationAction(this.database, {
        merchantId: read.merchantId,
        paymentIntentId: read.paymentIntentId,
        id: read.id,
      }),
      findPaymentIntentByIdForMerchant(
        this.database,
        read.merchantId,
        read.paymentIntentId,
      ),
      findPaymentAttemptById(this.database, {
        merchantId: read.merchantId,
        id: read.paymentAttemptId,
      }),
    ]);
    if (action === undefined || intent === undefined || attempt === undefined) {
      throw new Error(`authorization action ${read.id} disappeared`);
    }
    return { action, intent, attempt };
  }
}
