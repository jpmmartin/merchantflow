import { Injectable } from '@nestjs/common';
import { DisableUserService } from '../../auth/application/disable-user.service.js';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import type { UserSummary } from '../../auth/application/user.js';
import {
  canAddressMerchant,
  canManageMerchantAccess,
} from './merchant-access.js';

export interface DisableMerchantUserCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly userId: string;
  readonly correlationId: string;
}

export type DisableMerchantUserResult =
  | {
      readonly ok: true;
      readonly user: UserSummary;
      /** `ALREADY_DISABLED` means nothing changed and nothing was audited. */
      readonly outcome: 'DISABLED' | 'ALREADY_DISABLED';
    }
  | {
      readonly ok: false;
      readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'SELF_DISABLE';
    };

/**
 * Disables a user of a merchant and revokes all its sessions. The platform
 * administrator may do it for any merchant, and `MERCHANT_ADMIN` for its own,
 * but a signed-in user cannot disable itself. The merchant must be addressable
 * first (otherwise "not found", whatever the role), and the user must belong
 * to it: a user of another merchant, a platform user, and an unknown id are
 * all "not found".
 */
@Injectable()
export class DisableMerchantUserService {
  constructor(private readonly disableUser: DisableUserService) {}

  async execute(
    command: DisableMerchantUserCommand,
  ): Promise<DisableMerchantUserResult> {
    const { principal } = command;
    if (!canAddressMerchant(principal, command.merchantId)) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (!canManageMerchantAccess(principal)) {
      return { ok: false, code: 'FORBIDDEN' };
    }
    if (principal.source === 'USER' && principal.userId === command.userId) {
      return { ok: false, code: 'SELF_DISABLE' };
    }

    const result = await this.disableUser.execute({
      actor: auditActorOf(principal),
      merchantId: command.merchantId,
      userId: command.userId,
      correlationId: command.correlationId,
    });
    return result.ok
      ? { ok: true, user: result.user, outcome: result.outcome }
      : { ok: false, code: 'NOT_FOUND' };
  }
}
