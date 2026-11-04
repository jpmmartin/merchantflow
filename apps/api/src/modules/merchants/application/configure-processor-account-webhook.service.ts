import { randomUUID } from 'node:crypto';
import {
  isLockNotAvailable,
  setLocalLockTimeout,
  type Database,
} from '@merchantflow/database';
import type {
  ProcessorAdapter,
  ProcessorAdapterRegistry,
  ProcessorCredentials,
} from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { appendAuditEvent } from '../../audit/infrastructure/audit-event-queries.js';
import {
  auditActorOf,
  type Principal,
} from '../../auth/application/principal.js';
import { CLOCK, type Clock } from '../../clock/clock.js';
import type { Env } from '../../config/env.schema.js';
import { DATABASE } from '../../database/database.module.js';
import { PROCESSOR_REGISTRY } from '../../processors/application/processor-registry.js';
import {
  findMerchantById,
  findMerchantByIdForUpdate,
} from '../infrastructure/merchant-queries.js';
import {
  findProcessorAccountWithWebhook,
  saveProcessorAccountWebhook,
  type ProcessorAccountWithWebhook,
} from '../infrastructure/processor-account-queries.js';
import {
  SECRET_CIPHER,
  type SecretCipher,
} from '../infrastructure/secret-cipher.js';
import type { ProcessorAccountWebhookView } from './get-processor-account-webhook.service.js';
import {
  canAddressMerchant,
  canManageMerchantAccess,
} from './merchant-access.js';
import {
  signingSecretHintOf,
  type ProcessorAccountWebhook,
} from './processor-account.js';
import { PROCESSOR_ACCOUNT_LOCK_TIMEOUT_MILLIS } from './processor-account-locking.js';
import { ProcessorAccountsForPaymentsService } from './processor-accounts-for-payments.service.js';
import {
  deletePreviousEndpoint,
  sameWebhook,
  type PreviousEndpointDeletion,
} from './webhook-endpoint-cleanup.js';
import { webhookEndpointUrl } from './webhook-endpoint-url.js';

/** Audit action of a stored webhook configuration. */
export const PROCESSOR_ACCOUNT_WEBHOOK_CONFIGURED =
  'PROCESSOR_ACCOUNT_WEBHOOK_CONFIGURED';

export type WebhookConfigurationRequest =
  /** The platform creates the endpoint at the provider. */
  | { readonly mode: 'AUTOMATIC' }
  /** The merchant created it and pastes its signing secret. */
  | { readonly mode: 'MANUAL'; readonly signingSecret: string };

export interface ConfigureProcessorAccountWebhookCommand {
  readonly principal: Principal;
  readonly correlationId: string;
  readonly merchantId: string;
  readonly processorAccountId: string;
  readonly request: WebhookConfigurationRequest;
}

export type ConfigureProcessorAccountWebhookFailureCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  /** The account is disabled. Nothing changed. */
  | 'DISABLED'
  /** No master key: no secret can be encrypted or decrypted. Nothing changed. */
  | 'CREDENTIALS_KEY_NOT_CONFIGURED'
  /** The account's provider has no adapter with webhooks. Nothing changed. */
  | 'PROVIDER_UNSUPPORTED'
  /** No public base URL to register (automatic path). Nothing changed. */
  | 'PUBLIC_BASE_URL_NOT_CONFIGURED'
  /** The provider refused the account's secret key. Nothing changed. */
  | 'INVALID_CREDENTIALS'
  /** The provider refused the endpoint, such as its URL. Nothing changed. */
  | 'ENDPOINT_REJECTED'
  /** The provider gave no usable answer. Nothing was stored. */
  | 'PROCESSOR_UNAVAILABLE'
  /** Another change of the configuration came first. Nothing was stored. */
  | 'CONFIGURATION_CHANGED'
  | 'LOCK_TIMEOUT';

export type ConfigureProcessorAccountWebhookResult =
  | {
      readonly ok: true;
      readonly view: ProcessorAccountWebhookView;
      /** What happened to the endpoint this configuration replaced. */
      readonly previousEndpoint: PreviousEndpointDeletion;
    }
  | {
      readonly ok: false;
      readonly code: ConfigureProcessorAccountWebhookFailureCode;
    };

type Failure = Extract<ConfigureProcessorAccountWebhookResult, { ok: false }>;

/** A signing secret ready to store, and the endpoint it belongs to. */
interface ObtainedSecret {
  readonly signingSecret: string;
  readonly endpointId: string | null;
}

/**
 * Configures the webhook of a processor account, replacing any previous
 * configuration. The platform administrator may do it for any merchant, and
 * `MERCHANT_ADMIN` for its own; an account must be enabled.
 *
 * - **Automatic:** with the account's secret key, decrypted for the call,
 *   the adapter creates an endpoint at the provider for
 *   `<PUBLIC_API_BASE_URL>/api/v1/webhooks/<provider>/<account id>` and
 *   returns its signing secret, the only time the provider shows it. No
 *   transaction is open during the call.
 * - **Manual:** the merchant created the endpoint and pastes its signing
 *   secret, already checked for form by the request schema.
 *
 * Then one short transaction locks the merchant and the account rows, checks
 * that the configuration is still the one read before the provider call (so
 * two concurrent changes cannot both win), stores the secret encrypted with
 * the master key and bound to its row and purpose, and writes
 * `PROCESSOR_ACCOUNT_WEBHOOK_CONFIGURED` without the secret. An endpoint
 * created for a configuration that was not stored is deleted again. After the
 * commit, an endpoint the platform created for the replaced configuration is
 * deleted at the provider; if that fails, the new configuration stands and
 * the result says so (the old endpoint's deliveries are then refused, because
 * their signature no longer matches).
 */
@Injectable()
export class ConfigureProcessorAccountWebhookService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher | null,
    @Inject(PROCESSOR_REGISTRY)
    private readonly registry: ProcessorAdapterRegistry,
    private readonly accounts: ProcessorAccountsForPaymentsService,
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ConfigureProcessorAccountWebhookService.name);
  }

  async execute(
    command: ConfigureProcessorAccountWebhookCommand,
  ): Promise<ConfigureProcessorAccountWebhookResult> {
    const { principal } = command;
    if (!canAddressMerchant(principal, command.merchantId)) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (!canManageMerchantAccess(principal)) {
      return { ok: false, code: 'FORBIDDEN' };
    }
    if (
      (await findMerchantById(this.database, command.merchantId)) === undefined
    ) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    const key = {
      merchantId: command.merchantId,
      id: command.processorAccountId,
    };
    const before = await findProcessorAccountWithWebhook(this.database, key);
    if (before === undefined) return { ok: false, code: 'NOT_FOUND' };
    if (!before.account.enabled) return { ok: false, code: 'DISABLED' };
    const cipher = this.cipher;
    if (cipher === null) {
      return { ok: false, code: 'CREDENTIALS_KEY_NOT_CONFIGURED' };
    }
    const adapter = this.registry.findWithCapability(
      before.account.provider,
      'WEBHOOKS',
    );
    if (adapter === undefined) {
      return { ok: false, code: 'PROVIDER_UNSUPPORTED' };
    }
    const publicBaseUrl = this.config.get('PUBLIC_API_BASE_URL', {
      infer: true,
    });

    // The secret key is needed to create an endpoint, and to delete the one
    // the platform created for the configuration being replaced.
    let credentials: ProcessorCredentials | undefined;
    if (
      command.request.mode === 'AUTOMATIC' ||
      (before.webhook?.endpointId ?? null) !== null
    ) {
      credentials = await this.credentialsOf(key);
      if (credentials === undefined) {
        return { ok: false, code: 'CREDENTIALS_KEY_NOT_CONFIGURED' };
      }
    }

    let obtained: ObtainedSecret;
    if (command.request.mode === 'MANUAL') {
      obtained = {
        signingSecret: command.request.signingSecret,
        endpointId: null,
      };
    } else {
      const url = webhookEndpointUrl(publicBaseUrl, before.account);
      if (url === null) {
        return { ok: false, code: 'PUBLIC_BASE_URL_NOT_CONFIGURED' };
      }
      if (credentials === undefined) {
        return { ok: false, code: 'CREDENTIALS_KEY_NOT_CONFIGURED' };
      }
      const created = await this.createEndpoint(
        adapter,
        credentials,
        url,
        before,
        command.correlationId,
      );
      if (!created.ok) return created.failure;
      obtained = created.secret;
    }

    const now = this.clock.now();
    const webhook: ProcessorAccountWebhook = {
      mode: command.request.mode,
      signingSecretHint: signingSecretHintOf(obtained.signingSecret),
      endpointId: obtained.endpointId,
      configuredAt: now,
    };
    let stored: ProcessorAccountWithWebhook | Failure;
    try {
      stored = await this.store(command, before, webhook, obtained, cipher);
    } catch (error) {
      await this.discardCreatedEndpoint(adapter, credentials, obtained, before);
      if (isLockNotAvailable(error)) return { ok: false, code: 'LOCK_TIMEOUT' };
      throw error;
    }
    if ('ok' in stored) {
      await this.discardCreatedEndpoint(adapter, credentials, obtained, before);
      return stored;
    }

    const previousEndpoint = await deletePreviousEndpoint({
      adapter,
      credentials,
      previous: before.webhook,
      current: stored.webhook,
      logger: this.logger,
      processorAccountId: before.account.id,
      correlationId: command.correlationId,
    });
    this.logger.info(
      {
        processorAccountId: before.account.id,
        merchantId: command.merchantId,
        mode: webhook.mode,
        webhookEndpointId: webhook.endpointId,
        previousEndpoint,
        correlationId: command.correlationId,
      },
      'processor account webhook configured',
    );
    return {
      ok: true,
      previousEndpoint,
      view: {
        account: stored.account,
        webhook: stored.webhook,
        endpointUrl: webhookEndpointUrl(publicBaseUrl, stored.account),
      },
    };
  }

  /** The account's keys with the secret key decrypted for the provider call. */
  private async credentialsOf(key: {
    readonly merchantId: string;
    readonly id: string;
  }): Promise<ProcessorCredentials | undefined> {
    const resolved = await this.accounts.forExistingPayment(this.database, {
      merchantId: key.merchantId,
      processorAccountId: key.id,
    });
    if (!resolved.ok) {
      if (resolved.code === 'CREDENTIALS_KEY_NOT_CONFIGURED') return undefined;
      throw new Error(
        `processor account ${key.id} disappeared: ${resolved.code}`,
      );
    }
    return resolved.account.credentials;
  }

  /** The provider call of the automatic path, with no transaction open. */
  private async createEndpoint(
    adapter: ProcessorAdapter,
    credentials: ProcessorCredentials,
    url: string,
    before: ProcessorAccountWithWebhook,
    correlationId: string,
  ): Promise<
    | { readonly ok: true; readonly secret: ObtainedSecret }
    | { readonly ok: false; readonly failure: Failure }
  > {
    const created = await adapter.createWebhookEndpoint({
      credentials,
      url,
      operationId: randomUUID(),
      references: {
        merchantId: before.account.merchantId,
        processorAccountId: before.account.id,
      },
    });
    switch (created.outcome) {
      case 'created':
        return {
          ok: true,
          secret: {
            signingSecret: created.signingSecret,
            endpointId: created.endpointId,
          },
        };
      case 'rejected':
        this.logger.warn(
          {
            processorAccountId: before.account.id,
            reason: created.reason,
            correlationId,
          },
          'provider refused the webhook endpoint',
        );
        return {
          ok: false,
          failure: {
            ok: false,
            code:
              created.reason === 'CREDENTIALS'
                ? 'INVALID_CREDENTIALS'
                : 'ENDPOINT_REJECTED',
          },
        };
      case 'unavailable':
        this.logger.warn(
          {
            processorAccountId: before.account.id,
            category: created.category,
            correlationId,
          },
          'webhook endpoint creation unavailable; an endpoint may exist at the provider',
        );
        return {
          ok: false,
          failure: { ok: false, code: 'PROCESSOR_UNAVAILABLE' },
        };
    }
  }

  /**
   * The store transaction. A refusal inside it is returned, not thrown, and
   * the transaction writes nothing before every check passed.
   */
  private async store(
    command: ConfigureProcessorAccountWebhookCommand,
    before: ProcessorAccountWithWebhook,
    webhook: ProcessorAccountWebhook,
    obtained: ObtainedSecret,
    cipher: SecretCipher,
  ): Promise<ProcessorAccountWithWebhook | Failure> {
    return this.database.transaction().execute(async (trx) => {
      await setLocalLockTimeout(trx, PROCESSOR_ACCOUNT_LOCK_TIMEOUT_MILLIS);
      // Account changes of a merchant lock its row, so they are serialized.
      if (
        (await findMerchantByIdForUpdate(trx, command.merchantId)) === undefined
      ) {
        return { ok: false, code: 'NOT_FOUND' } as const;
      }
      const current = await findProcessorAccountWithWebhook(
        trx,
        { merchantId: command.merchantId, id: command.processorAccountId },
        { forUpdate: true },
      );
      if (current === undefined)
        return { ok: false, code: 'NOT_FOUND' } as const;
      if (!current.account.enabled) {
        return { ok: false, code: 'DISABLED' } as const;
      }
      if (!sameWebhook(current.webhook, before.webhook)) {
        return { ok: false, code: 'CONFIGURATION_CHANGED' } as const;
      }
      const secret = cipher.encrypt(obtained.signingSecret, {
        merchantId: current.account.merchantId,
        processorAccountId: current.account.id,
        provider: current.account.provider,
        purpose: 'WEBHOOK_SIGNING_SECRET',
      });
      const saved = await saveProcessorAccountWebhook(trx, {
        merchantId: command.merchantId,
        id: command.processorAccountId,
        webhook,
        secret,
        updatedAt: webhook.configuredAt,
      });
      if (saved === undefined) {
        throw new Error(
          `processor account ${command.processorAccountId} disappeared under its row lock`,
        );
      }
      await appendAuditEvent(trx, {
        id: randomUUID(),
        occurredAt: webhook.configuredAt,
        ...auditActorOf(command.principal),
        action: PROCESSOR_ACCOUNT_WEBHOOK_CONFIGURED,
        targetType: 'PROCESSOR_ACCOUNT',
        targetId: current.account.id,
        merchantId: command.merchantId,
        correlationId: command.correlationId,
        metadata: {
          provider: current.account.provider,
          mode: webhook.mode,
          webhook_endpoint_id: webhook.endpointId,
          previous_mode: current.webhook?.mode ?? null,
          previous_webhook_endpoint_id: current.webhook?.endpointId ?? null,
        },
      });
      return saved;
    });
  }

  /**
   * Deletes an endpoint this request created and could not store, so no
   * endpoint at the provider is left without a configuration that verifies
   * its deliveries. A failure is logged with the endpoint ID for manual
   * cleanup.
   */
  private async discardCreatedEndpoint(
    adapter: ProcessorAdapter,
    credentials: ProcessorCredentials | undefined,
    obtained: ObtainedSecret,
    before: ProcessorAccountWithWebhook,
  ): Promise<void> {
    if (obtained.endpointId === null || credentials === undefined) return;
    const deletion = await adapter.deleteWebhookEndpoint({
      credentials,
      endpointId: obtained.endpointId,
    });
    if (deletion.outcome === 'unavailable') {
      this.logger.warn(
        {
          processorAccountId: before.account.id,
          webhookEndpointId: obtained.endpointId,
          category: deletion.category,
        },
        'webhook endpoint of a configuration that was not stored could not be deleted',
      );
    }
  }
}
