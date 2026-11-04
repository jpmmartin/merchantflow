import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { DATABASE } from '../../database/database.module.js';
import { findProcessorAccountForDelivery } from '../infrastructure/processor-account-queries.js';
import {
  SECRET_CIPHER,
  type SecretCipher,
} from '../infrastructure/secret-cipher.js';

/**
 * The account a webhook delivery is for, with its signing secret decrypted for
 * the one signature check that needs it. The caller never logs, stores, or
 * returns the secret.
 */
export interface WebhookDeliveryAccount {
  readonly id: string;
  readonly merchantId: string;
  readonly provider: string;
  readonly signingSecret: string;
}

export type WebhookDeliveryAccountResult =
  | { readonly ok: true; readonly account: WebhookDeliveryAccount }
  /**
   * The delivery cannot be verified: the account does not exist, is disabled,
   * or has no signing secret, or no master key is configured. The reasons are
   * not told apart, so a caller can answer every one the same way.
   */
  | { readonly ok: false };

/**
 * Gives the webhooks module the processor account a delivery names, by its id
 * alone, with its signing secret decrypted. The merchants module owns
 * `processor_accounts` and the cipher, so this service is the only way another
 * module reaches a signing secret.
 */
@Injectable()
export class ProcessorAccountsForWebhooksService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(SECRET_CIPHER) private readonly cipher: SecretCipher | null,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProcessorAccountsForWebhooksService.name);
  }

  async forDelivery(
    processorAccountId: string,
  ): Promise<WebhookDeliveryAccountResult> {
    const found = await findProcessorAccountForDelivery(
      this.database,
      processorAccountId,
    );
    if (
      found === undefined ||
      !found.account.enabled ||
      found.signingSecret === null
    ) {
      return { ok: false };
    }
    if (this.cipher === null) {
      this.logger.warn(
        { processorAccountId },
        'CREDENTIALS_MASTER_KEY is not set; webhook deliveries cannot be verified',
      );
      return { ok: false };
    }
    const { account } = found;
    return {
      ok: true,
      account: {
        id: account.id,
        merchantId: account.merchantId,
        provider: account.provider,
        signingSecret: this.cipher.decrypt(found.signingSecret, {
          merchantId: account.merchantId,
          processorAccountId: account.id,
          provider: account.provider,
          purpose: 'WEBHOOK_SIGNING_SECRET',
        }),
      },
    };
  }
}
