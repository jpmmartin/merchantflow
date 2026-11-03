import { Injectable } from '@nestjs/common';
import { CreateUserService } from '../../auth/application/create-user.service.js';
import { generatePassword } from '../../auth/application/password-hash.js';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import type { UserSummary } from '../../auth/application/user.js';
import {
  canAddressMerchant,
  canManageMerchantAccess,
} from './merchant-access.js';

export interface CreateMerchantUserCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly email: string;
  readonly displayName: string;
  readonly correlationId: string;
}

export type CreateMerchantUserResult =
  | {
      readonly ok: true;
      readonly user: UserSummary;
      /** The generated initial password, returned once and stored nowhere. */
      readonly initialPassword: string;
    }
  | {
      readonly ok: false;
      readonly code: 'MERCHANT_NOT_FOUND' | 'FORBIDDEN' | 'EMAIL_TAKEN';
    };

/**
 * Creates a user of a merchant with the role `MERCHANT_ADMIN`, the only role a
 * merchant user gets for now. The platform administrator may do it for any
 * merchant, and `MERCHANT_ADMIN` for its own. The server generates the initial
 * password, which only this result carries; the user and its `USER_CREATED`
 * event are written by `CreateUserService` in one transaction, with the
 * requester as the actor. A merchant that does not exist is reported by the
 * users foreign key, so the merchants table is not read first.
 */
@Injectable()
export class CreateMerchantUserService {
  constructor(private readonly createUser: CreateUserService) {}

  async execute(
    command: CreateMerchantUserCommand,
  ): Promise<CreateMerchantUserResult> {
    const { principal } = command;
    if (!canAddressMerchant(principal, command.merchantId)) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    if (!canManageMerchantAccess(principal)) {
      return { ok: false, code: 'FORBIDDEN' };
    }

    const initialPassword = generatePassword();
    const result = await this.createUser.execute({
      actor: auditActorOf(principal),
      email: command.email,
      displayName: command.displayName,
      scope: {
        kind: 'MERCHANT',
        merchantId: command.merchantId,
        role: 'MERCHANT_ADMIN',
      },
      password: initialPassword,
      correlationId: command.correlationId,
    });
    if (result.ok) return { ok: true, user: result.user, initialPassword };
    switch (result.code) {
      case 'EMAIL_TAKEN':
      case 'MERCHANT_NOT_FOUND':
        return { ok: false, code: result.code };
      case 'INVALID_EMAIL':
      case 'INVALID_DISPLAY_NAME':
      case 'INVALID_PASSWORD':
        // The request schema and the password generator rule these out.
        throw new Error(`a validated user was refused: ${result.code}`);
    }
  }
}
