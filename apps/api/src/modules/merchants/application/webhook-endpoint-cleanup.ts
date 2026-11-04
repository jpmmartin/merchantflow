import type {
  ProcessorAdapter,
  ProcessorCredentials,
} from '@merchantflow/processor-contracts';
import type { PinoLogger } from 'nestjs-pino';
import type { ProcessorAccountWebhook } from './processor-account.js';

/**
 * What happened to the endpoint a configuration replaced: `NONE` when there
 * was no endpoint the platform created (none, manual, or the same one),
 * `DELETED` when the provider deleted it or no longer had it, and
 * `NOT_DELETED` when the provider gave no usable answer, so it may still exist.
 */
export type PreviousEndpointDeletion = 'NONE' | 'DELETED' | 'NOT_DELETED';

/**
 * Whether two reads show the same configuration: the same mode, endpoint,
 * and configuration time, which a new configuration always changes.
 */
export function sameWebhook(
  a: ProcessorAccountWebhook | null,
  b: ProcessorAccountWebhook | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.mode === b.mode &&
    a.endpointId === b.endpointId &&
    a.configuredAt.getTime() === b.configuredAt.getTime()
  );
}

/**
 * Deletes at the provider the endpoint the platform created for a replaced
 * configuration, after the new one is stored. A failure is logged with the
 * endpoint ID, never a secret, and reported to the caller; the endpoint's
 * deliveries are refused from then on, because their signature does not
 * match the stored secret.
 */
export async function deletePreviousEndpoint(options: {
  readonly adapter: ProcessorAdapter;
  readonly credentials: ProcessorCredentials | undefined;
  readonly previous: ProcessorAccountWebhook | null;
  readonly current: ProcessorAccountWebhook | null;
  readonly logger: PinoLogger;
  readonly processorAccountId: string;
  readonly correlationId: string;
}): Promise<PreviousEndpointDeletion> {
  const endpointId = options.previous?.endpointId ?? null;
  if (endpointId === null || endpointId === options.current?.endpointId) {
    return 'NONE';
  }
  if (options.credentials === undefined) {
    throw new Error('deleting a webhook endpoint needs the account keys');
  }
  const deletion = await options.adapter.deleteWebhookEndpoint({
    credentials: options.credentials,
    endpointId,
  });
  if (deletion.outcome === 'unavailable') {
    options.logger.warn(
      {
        processorAccountId: options.processorAccountId,
        webhookEndpointId: endpointId,
        category: deletion.category,
        correlationId: options.correlationId,
      },
      'replaced webhook endpoint could not be deleted at the provider',
    );
    return 'NOT_DELETED';
  }
  return 'DELETED';
}
