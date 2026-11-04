import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Principal } from '../../auth/application/principal.js';
import type { Env } from '../../config/env.schema.js';
import { DATABASE } from '../../database/database.module.js';
import { findMerchantById } from '../infrastructure/merchant-queries.js';
import { findProcessorAccountWithWebhook } from '../infrastructure/processor-account-queries.js';
import { canAddressMerchant } from './merchant-access.js';
import type {
  ProcessorAccount,
  ProcessorAccountWebhook,
} from './processor-account.js';
import { webhookEndpointUrl } from './webhook-endpoint-url.js';

/**
 * What the API shows of an account's webhook: the account, its configuration
 * (absent when none), and the URL the provider must deliver to (`null`
 * without a public base URL). It never holds the signing secret.
 */
export interface ProcessorAccountWebhookView {
  readonly account: ProcessorAccount;
  readonly webhook: ProcessorAccountWebhook | null;
  readonly endpointUrl: string | null;
}

export interface GetProcessorAccountWebhookCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly processorAccountId: string;
}

export type GetProcessorAccountWebhookResult =
  | { readonly ok: true; readonly view: ProcessorAccountWebhookView }
  | { readonly ok: false; readonly code: 'NOT_FOUND' };

/**
 * Reads the webhook configuration of a processor account. Every role may read
 * it for a merchant it can address; another merchant, existing or not, and an
 * account that is not the merchant's are "not found".
 */
@Injectable()
export class GetProcessorAccountWebhookService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async execute(
    command: GetProcessorAccountWebhookCommand,
  ): Promise<GetProcessorAccountWebhookResult> {
    if (!canAddressMerchant(command.principal, command.merchantId)) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    if (
      (await findMerchantById(this.database, command.merchantId)) === undefined
    ) {
      return { ok: false, code: 'NOT_FOUND' };
    }
    const found = await findProcessorAccountWithWebhook(this.database, {
      merchantId: command.merchantId,
      id: command.processorAccountId,
    });
    if (found === undefined) return { ok: false, code: 'NOT_FOUND' };
    return {
      ok: true,
      view: {
        account: found.account,
        webhook: found.webhook,
        endpointUrl: webhookEndpointUrl(
          this.config.get('PUBLIC_API_BASE_URL', { infer: true }),
          found.account,
        ),
      },
    };
  }
}
