import { randomUUID } from 'node:crypto';
import type { Database } from '@merchantflow/database';
import type {
  ProcessorAdapterRegistry,
  ProcessorEvent,
} from '@merchantflow/processor-contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../../clock/clock.js';
import { DATABASE } from '../../database/database.module.js';
import { ProcessorAccountsForWebhooksService } from '../../merchants/application/processor-accounts-for-webhooks.service.js';
import type {
  AuditActor,
  PresentPaymentConfirmation,
} from '../../payments/application/apply-attempt-resolution.service.js';
import type { PresentRefund } from '../../payments/application/refund-payment-intent.service.js';
import { ResolvePaymentAttemptService } from '../../payments/application/resolve-payment-attempt.service.js';
import { ResolveRefundService } from '../../payments/application/resolve-refund.service.js';
import { PROCESSOR_REGISTRY } from '../../processors/application/processor-registry.js';
import {
  insertProcessorEventIfAbsent,
  recordProcessorEventOutcome,
  startProcessorEventAttempt,
} from '../infrastructure/processor-event-queries.js';
import {
  isFinalOutcome,
  type ProcessorEventOutcome,
  type ProcessorEventRecord,
} from './processor-event.js';

/**
 * Longest time the provider lookup of one delivery may take, with no retry.
 * With the signature check, the inbox writes, and one short Apply
 * transaction, a delivery is answered within about six seconds; a slower
 * lookup fails the run, which answers non-2xx, and the provider redelivers.
 */
export const WEBHOOK_LOOKUP_TIMEOUT_MILLIS = 5_000;

/** The audit actor of every change a provider event causes. */
const WEBHOOK_ACTOR: AuditActor = {
  actorType: 'SYSTEM',
  actorId: 'processor-webhook',
};

/** A UUID as the platform generates its identifiers. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ReceiveProviderEventCommand {
  readonly correlationId: string;
  /** The provider code in the URL, such as `stripe`. */
  readonly provider: string;
  /** The account id in the URL, not yet trusted. */
  readonly processorAccountId: string;
  /** The body exactly as received, if the transport kept it. */
  readonly payload: Uint8Array | undefined;
  readonly signatureHeader: string | undefined;
  readonly presentConfirmation: PresentPaymentConfirmation;
  readonly presentRefund: PresentRefund;
}

export type ReceiveProviderEventResult =
  /**
   * The delivery cannot be verified: an unknown account, a disabled one, one
   * with no signing secret, another provider, a bad or missing signature, or
   * a live-mode event. One answer for all, so it reveals nothing.
   */
  | { readonly outcome: 'REJECTED' }
  /** The event is stored and has a final outcome; acknowledge it. */
  | {
      readonly outcome: 'ACKNOWLEDGED';
      readonly eventOutcome: ProcessorEventOutcome;
      /** True when an earlier delivery already processed it. */
      readonly duplicate: boolean;
    }
  /** The event is stored and processing failed; the provider must redeliver it. */
  | { readonly outcome: 'NOT_PROCESSED' };

/** What one processing run concluded, to record in the inbox. */
interface RunOutcome {
  readonly outcome: ProcessorEventOutcome;
  readonly detail: string;
}

/**
 * Receives one webhook delivery. In order:
 *
 * 1. The account is read by the id in the URL and its signing secret is
 *    decrypted; the signature is verified on the raw body by the provider's
 *    adapter. Every failure, and a live-mode event, is the one `REJECTED`.
 * 2. The verified event is stored in the inbox, unique per account and
 *    provider event ID, before anything else. Only then may the delivery be
 *    acknowledged.
 * 3. An event whose outcome is final (`PROCESSED` or `IGNORED`) is
 *    acknowledged again and changes nothing. A new event, or one that
 *    `FAILED` before, is processed now.
 * 4. Processing treats the event as a trigger only: the payment or refund it
 *    names is read from the provider, with no transaction open and within
 *    `WEBHOOK_LOOKUP_TIMEOUT_MILLIS`, and applied by the payments module's
 *    resolution services with conditional updates. Types the platform does
 *    not handle, and objects it does not know, are `IGNORED`.
 * 5. The outcome is recorded. A `FAILED` run answers non-2xx so that the
 *    provider delivers the event again; an error thrown while processing is
 *    recorded as `FAILED` and thrown again.
 *
 * Concurrent deliveries of one event may both process it; the conditional
 * updates and the ledger's unique source references let only one change
 * anything, and the other finds nothing to change.
 */
@Injectable()
export class ReceiveProviderEventService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROCESSOR_REGISTRY)
    private readonly registry: ProcessorAdapterRegistry,
    private readonly accounts: ProcessorAccountsForWebhooksService,
    private readonly resolvePaymentAttempt: ResolvePaymentAttemptService,
    private readonly resolveRefund: ResolveRefundService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReceiveProviderEventService.name);
  }

  async execute(
    command: ReceiveProviderEventCommand,
  ): Promise<ReceiveProviderEventResult> {
    const event = await this.verify(command);
    if (event === undefined) return { outcome: 'REJECTED' };
    const { account, verified } = event;

    const stored = await insertProcessorEventIfAbsent(this.database, {
      id: randomUUID(),
      merchantId: account.merchantId,
      processorAccountId: account.id,
      providerEventId: verified.providerEventId,
      eventType: verified.type,
      objectType: verified.object?.type ?? null,
      objectId: verified.object?.id ?? null,
      receivedAt: this.clock.now(),
    });
    const logContext = {
      processorAccountId: account.id,
      merchantId: account.merchantId,
      processorEventId: stored.record.id,
      providerEventId: verified.providerEventId,
      eventType: verified.type,
      correlationId: command.correlationId,
    };
    if (isFinalOutcome(stored.record.outcome)) {
      this.logger.info(
        { ...logContext, eventOutcome: stored.record.outcome },
        'provider event already processed; acknowledged again',
      );
      return this.acknowledged(stored.record, true);
    }

    const started = await startProcessorEventAttempt(this.database, {
      merchantId: account.merchantId,
      id: stored.record.id,
    });
    if (started === undefined) {
      // Another delivery of the same event recorded a final outcome first.
      return {
        outcome: 'ACKNOWLEDGED',
        eventOutcome: 'PROCESSED',
        duplicate: true,
      };
    }

    let run: RunOutcome;
    try {
      run = await this.process(command, account, verified);
    } catch (error) {
      await recordProcessorEventOutcome(this.database, {
        merchantId: account.merchantId,
        id: started.id,
        outcome: 'FAILED',
        detail: 'PROCESSING_ERROR',
        processedAt: this.clock.now(),
      });
      this.logger.error(
        {
          ...logContext,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'provider event processing failed with an error; it will be processed again on redelivery',
      );
      throw error;
    }
    const recorded = await recordProcessorEventOutcome(this.database, {
      merchantId: account.merchantId,
      id: started.id,
      outcome: run.outcome,
      detail: run.detail,
      processedAt: this.clock.now(),
    });
    this.logger.info(
      {
        ...logContext,
        attempt: started.attempts,
        eventOutcome: run.outcome,
        detail: run.detail,
        recorded,
      },
      'provider event processed',
    );
    if (run.outcome === 'FAILED') return { outcome: 'NOT_PROCESSED' };
    return {
      outcome: 'ACKNOWLEDGED',
      eventOutcome: run.outcome,
      duplicate: !recorded,
    };
  }

  private acknowledged(
    record: ProcessorEventRecord,
    duplicate: boolean,
  ): ReceiveProviderEventResult {
    return {
      outcome: 'ACKNOWLEDGED',
      eventOutcome: record.outcome ?? 'PROCESSED',
      duplicate,
    };
  }

  /** Step 1: the account, its secret, the signature, and the mode. */
  private async verify(command: ReceiveProviderEventCommand): Promise<
    | {
        readonly account: { readonly id: string; readonly merchantId: string };
        readonly verified: ProcessorEvent;
      }
    | undefined
  > {
    const { payload, signatureHeader } = command;
    if (
      !UUID.test(command.processorAccountId) ||
      payload === undefined ||
      payload.byteLength === 0 ||
      signatureHeader === undefined ||
      signatureHeader === ''
    ) {
      return undefined;
    }
    const found = await this.accounts.forDelivery(command.processorAccountId);
    if (!found.ok || found.account.provider !== command.provider) {
      return undefined;
    }
    const adapter = this.registry.findWithCapability(
      found.account.provider,
      'WEBHOOKS',
    );
    if (adapter === undefined) return undefined;
    const verification = adapter.verifyWebhookEvent({
      payload,
      signatureHeader,
      signingSecret: found.account.signingSecret,
    });
    if (verification.outcome === 'rejected') {
      this.logger.warn(
        {
          processorAccountId: found.account.id,
          correlationId: command.correlationId,
        },
        'webhook signature rejected',
      );
      return undefined;
    }
    if (verification.event.livemode) {
      this.logger.warn(
        {
          processorAccountId: found.account.id,
          providerEventId: verification.event.providerEventId,
          correlationId: command.correlationId,
        },
        'live-mode webhook event rejected',
      );
      return undefined;
    }
    return {
      account: { id: found.account.id, merchantId: found.account.merchantId },
      verified: verification.event,
    };
  }

  /** Step 4: the event as a trigger for the object it names. */
  private async process(
    command: ReceiveProviderEventCommand,
    account: { readonly id: string; readonly merchantId: string },
    event: ProcessorEvent,
  ): Promise<RunOutcome> {
    const shared = {
      actor: WEBHOOK_ACTOR,
      correlationId: command.correlationId,
      merchantId: account.merchantId,
      lookupTimeoutMs: WEBHOOK_LOOKUP_TIMEOUT_MILLIS,
    };
    switch (event.subject) {
      case null:
        return { outcome: 'IGNORED', detail: 'UNHANDLED_EVENT_TYPE' };
      case 'PAYMENT': {
        if (event.providerTransactionId === null) {
          return { outcome: 'IGNORED', detail: 'NOT_MATCHED' };
        }
        const result = await this.resolvePaymentAttempt.execute({
          ...shared,
          processorAccountId: account.id,
          providerTransactionId: event.providerTransactionId,
          paymentAttemptId: event.references.paymentAttemptId,
          present: command.presentConfirmation,
        });
        switch (result.outcome) {
          case 'RESOLVED':
            return { outcome: 'PROCESSED', detail: result.detail };
          case 'NO_CHANGE':
            return { outcome: 'PROCESSED', detail: 'NO_CHANGE' };
          case 'NOT_MATCHED':
            return { outcome: 'IGNORED', detail: 'NOT_MATCHED' };
          case 'EXECUTING':
            return { outcome: 'FAILED', detail: 'OBJECT_EXECUTING' };
          case 'LOOKUP_UNAVAILABLE':
            return { outcome: 'FAILED', detail: 'LOOKUP_UNAVAILABLE' };
          case 'CREDENTIALS_KEY_NOT_CONFIGURED':
            return {
              outcome: 'FAILED',
              detail: 'CREDENTIALS_KEY_NOT_CONFIGURED',
            };
          case 'PROVIDER_UNSUPPORTED':
            return { outcome: 'FAILED', detail: 'PROVIDER_UNSUPPORTED' };
        }
        break;
      }
      case 'REFUND': {
        if (event.object === null) {
          return { outcome: 'IGNORED', detail: 'NOT_MATCHED' };
        }
        const result = await this.resolveRefund.executeForProviderRefund({
          ...shared,
          processorAccountId: account.id,
          providerRefundId: event.object.id,
          refundId: event.references.refundId,
          present: command.presentRefund,
        });
        switch (result.outcome) {
          case 'RESOLVED':
            return { outcome: 'PROCESSED', detail: result.detail };
          case 'NO_CHANGE':
            return { outcome: 'PROCESSED', detail: 'NO_CHANGE' };
          case 'NOT_MATCHED':
            return { outcome: 'IGNORED', detail: 'NOT_MATCHED' };
          case 'EXECUTING':
            return { outcome: 'FAILED', detail: 'OBJECT_EXECUTING' };
          case 'NO_PROVIDER_ID':
            return { outcome: 'FAILED', detail: 'NO_PROVIDER_ID' };
          case 'LOOKUP_UNAVAILABLE':
            return { outcome: 'FAILED', detail: 'LOOKUP_UNAVAILABLE' };
          case 'CREDENTIALS_KEY_NOT_CONFIGURED':
            return {
              outcome: 'FAILED',
              detail: 'CREDENTIALS_KEY_NOT_CONFIGURED',
            };
          case 'PROVIDER_UNSUPPORTED':
            return { outcome: 'FAILED', detail: 'PROVIDER_UNSUPPORTED' };
          case 'LOCK_TIMEOUT':
            return { outcome: 'FAILED', detail: 'LOCK_TIMEOUT' };
        }
        break;
      }
    }
    throw new Error(
      `unhandled provider event subject ${String(event.subject)}`,
    );
  }
}
