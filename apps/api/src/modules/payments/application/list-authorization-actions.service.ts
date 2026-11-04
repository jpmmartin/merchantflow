import type { Database } from '@merchantflow/database';
import type { PaymentIntent } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { listAuthorizationActions } from '../infrastructure/authorization-action-queries.js';
import { findPaymentIntentByIdForMerchant } from '../infrastructure/payment-intent-queries.js';
import type { AuthorizationAction } from './authorization-action.js';

export interface ListAuthorizationActionsCommand {
  readonly principal: Principal;
  readonly paymentIntentId: string;
}

export type ListAuthorizationActionsResult =
  | {
      readonly ok: true;
      readonly intent: PaymentIntent;
      readonly actions: readonly AuthorizationAction[];
    }
  /** A platform principal; nothing was read. */
  | { readonly ok: false; readonly code: 'FORBIDDEN' }
  /** No intent with this id belongs to the merchant. */
  | { readonly ok: false; readonly code: 'NOT_FOUND' };

/**
 * Lists the captures and voids of one payment intent of the merchant of the
 * principal, oldest first. `MERCHANT_ADMIN` and `MERCHANT_READ_ONLY` may read;
 * a platform principal may not, as for the intent itself (AD-65). The intent
 * is read first through the merchant filter, so another merchant's intent is
 * `NOT_FOUND`, exactly as a missing one.
 */
@Injectable()
export class ListAuthorizationActionsService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(
    command: ListAuthorizationActionsCommand,
  ): Promise<ListAuthorizationActionsResult> {
    const { principal } = command;
    if (principal.kind !== 'MERCHANT') return { ok: false, code: 'FORBIDDEN' };
    const intent = await findPaymentIntentByIdForMerchant(
      this.database,
      principal.merchantId,
      command.paymentIntentId,
    );
    if (intent === undefined) return { ok: false, code: 'NOT_FOUND' };
    const actions = await listAuthorizationActions(this.database, {
      merchantId: principal.merchantId,
      paymentIntentId: intent.id,
    });
    return { ok: true, intent, actions };
  }
}
