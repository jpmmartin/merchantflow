import type { Database } from '@merchantflow/database';
import type { PaymentIntent } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { findPaymentIntentByIdForMerchant } from '../infrastructure/payment-intent-queries.js';
import { listRefunds } from '../infrastructure/refund-queries.js';
import { refundSummaryOf, type Refund, type RefundSummary } from './refund.js';

export interface ListRefundsCommand {
  readonly principal: Principal;
  readonly paymentIntentId: string;
}

export type ListRefundsResult =
  | {
      readonly ok: true;
      readonly intent: PaymentIntent;
      readonly refunds: readonly Refund[];
      readonly summary: RefundSummary;
    }
  /** A platform principal; nothing was read. */
  | { readonly ok: false; readonly code: 'FORBIDDEN' }
  /** No intent with this id belongs to the merchant. */
  | { readonly ok: false; readonly code: 'NOT_FOUND' };

/**
 * Lists the refunds of one payment intent of the merchant of the principal,
 * oldest first, with the intent's captured, refunded, in-flight, and
 * refundable amounts. `MERCHANT_ADMIN` and `MERCHANT_READ_ONLY` may read; a
 * platform principal may not, as for the intent itself (AD-65). The intent is
 * read first through the merchant filter, so another merchant's intent is
 * `NOT_FOUND`, exactly as a missing one, and the refunds query filters by the
 * merchant as well.
 */
@Injectable()
export class ListRefundsService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(command: ListRefundsCommand): Promise<ListRefundsResult> {
    const { principal } = command;
    if (principal.kind !== 'MERCHANT') return { ok: false, code: 'FORBIDDEN' };
    const intent = await findPaymentIntentByIdForMerchant(
      this.database,
      principal.merchantId,
      command.paymentIntentId,
    );
    if (intent === undefined) return { ok: false, code: 'NOT_FOUND' };
    const refunds = await listRefunds(this.database, {
      merchantId: principal.merchantId,
      paymentIntentId: intent.id,
    });
    return {
      ok: true,
      intent,
      refunds,
      summary: refundSummaryOf(intent, refunds),
    };
  }
}
