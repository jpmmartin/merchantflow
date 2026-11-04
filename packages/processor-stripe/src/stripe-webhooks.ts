import type {
  ProcessorEvent,
  ProcessorEventReferences,
  WebhookEventVerification,
} from '@merchantflow/processor-contracts';
import Stripe from 'stripe';

/**
 * The event types a webhook endpoint the platform creates subscribes to,
 * confirmed in Stripe's event type reference: a refund whose status changed
 * (`refund.updated`, sent when a pending refund succeeds) or that failed
 * (`refund.failed`, also sent when a succeeded refund fails later), and a
 * PaymentIntent that succeeded (captured), whose payment attempt failed, that
 * has funds to capture (`payment_intent.amount_capturable_updated`, sent when a
 * manual-capture payment is authorized), or that was canceled (sent when a
 * hold is voided or its authorization expires).
 */
export const STRIPE_WEBHOOK_EVENT_TYPES = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.amount_capturable_updated',
  'payment_intent.canceled',
  'refund.updated',
  'refund.failed',
] as const;

/** What the platform handles each subscribed event type as. */
function subjectOf(type: string): 'PAYMENT' | 'REFUND' | null {
  switch (type) {
    case 'payment_intent.succeeded':
    case 'payment_intent.payment_failed':
    case 'payment_intent.amount_capturable_updated':
    case 'payment_intent.canceled':
      return 'PAYMENT';
    case 'refund.updated':
    case 'refund.failed':
      return 'REFUND';
    default:
      return null;
  }
}

/** A Stripe event ID, such as `evt_1Q...`. */
const EVENT_ID = /^evt_[A-Za-z0-9_]{1,240}$/;

/** The form of an event type, such as `refund.updated`. */
const EVENT_TYPE = /^[a-z0-9_.]{1,100}$/;

/** The form of an object type, such as `refund` or `payment_intent`. */
const OBJECT_TYPE = /^[a-z0-9_.]{1,50}$/;

/** Stripe object IDs: a prefix such as `re_` and letters, digits, or `_`. */
const OBJECT_ID = /^[A-Za-z0-9_]{1,255}$/;

/** A PaymentIntent ID. */
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9_]{1,240}$/;

/** A platform identifier as the platform writes it into metadata. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function stringField(value: object, key: string): unknown {
  return key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function matching(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

/** The platform identifiers in an object's metadata, each a UUID or null. */
function referencesOf(object: object): ProcessorEventReferences {
  const metadata = stringField(object, 'metadata');
  const read = (key: string): string | null =>
    typeof metadata === 'object' && metadata !== null
      ? matching(stringField(metadata, key), UUID)
      : null;
  return {
    merchantId: read('merchant_id'),
    paymentIntentId: read('payment_intent_id'),
    paymentAttemptId: read('payment_attempt_id'),
    refundId: read('refund_id'),
  };
}

/**
 * The PaymentIntent an event's object belongs to: the object itself for a
 * PaymentIntent, and the refund's `payment_intent` (an ID, or an expanded
 * object) for a refund.
 */
function providerTransactionOf(
  objectType: string,
  object: object,
): string | null {
  if (objectType === 'payment_intent') {
    return matching(stringField(object, 'id'), PAYMENT_INTENT_ID);
  }
  if (objectType === 'refund') {
    const intent = stringField(object, 'payment_intent');
    if (typeof intent === 'string') return matching(intent, PAYMENT_INTENT_ID);
    if (typeof intent === 'object' && intent !== null) {
      return matching(stringField(intent, 'id'), PAYMENT_INTENT_ID);
    }
  }
  return null;
}

/**
 * Normalizes a verified Stripe event, reading only the fields the platform
 * needs; an event without a usable ID or type is refused. No Stripe type
 * leaves this function.
 */
export function normalizeStripeEvent(
  event: Stripe.Event,
): ProcessorEvent | null {
  const providerEventId = matching(event.id, EVENT_ID);
  const type = matching(event.type, EVENT_TYPE);
  if (providerEventId === null || type === null) return null;
  const raw: unknown = event.data.object;
  if (typeof raw !== 'object' || raw === null) {
    return {
      providerEventId,
      type,
      subject: null,
      livemode: event.livemode,
      object: null,
      providerTransactionId: null,
      references: {
        merchantId: null,
        paymentIntentId: null,
        paymentAttemptId: null,
        refundId: null,
      },
    };
  }
  const objectType = matching(stringField(raw, 'object'), OBJECT_TYPE);
  const objectId = matching(stringField(raw, 'id'), OBJECT_ID);
  const object =
    objectType === null || objectId === null
      ? null
      : { type: objectType, id: objectId };
  return {
    providerEventId,
    type,
    // A subject is only usable with the object it is about.
    subject: object === null ? null : subjectOf(type),
    livemode: event.livemode,
    object,
    providerTransactionId:
      objectType === null ? null : providerTransactionOf(objectType, raw),
    references: referencesOf(raw),
  };
}

/**
 * Verifies a delivery with Stripe's own check, `webhooks.constructEvent`, on
 * the raw body and the `Stripe-Signature` header, with Stripe's default
 * tolerance of 300 seconds between the signed timestamp and now. A wrong,
 * missing, or expired signature is a `StripeSignatureVerificationError`, and a
 * signed body that is not JSON a `SyntaxError`; both are a rejection without a
 * reason. Any other error is a defect and is thrown.
 */
export function verifyStripeWebhook(
  payload: Uint8Array,
  signatureHeader: string,
  signingSecret: string,
): WebhookEventVerification {
  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(
      Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
      signatureHeader,
      signingSecret,
    );
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeSignatureVerificationError ||
      error instanceof SyntaxError
    ) {
      return { outcome: 'rejected' };
    }
    throw error;
  }
  const normalized = normalizeStripeEvent(event);
  return normalized === null
    ? { outcome: 'rejected' }
    : { outcome: 'verified', event: normalized };
}
