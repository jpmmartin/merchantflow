import { Injectable } from '@nestjs/common';
import { FindApiKeyService } from '../../auth/application/find-api-key.service.js';
import type { MerchantApiKeyRole } from '../../auth/application/api-key-scope.js';
import { RevokeApiKeyService } from '../../auth/application/revoke-api-key.service.js';
import type { Principal } from '../../auth/application/principal.js';
import { auditActorOf, canAddressMerchant } from './merchant-access.js';

export interface RevokeMerchantApiKeyCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly apiKeyId: string;
  readonly correlationId: string;
}

/** A merchant's key as the revocation reports it. It has no secret or hash. */
export interface RevokedMerchantApiKey {
  readonly id: string;
  readonly merchantId: string;
  readonly role: MerchantApiKeyRole;
  readonly createdAt: Date;
  readonly revokedAt: Date;
}

export type RevokeMerchantApiKeyResult =
  | {
      readonly ok: true;
      readonly apiKey: RevokedMerchantApiKey;
      /** `ALREADY_REVOKED` means nothing changed and nothing was audited. */
      readonly outcome: 'REVOKED' | 'ALREADY_REVOKED';
    }
  | { readonly ok: false; readonly code: 'NOT_FOUND' | 'FORBIDDEN' };

/**
 * Revokes a key of a merchant. Only a platform key may do it. The merchant must
 * be addressable by the caller first (otherwise "not found", whatever the
 * role), and the key must belong to that merchant: a key of another merchant,
 * a platform key, and an unknown id are all "not found". The revocation and
 * its audit event are written by `RevokeApiKeyService` in one transaction.
 * Revoking an already revoked key succeeds without a change.
 */
@Injectable()
export class RevokeMerchantApiKeyService {
  constructor(
    private readonly findApiKey: FindApiKeyService,
    private readonly revokeApiKey: RevokeApiKeyService,
  ) {}

  async execute(
    command: RevokeMerchantApiKeyCommand,
  ): Promise<RevokeMerchantApiKeyResult> {
    const { principal } = command;
    if (!canAddressMerchant(principal, command.merchantId)) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (principal.kind !== 'PLATFORM') {
      return { ok: false, code: 'FORBIDDEN' };
    }

    const existing = await this.findApiKey.execute(command.apiKeyId);
    // The merchant of a key never changes, so this check cannot go stale
    // between the read and the revocation below.
    if (
      existing === undefined ||
      existing.scope.kind !== 'MERCHANT' ||
      existing.scope.merchantId !== command.merchantId
    ) {
      return { ok: false, code: 'NOT_FOUND' };
    }

    const result = await this.revokeApiKey.execute({
      actor: auditActorOf(principal),
      apiKeyId: existing.id,
      correlationId: command.correlationId,
    });
    if (!result.ok) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    return {
      ok: true,
      outcome: result.outcome,
      apiKey: {
        id: existing.id,
        merchantId: existing.scope.merchantId,
        role: existing.scope.role,
        createdAt: existing.createdAt,
        revokedAt: result.revokedAt,
      },
    };
  }
}
