import type { ProcessorCredentials } from './credentials.js';
import type { ProcessorErrorCategory } from './error-category.js';

/**
 * A webhook endpoint to create at the provider, in the account the
 * credentials belong to.
 *
 * - `url`: the public URL the provider delivers the account's events to.
 * - `operationId`: a new identity per request, sent as the provider's
 *   idempotency key, so a retry of the same request cannot create a second
 *   endpoint.
 * - `references`: identifiers of the platform account, attached to the
 *   endpoint where the provider supports it.
 */
export interface CreateWebhookEndpointInput {
  readonly credentials: ProcessorCredentials;
  readonly url: string;
  readonly operationId: string;
  readonly references: {
    readonly merchantId: string;
    readonly processorAccountId: string;
  };
}

/**
 * The outcome of creating a webhook endpoint.
 *
 * - `created`: the provider created it and returned its signing secret, which
 *   the provider returns only at creation.
 * - `rejected`: the provider refused the request, so no endpoint exists:
 *   `CREDENTIALS` for a key it refused or that lacks the permission,
 *   `INVALID_REQUEST` for a URL or parameter it refused.
 * - `unavailable`: no usable answer. The provider may or may not have created
 *   the endpoint.
 */
export type WebhookEndpointCreation =
  | {
      readonly outcome: 'created';
      readonly endpointId: string;
      readonly signingSecret: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly reason: 'CREDENTIALS' | 'INVALID_REQUEST';
    }
  | {
      readonly outcome: 'unavailable';
      readonly category: Exclude<ProcessorErrorCategory, 'ISSUER_DECLINE'>;
    };

/** A webhook endpoint to delete at the provider. */
export interface DeleteWebhookEndpointInput {
  readonly credentials: ProcessorCredentials;
  readonly endpointId: string;
}

/**
 * The outcome of deleting a webhook endpoint: `deleted`, `not_found` (it no
 * longer exists, for example because it was deleted in the provider's
 * dashboard), or `unavailable` (no usable answer; it may still exist).
 */
export type WebhookEndpointDeletion =
  | { readonly outcome: 'deleted' }
  | { readonly outcome: 'not_found' }
  | {
      readonly outcome: 'unavailable';
      readonly category: Exclude<ProcessorErrorCategory, 'ISSUER_DECLINE'>;
    };

/**
 * A webhook delivery to verify: the body exactly as received, the
 * provider's signature header, and the account's signing secret.
 */
export interface VerifyWebhookEventInput {
  readonly payload: Uint8Array;
  readonly signatureHeader: string;
  readonly signingSecret: string;
}

/**
 * Platform identifiers the provider's object carries, as the platform sent
 * them when it created the object. Each is a UUID or `null`.
 */
export interface ProcessorEventReferences {
  readonly merchantId: string | null;
  readonly paymentIntentId: string | null;
  readonly paymentAttemptId: string | null;
  readonly refundId: string | null;
}

/**
 * A provider event, normalized. It is a trigger only: the object's current
 * state is read from the provider before anything is applied.
 *
 * - `providerEventId`: the provider's ID, unique per account.
 * - `type`: the provider's event type, such as `refund.updated`.
 * - `livemode`: whether the event comes from live mode.
 * - `object`: the type and ID of the object the event is about, when it names
 *   one.
 * - `subject`: what the platform handles the event as, decided by the
 *   adapter from the provider's type: `PAYMENT` for a payment that succeeded
 *   or whose attempt failed, `REFUND` for a refund whose status changed, and
 *   `null` for any other type, which the platform records and ignores.
 * - `providerTransactionId`: the provider payment the object belongs to: the
 *   payment itself, or the payment a refund returns money from.
 */
export interface ProcessorEvent {
  readonly providerEventId: string;
  readonly type: string;
  readonly subject: 'PAYMENT' | 'REFUND' | null;
  readonly livemode: boolean;
  readonly object: { readonly type: string; readonly id: string } | null;
  readonly providerTransactionId: string | null;
  readonly references: ProcessorEventReferences;
}

/**
 * The outcome of a signature check: `verified` with the normalized event, or
 * `rejected` for a missing, malformed, wrong, or expired signature and for a
 * payload that is not an event. A rejection carries no reason, so nothing
 * about it can reach the sender.
 */
export type WebhookEventVerification =
  | { readonly outcome: 'verified'; readonly event: ProcessorEvent }
  | { readonly outcome: 'rejected' };
