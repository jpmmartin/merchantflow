import { randomUUID } from 'node:crypto';
import {
  isLockNotAvailable,
  setLocalLockTimeout,
  type Database,
  type DatabaseTransaction,
} from '@merchantflow/database';
import type {
  CredentialRejectionReason,
  ProcessorAdapterRegistry,
} from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import { isUniqueViolation } from '../../auth/infrastructure/constraint-violation.js';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { PROCESSOR_REGISTRY } from '../../processors/application/processor-registry.js';
import {
  findMerchantById,
  findMerchantByIdForUpdate,
} from '../infrastructure/merchant-queries.js';
import {
  ENABLED_PROVIDER_ACCOUNT_INDEX,
  hasDefaultProcessorAccount,
  insertProcessorAccount,
} from '../infrastructure/processor-account-queries.js';
import {
  SECRET_CIPHER,
  type SecretCipher,
} from '../infrastructure/secret-cipher.js';
import {
  canAddressMerchant,
  canManageMerchantAccess,
} from './merchant-access.js';
import { secretKeyHintOf, type ProcessorAccount } from './processor-account.js';
import { PROCESSOR_ACCOUNT_LOCK_TIMEOUT_MILLIS } from './processor-account-locking.js';

export interface ConnectProcessorAccountCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly provider: string;
  readonly displayName: string;
  readonly secretKey: string;
  readonly publishableKey: string;
  readonly correlationId: string;
}

export type ConnectProcessorAccountFailure =
  | 'MERCHANT_NOT_FOUND'
  | 'FORBIDDEN'
  | 'CREDENTIALS_KEY_NOT_CONFIGURED'
  | 'PROVIDER_UNSUPPORTED'
  | 'LIVE_CREDENTIALS'
  | 'INVALID_CREDENTIALS'
  | 'PROCESSOR_UNAVAILABLE'
  | 'ALREADY_CONNECTED'
  | 'LOCK_TIMEOUT';

export type ConnectProcessorAccountResult =
  | { readonly ok: true; readonly account: ProcessorAccount }
  | { readonly ok: false; readonly code: ConnectProcessorAccountFailure };

/** A refusal found inside the transaction, which rolls it back. */
class RefusedInTransaction extends Error {
  constructor(readonly code: ConnectProcessorAccountFailure) {
    super(code);
  }
}

function failureOf(
  reason: CredentialRejectionReason,
): ConnectProcessorAccountFailure {
  switch (reason) {
    case 'LIVE_MODE_KEY':
    case 'LIVE_MODE_ACCOUNT':
      return 'LIVE_CREDENTIALS';
    case 'MALFORMED_KEY':
    case 'AUTHENTICATION_FAILED':
    case 'PERMISSION_DENIED':
      return 'INVALID_CREDENTIALS';
  }
}

/**
 * Connects a provider account to a merchant. The platform administrator may
 * do it for any merchant, and `MERCHANT_ADMIN` for its own. The steps follow
 * AD-52 and keep the provider call outside any transaction:
 *
 * 1. the merchant must be addressable, the role must allow it, and the
 *    merchant must exist;
 * 2. a master key must be configured and the provider must have an adapter
 *    that validates credentials;
 * 3. the adapter validates the credentials with the provider, with no
 *    transaction open; live and invalid keys are refused;
 * 4. one short transaction locks the merchant row, so changes to its accounts
 *    are serialized, makes the account the default when the merchant has
 *    none, inserts it with its secret encrypted, and writes
 *    `PROCESSOR_ACCOUNT_CONNECTED`.
 *
 * The secret key is in memory only during this call; the result, the logs,
 * and the audit event never carry it.
 */
@Injectable()
export class ConnectProcessorAccountService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROCESSOR_REGISTRY)
    private readonly registry: ProcessorAdapterRegistry,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher | null,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ConnectProcessorAccountService.name);
  }

  async execute(
    command: ConnectProcessorAccountCommand,
  ): Promise<ConnectProcessorAccountResult> {
    const { principal } = command;
    if (!canAddressMerchant(principal, command.merchantId)) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    if (!canManageMerchantAccess(principal)) {
      return { ok: false, code: 'FORBIDDEN' };
    }
    if (
      (await findMerchantById(this.database, command.merchantId)) === undefined
    ) {
      return { ok: false, code: 'MERCHANT_NOT_FOUND' };
    }
    const cipher = this.cipher;
    if (cipher === null) {
      return { ok: false, code: 'CREDENTIALS_KEY_NOT_CONFIGURED' };
    }
    const adapter = this.registry.findWithCapability(
      command.provider,
      'CREDENTIAL_VALIDATION',
    );
    if (adapter === undefined) {
      return { ok: false, code: 'PROVIDER_UNSUPPORTED' };
    }

    const validation = await adapter.validateCredentials({
      secretKey: command.secretKey,
      publishableKey: command.publishableKey,
    });
    switch (validation.outcome) {
      case 'rejected':
        this.logger.info(
          {
            merchantId: command.merchantId,
            provider: command.provider,
            reason: validation.reason,
            correlationId: command.correlationId,
          },
          'processor credentials rejected',
        );
        return { ok: false, code: failureOf(validation.reason) };
      case 'unavailable':
        this.logger.warn(
          {
            merchantId: command.merchantId,
            provider: command.provider,
            category: validation.category,
            correlationId: command.correlationId,
          },
          'processor unavailable for credential validation',
        );
        return { ok: false, code: 'PROCESSOR_UNAVAILABLE' };
      case 'valid':
        break;
    }

    const now = this.clock.now();
    const id = randomUUID();
    const secret = cipher.encrypt(command.secretKey, {
      merchantId: command.merchantId,
      processorAccountId: id,
      provider: command.provider,
    });
    const draft: Omit<ProcessorAccount, 'isDefault'> = {
      id,
      merchantId: command.merchantId,
      provider: command.provider,
      displayName: command.displayName,
      providerAccountId: validation.providerAccountId,
      publishableKey: command.publishableKey,
      secretKeyHint: secretKeyHintOf(command.secretKey),
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const account = await this.database
        .transaction()
        .execute(async (trx: DatabaseTransaction) => {
          await setLocalLockTimeout(trx, PROCESSOR_ACCOUNT_LOCK_TIMEOUT_MILLIS);
          const merchant = await findMerchantByIdForUpdate(
            trx,
            command.merchantId,
          );
          if (merchant === undefined) {
            throw new RefusedInTransaction('MERCHANT_NOT_FOUND');
          }
          const isDefault = !(await hasDefaultProcessorAccount(
            trx,
            command.merchantId,
          ));
          const inserted = await insertProcessorAccount(
            trx,
            { ...draft, isDefault },
            secret,
          );
          await appendAuditEvent(trx, {
            id: randomUUID(),
            occurredAt: now,
            ...auditActorOf(principal),
            action: 'PROCESSOR_ACCOUNT_CONNECTED',
            targetType: 'PROCESSOR_ACCOUNT',
            targetId: inserted.id,
            merchantId: command.merchantId,
            correlationId: command.correlationId,
            metadata: {
              provider: inserted.provider,
              provider_account_id: inserted.providerAccountId,
              is_default: inserted.isDefault,
            },
          });
          return inserted;
        });
      this.logger.info(
        {
          processorAccountId: account.id,
          merchantId: account.merchantId,
          provider: account.provider,
          isDefault: account.isDefault,
          correlationId: command.correlationId,
        },
        'processor account connected',
      );
      return { ok: true, account };
    } catch (error) {
      if (error instanceof RefusedInTransaction) {
        return { ok: false, code: error.code };
      }
      if (isUniqueViolation(error, ENABLED_PROVIDER_ACCOUNT_INDEX)) {
        return { ok: false, code: 'ALREADY_CONNECTED' };
      }
      if (isLockNotAvailable(error)) return { ok: false, code: 'LOCK_TIMEOUT' };
      throw error;
    }
  }
}
