import type { Database } from '@merchantflow/database';
import type { PaymentIntent } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { listAuthorizationActions } from '../infrastructure/authorization-action-queries.js';
import { listPaymentAttempts } from '../infrastructure/payment-attempt-queries.js';
import { findPaymentIntentByIdForMerchant } from '../infrastructure/payment-intent-queries.js';
import { listRefunds } from '../infrastructure/refund-queries.js';
import type { AuthorizationAction } from './authorization-action.js';
import type { PaymentAttempt } from './payment-attempt.js';
import type { Refund } from './refund.js';

/** A payment intent with every attempt, capture or void, and refund of it. */
export interface PaymentHistory {
  readonly intent: PaymentIntent;
  /** Oldest first. */
  readonly attempts: readonly PaymentAttempt[];
  /** Captures and voids, oldest first. */
  readonly holdActions: readonly AuthorizationAction[];
  /** Oldest first. */
  readonly refunds: readonly Refund[];
}

export type GetPaymentHistoryResult =
  | { readonly ok: true; readonly history: PaymentHistory }
  /** The principal is not a merchant principal. Nothing was read. */
  | { readonly ok: false; readonly code: 'FORBIDDEN' }
  /** No intent with this id belongs to the merchant of the principal. */
  | { readonly ok: false; readonly code: 'NOT_FOUND' };

/**
 * Reads one payment intent of the principal's merchant with its attempts,
 * captures and voids, and refunds, for other modules (the payment timeline,
 * P-09). The access rule is that of `GetPaymentIntentService`: merchant roles
 * only, the merchant from the principal, and another merchant's intent
 * `NOT_FOUND` exactly as a missing one. Every row is read through the
 * merchant filter. The rows are read outside a transaction, so a change that
 * commits between the reads may be seen only in part.
 */
@Injectable()
export class GetPaymentHistoryService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(command: {
    readonly principal: Principal;
    readonly paymentIntentId: string;
  }): Promise<GetPaymentHistoryResult> {
    const { principal } = command;
    switch (principal.kind) {
      case 'PLATFORM':
        return { ok: false, code: 'FORBIDDEN' };
      case 'MERCHANT':
        break;
      default: {
        const unreachable: never = principal;
        return unreachable;
      }
    }
    const key = {
      merchantId: principal.merchantId,
      paymentIntentId: command.paymentIntentId,
    };
    const intent = await findPaymentIntentByIdForMerchant(
      this.database,
      key.merchantId,
      key.paymentIntentId,
    );
    if (intent === undefined) return { ok: false, code: 'NOT_FOUND' };
    const [attempts, holdActions, refunds] = await Promise.all([
      listPaymentAttempts(this.database, key),
      listAuthorizationActions(this.database, key),
      listRefunds(this.database, key),
    ]);
    return { ok: true, history: { intent, attempts, holdActions, refunds } };
  }
}
