import { Injectable } from '@nestjs/common';
import type { ApiKey } from '../../auth/application/api-key.js';
import type { MerchantApiKeyRole } from '../../auth/application/api-key-scope.js';
import { IssueApiKeyService } from '../../auth/application/issue-api-key.service.js';
import type { Principal } from '../../auth/application/principal.js';
import { auditActorOf, canAddressMerchant } from './merchant-access.js';

export interface IssueMerchantApiKeyCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly role: MerchantApiKeyRole;
  readonly correlationId: string;
}

export type IssueMerchantApiKeyResult =
  | {
      readonly ok: true;
      readonly apiKey: ApiKey;
      /** The full key, returned once and stored nowhere. */
      readonly key: string;
    }
  | { readonly ok: false; readonly code: 'MERCHANT_NOT_FOUND' | 'FORBIDDEN' };

/**
 * Issues an API key for a merchant. Only a platform key may do it. The merchant
 * must be addressable by the caller first (otherwise "not found", whatever the
 * role). The key and its audit event are written by `IssueApiKeyService` in one
 * transaction, with the requesting key as the actor.
 */
@Injectable()
export class IssueMerchantApiKeyService {
  constructor(private readonly issueApiKey: IssueApiKeyService) {}

  async execute(
    command: IssueMerchantApiKeyCommand,
  ): Promise<IssueMerchantApiKeyResult> {
    const { principal } = command;
    if (!canAddressMerchant(principal, command.merchantId)) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    if (principal.kind !== 'PLATFORM') {
      return { ok: false, code: 'FORBIDDEN' };
    }

    const result = await this.issueApiKey.execute({
      actor: auditActorOf(principal),
      scope: {
        kind: 'MERCHANT',
        merchantId: command.merchantId,
        role: command.role,
      },
      correlationId: command.correlationId,
    });
    return result.ok
      ? { ok: true, apiKey: result.apiKey, key: result.key }
      : { ok: false, code: 'MERCHANT_NOT_FOUND' };
  }
}
