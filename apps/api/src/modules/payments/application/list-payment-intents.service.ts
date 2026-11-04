import type { Database } from '@merchantflow/database';
import type { PaymentIntent, PaymentIntentStatus } from '@merchantflow/domain';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import type { KeysetPosition } from '../../pagination/keyset-cursor.js';
import { listPaymentIntentsForMerchant } from '../infrastructure/payment-intent-queries.js';

export interface ListPaymentIntentsCommand {
  readonly principal: Principal;
  /** Page size. The caller validates the bounds. */
  readonly limit: number;
  /** Where the previous page ended, to continue after it. */
  readonly after?: KeysetPosition | undefined;
  /** Only intents with this status; every status when absent. */
  readonly status?: PaymentIntentStatus | undefined;
}

export interface PaymentIntentPage {
  readonly intents: readonly PaymentIntent[];
  /** Pass it as `after` to get the next page; `undefined` on the last page. */
  readonly next: KeysetPosition | undefined;
}

export type ListPaymentIntentsResult =
  | { readonly ok: true; readonly page: PaymentIntentPage }
  /**
   * The key is not a merchant key, so no intent is listable through it.
   * Nothing was read.
   */
  | { readonly ok: false; readonly code: 'FORBIDDEN' };

/**
 * Lists the payment intents of the merchant of the key, newest first, one page
 * at a time. `MERCHANT_ADMIN` and `MERCHANT_READ_ONLY` may list; a platform key
 * may not, for the reason of `GetPaymentIntentService`: platform roles have no
 * access to payments yet and the request names no merchant to scope the list.
 *
 * The merchant comes only from the principal and every row is read through a
 * filter on it. The merchant's status is not checked, as for a read (AD-65).
 * The role is checked here as well as at the route, for callers that do not
 * pass through the guard.
 */
@Injectable()
export class ListPaymentIntentsService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async execute(
    command: ListPaymentIntentsCommand,
  ): Promise<ListPaymentIntentsResult> {
    const { principal, limit } = command;
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
    // One extra row tells whether another page exists without a count query.
    const rows = await listPaymentIntentsForMerchant(this.database, {
      merchantId: principal.merchantId,
      limit: limit + 1,
      after: command.after,
      status: command.status,
    });
    const intents = rows.slice(0, limit);
    const last = intents.at(-1);
    return {
      ok: true,
      page: {
        intents,
        next:
          rows.length > limit && last !== undefined
            ? { createdAt: last.createdAt, id: last.id }
            : undefined,
      },
    };
  }
}
