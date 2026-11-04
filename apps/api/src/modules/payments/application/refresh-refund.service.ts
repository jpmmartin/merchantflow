import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { findPaymentIntentByIdForMerchant } from '../infrastructure/payment-intent-queries.js';
import { findRefundById } from '../infrastructure/refund-queries.js';
import type {
  PresentRefund,
  RefundView,
} from './refund-payment-intent.service.js';
import {
  ResolveRefundService,
  type RefundResolutionDetail,
} from './resolve-refund.service.js';

export interface RefreshRefundCommand {
  readonly principal: Principal;
  readonly correlationId: string;
  readonly paymentIntentId: string;
  readonly refundId: string;
  readonly present: PresentRefund;
}

export type RefreshRefundFailureCode =
  /** Not a `MERCHANT_ADMIN` of the intent's merchant. Nothing changed. */
  | 'FORBIDDEN'
  /** No such intent of the merchant, or no such refund of the intent. */
  | 'NOT_FOUND'
  /** The refund is still executing or was never identified by the provider. */
  | 'NOT_REFRESHABLE'
  /** The provider gave no usable answer. Nothing changed. */
  | 'LOOKUP_UNAVAILABLE'
  | 'CREDENTIALS_KEY_NOT_CONFIGURED'
  | 'PROVIDER_UNSUPPORTED'
  | 'LOCK_TIMEOUT';

export type RefreshRefundResult =
  | {
      readonly ok: true;
      readonly view: RefundView;
      /** What changed, or `null` when the provider confirmed the status. */
      readonly change: RefundResolutionDetail | null;
    }
  | { readonly ok: false; readonly code: RefreshRefundFailureCode };

/**
 * Checks one refund with the provider and applies what it reports, through
 * the same resolution as the webhook, without any webhook. Only
 * `MERCHANT_ADMIN` may call it; another merchant's intent, and a refund of
 * another intent, are "not found" before the role or the provider is
 * involved. It is safe to repeat: a refund the provider confirms changes
 * nothing.
 */
@Injectable()
export class RefreshRefundService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly resolveRefund: ResolveRefundService,
  ) {}

  async execute(command: RefreshRefundCommand): Promise<RefreshRefundResult> {
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
    const refund = await findRefundById(this.database, {
      merchantId,
      id: command.refundId,
    });
    if (refund?.paymentIntentId !== intent.id) {
      return { ok: false, code: 'NOT_FOUND' };
    }

    const result = await this.resolveRefund.execute({
      actor: auditActorOf(principal),
      correlationId: command.correlationId,
      merchantId,
      refund,
      providerRefundId: null,
      present: command.present,
    });
    switch (result.outcome) {
      case 'RESOLVED':
        return { ok: true, view: result.view, change: result.detail };
      case 'NO_CHANGE':
        return { ok: true, view: result.view, change: null };
      case 'EXECUTING':
      case 'NO_PROVIDER_ID':
        return { ok: false, code: 'NOT_REFRESHABLE' };
      case 'LOOKUP_UNAVAILABLE':
        return { ok: false, code: 'LOOKUP_UNAVAILABLE' };
      case 'CREDENTIALS_KEY_NOT_CONFIGURED':
        return { ok: false, code: 'CREDENTIALS_KEY_NOT_CONFIGURED' };
      case 'PROVIDER_UNSUPPORTED':
        return { ok: false, code: 'PROVIDER_UNSUPPORTED' };
      case 'LOCK_TIMEOUT':
        return { ok: false, code: 'LOCK_TIMEOUT' };
    }
  }
}
