import type { Database } from '@merchantflow/database';
import type { PaymentIntent } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { findPaymentIntentByIdForMerchant } from '../infrastructure/payment-intent-queries.js';

export interface GetPaymentIntentCommand {
  readonly principal: Principal;
  readonly paymentIntentId: string;
}

export type GetPaymentIntentResult =
  | { readonly ok: true; readonly intent: PaymentIntent }
  /**
   * The key is not a merchant key, so no intent is readable through it.
   * Nothing was read.
   */
  | { readonly ok: false; readonly code: 'FORBIDDEN' }
  /** No intent with this id belongs to the merchant of the key. */
  | { readonly ok: false; readonly code: 'NOT_FOUND' };

/**
 * Reads one payment intent of the merchant of the key. `MERCHANT_ADMIN` and
 * `MERCHANT_READ_ONLY` may read; a platform key may not, whether or not the
 * intent exists, because the authorization model grants platform roles no
 * access to payments yet and the path names no merchant to scope the read.
 *
 * The merchant comes only from the principal, and one query filters by it and
 * by the id, so another merchant's intent is `NOT_FOUND` exactly as a missing
 * one is. The merchant's status is not checked: this is a read, no money moves,
 * and a suspended merchant must still see what it created (AD-65). The role is
 * checked here as well as at the route, because other callers (the worker, the
 * MCP server) will not pass through the guard.
 *
 * A stored row that the domain rejects is not a missing intent: the mapping
 * throws, the request answers `500 INTERNAL_ERROR`, and the error is logged.
 */
@Injectable()
export class GetPaymentIntentService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(
    command: GetPaymentIntentCommand,
  ): Promise<GetPaymentIntentResult> {
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
    const intent = await findPaymentIntentByIdForMerchant(
      this.database,
      principal.merchantId,
      command.paymentIntentId,
    );
    if (intent === undefined) return { ok: false, code: 'NOT_FOUND' };
    return { ok: true, intent };
  }
}
