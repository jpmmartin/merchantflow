import type { Database } from '@merchantflow/database';
import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '../../auth/application/principal.js';
import { DATABASE } from '../../database/database.module.js';
import { GetProcessorAccountWebhookService } from '../../merchants/application/get-processor-account-webhook.service.js';
import { listRecentProcessorEvents } from '../infrastructure/processor-event-queries.js';
import type { ProcessorEventRecord } from './processor-event.js';

/** How many of the latest events the list returns. */
export const RECENT_PROCESSOR_EVENTS_LIMIT = 20;

export interface ListProcessorEventsCommand {
  readonly principal: Principal;
  readonly merchantId: string;
  readonly processorAccountId: string;
}

export type ListProcessorEventsResult =
  | { readonly ok: true; readonly events: readonly ProcessorEventRecord[] }
  | { readonly ok: false; readonly code: 'NOT_FOUND' };

/**
 * Lists the latest webhook events received for one processor account,
 * newest first. Access follows the account's webhook configuration: every
 * role of a merchant it can address, and the platform administrator for any;
 * another merchant, or an account that is not the merchant's, is "not found"
 * before the inbox is read.
 */
@Injectable()
export class ListProcessorEventsService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    private readonly getWebhook: GetProcessorAccountWebhookService,
  ) {}

  async execute(
    command: ListProcessorEventsCommand,
  ): Promise<ListProcessorEventsResult> {
    const access = await this.getWebhook.execute(command);
    if (!access.ok) return { ok: false, code: 'NOT_FOUND' };
    return {
      ok: true,
      events: await listRecentProcessorEvents(this.database, {
        merchantId: access.view.account.merchantId,
        processorAccountId: access.view.account.id,
        limit: RECENT_PROCESSOR_EVENTS_LIMIT,
      }),
    };
  }
}
