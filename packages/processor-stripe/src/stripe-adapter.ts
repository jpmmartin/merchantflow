import type {
  CredentialValidationResult,
  GetTransactionInput,
  ProcessorAdapter,
  ProcessorCapability,
  ProcessorCredentials,
  ProcessorPaymentResult,
  ProcessorRefundResult,
  ProcessorTransactionLookup,
  RefundInput,
  SaleInput,
} from '@merchantflow/processor-contracts';
import Stripe from 'stripe';
import { toStripeAmount } from './stripe-amount.js';
import { checkStripeKey } from './stripe-keys.js';
import {
  PAYMENT_INTENT_ID,
  PAYMENT_METHOD_ID,
  lookupErrorResult,
  paymentIntentResult,
  refundErrorResult,
  refundResult,
  saleErrorResult,
} from './stripe-results.js';

/** Provider code of the Stripe adapter. */
export const STRIPE_PROVIDER = 'stripe';

export interface StripeAdapterOptions {
  /** Longest time one read from Stripe may take, in milliseconds. */
  readonly timeoutMs?: number;
  /** Longest time one try of a sale may take, in milliseconds. */
  readonly saleTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * A card confirmation, 3D Secure included, normally answers within a few
 * seconds; a try that takes longer ends as a connection error, which is an
 * unknown outcome.
 */
const DEFAULT_SALE_TIMEOUT_MS = 20_000;

/**
 * Automatic retries of a read. A read changes nothing, so one more try cannot
 * duplicate anything.
 */
const READ_MAX_NETWORK_RETRIES = 1;

/**
 * Automatic retries of a sale after a broken connection, a timeout, a
 * conflict, or a server error. Every try sends the operation ID as the same
 * `Idempotency-Key`, so Stripe answers a retry of an executed request with its
 * first result instead of charging again.
 */
const SALE_MAX_NETWORK_RETRIES = 2;

/**
 * Automatic retries of a refund, on the same conditions as a sale. Every try
 * sends the refund's operation ID as the same `Idempotency-Key`, so Stripe
 * answers a retry of an executed refund with its first result instead of
 * refunding again. A refund uses the sale's timeout.
 */
const REFUND_MAX_NETWORK_RETRIES = 2;

/**
 * Stripe behind the processor port. The adapter holds no credentials: every
 * call builds a client from the keys of the one account it acts for, and the
 * client is dropped when the call returns. No Stripe type leaves this package,
 * and no Stripe error message, which can repeat part of a key, is returned or
 * logged.
 */
export class StripeAdapter implements ProcessorAdapter {
  readonly provider = STRIPE_PROVIDER;
  readonly capabilities: ReadonlySet<ProcessorCapability> = new Set([
    'CREDENTIAL_VALIDATION',
    'SALE',
    'REFUND',
    'PARTIAL_REFUND',
    'TRANSACTION_LOOKUP',
    'PROVIDER_IDEMPOTENCY',
  ]);
  private readonly timeoutMs: number;
  private readonly saleTimeoutMs: number;

  constructor(options: StripeAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.saleTimeoutMs = options.saleTimeoutMs ?? DEFAULT_SALE_TIMEOUT_MS;
  }

  /** A client for one account's secret key, dropped when the call returns. */
  private client(
    secretKey: string,
    settings: { readonly timeout: number; readonly maxNetworkRetries: number },
  ): Stripe {
    return new Stripe(secretKey, {
      timeout: settings.timeout,
      maxNetworkRetries: settings.maxNetworkRetries,
      telemetry: false,
      appInfo: { name: 'MerchantFlow' },
    });
  }

  /**
   * Refuses live and malformed keys from their prefixes without calling
   * Stripe. Then it makes two reads with the secret key, which change nothing
   * at Stripe and are safe to repeat: `GET /v1/account` proves the key works
   * and returns the account ID, and `GET /v1/balance` returns `livemode`, which
   * the account object does not carry. A `livemode` of true is refused. The
   * publishable key is checked for format and mode only: Stripe documents no
   * read that tells which account a publishable key belongs to.
   */
  async validateCredentials(
    credentials: ProcessorCredentials,
  ): Promise<CredentialValidationResult> {
    const formatProblem =
      checkStripeKey(credentials.secretKey, 'secret') ??
      checkStripeKey(credentials.publishableKey, 'publishable');
    if (formatProblem !== undefined) {
      return { outcome: 'rejected', reason: formatProblem };
    }

    // Both calls are reads, so an automatic retry cannot duplicate anything.
    const client = this.client(credentials.secretKey, {
      timeout: this.timeoutMs,
      maxNetworkRetries: READ_MAX_NETWORK_RETRIES,
    });
    try {
      const account = await client.accounts.retrieveCurrent();
      const balance = await client.balance.retrieve();
      if (balance.livemode) {
        return { outcome: 'rejected', reason: 'LIVE_MODE_ACCOUNT' };
      }
      return { outcome: 'valid', providerAccountId: account.id };
    } catch (error) {
      return classifyStripeError(error);
    }
  }

  /**
   * Creates and confirms one PaymentIntent (`POST /v1/payment_intents` with
   * `confirm: true`) with automatic capture, for card payment methods only, so
   * no redirect-based method can be offered. `use_stripe_sdk: true` asks
   * Stripe to describe a 3D Secure step for Stripe.js, which runs it in the
   * page with `handleNextAction`. The operation ID is the idempotency key of
   * every try, and the merchant, intent, and attempt IDs are the metadata.
   *
   * Refused before any call, as `failed_before_execution`: a key that is not
   * a test secret key, a payment method that is not a `pm_` ID, and an amount
   * that `toStripeAmount` refuses.
   */
  async sale(input: SaleInput): Promise<ProcessorPaymentResult> {
    if (checkStripeKey(input.credentials.secretKey, 'secret') !== undefined) {
      return { status: 'failed_before_execution', category: 'CONFIGURATION' };
    }
    if (!PAYMENT_METHOD_ID.test(input.paymentMethod)) {
      return { status: 'failed_before_execution', category: 'INVALID_REQUEST' };
    }
    const amount = toStripeAmount(input.amount);
    if (!amount.ok) {
      return { status: 'failed_before_execution', category: 'INVALID_REQUEST' };
    }

    const client = this.client(input.credentials.secretKey, {
      timeout: this.saleTimeoutMs,
      maxNetworkRetries: SALE_MAX_NETWORK_RETRIES,
    });
    let intent: Stripe.PaymentIntent;
    try {
      intent = await client.paymentIntents.create(
        {
          amount: amount.amount,
          currency: amount.currency,
          payment_method: input.paymentMethod,
          // The SDK's API version (2026-10-28.endive) names the list of
          // accepted payment method types `allowed_payment_method_types`.
          allowed_payment_method_types: ['card'],
          capture_method: 'automatic',
          confirm: true,
          use_stripe_sdk: true,
          metadata: {
            merchant_id: input.references.merchantId,
            payment_intent_id: input.references.paymentIntentId,
            payment_attempt_id: input.references.paymentAttemptId,
          },
        },
        { idempotencyKey: input.operationId },
      );
    } catch (error) {
      return saleErrorResult(error);
    }
    return paymentIntentResult(intent);
  }

  /**
   * Retrieves one PaymentIntent by its ID (`GET /v1/payment_intents/:id`), a
   * read that changes nothing. A PaymentIntent in live mode is refused as an
   * unusable answer.
   */
  async getTransaction(
    input: GetTransactionInput,
  ): Promise<ProcessorTransactionLookup> {
    if (checkStripeKey(input.credentials.secretKey, 'secret') !== undefined) {
      return { outcome: 'unavailable', category: 'CONFIGURATION' };
    }
    if (!PAYMENT_INTENT_ID.test(input.providerTransactionId)) {
      return { outcome: 'unavailable', category: 'INVALID_REQUEST' };
    }
    const client = this.client(input.credentials.secretKey, {
      timeout: this.timeoutMs,
      maxNetworkRetries: READ_MAX_NETWORK_RETRIES,
    });
    let intent: Stripe.PaymentIntent;
    try {
      intent = await client.paymentIntents.retrieve(
        input.providerTransactionId,
      );
    } catch (error) {
      return lookupErrorResult(error);
    }
    if (intent.livemode) {
      return { outcome: 'unavailable', category: 'CONFIGURATION' };
    }
    return { outcome: 'found', result: paymentIntentResult(intent) };
  }

  /**
   * Creates one Refund of a PaymentIntent (`POST /v1/refunds` with
   * `payment_intent` and `amount`), with the refund's operation ID as the
   * idempotency key of every try and the merchant, intent, and refund IDs as
   * metadata. The PaymentIntent is expanded in the answer because the Refund
   * object carries no `livemode`: a refund of a live-mode PaymentIntent is
   * refused as `unknown`, since it may have moved real money.
   *
   * Refused before any call, as `failed`: a key that is not a test secret key
   * (`CONFIGURATION`), a transaction that is not a `pi_` ID, and an amount that
   * `toStripeAmount` refuses (`INVALID_REQUEST`).
   */
  async refund(input: RefundInput): Promise<ProcessorRefundResult> {
    if (checkStripeKey(input.credentials.secretKey, 'secret') !== undefined) {
      return {
        status: 'failed',
        providerRefundId: null,
        category: 'CONFIGURATION',
        failureCode: null,
      };
    }
    const amount = toStripeAmount(input.amount);
    if (!PAYMENT_INTENT_ID.test(input.providerTransactionId) || !amount.ok) {
      return {
        status: 'failed',
        providerRefundId: null,
        category: 'INVALID_REQUEST',
        failureCode: null,
      };
    }

    const client = this.client(input.credentials.secretKey, {
      timeout: this.saleTimeoutMs,
      maxNetworkRetries: REFUND_MAX_NETWORK_RETRIES,
    });
    let refund: Stripe.Refund;
    try {
      refund = await client.refunds.create(
        {
          payment_intent: input.providerTransactionId,
          amount: amount.amount,
          metadata: {
            merchant_id: input.references.merchantId,
            payment_intent_id: input.references.paymentIntentId,
            refund_id: input.references.refundId,
          },
          expand: ['payment_intent'],
        },
        { idempotencyKey: input.operationId },
      );
    } catch (error) {
      return refundErrorResult(error);
    }
    return refundResult(refund, {
      paymentIntentId: input.providerTransactionId,
      amount: amount.amount,
      currency: amount.currency,
    });
  }
}

/**
 * Turns a Stripe error into a validation outcome by its class alone; the
 * message is never read. An error that is not a Stripe error is a defect and
 * is thrown again.
 */
function classifyStripeError(error: unknown): CredentialValidationResult {
  if (error instanceof Stripe.errors.StripeAuthenticationError) {
    return { outcome: 'rejected', reason: 'AUTHENTICATION_FAILED' };
  }
  if (error instanceof Stripe.errors.StripePermissionError) {
    return { outcome: 'rejected', reason: 'PERMISSION_DENIED' };
  }
  if (error instanceof Stripe.errors.StripeConnectionError) {
    return { outcome: 'unavailable', category: 'NETWORK' };
  }
  if (
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    return { outcome: 'unavailable', category: 'GATEWAY' };
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return { outcome: 'unavailable', category: 'INVALID_REQUEST' };
  }
  if (error instanceof Stripe.errors.StripeError) {
    return { outcome: 'unavailable', category: 'UNKNOWN' };
  }
  throw error;
}
