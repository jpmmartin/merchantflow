import type {
  CredentialValidationResult,
  ProcessorAdapter,
  ProcessorCapability,
  ProcessorCredentials,
} from '@merchantflow/processor-contracts';
import Stripe from 'stripe';
import { checkStripeKey } from './stripe-keys.js';

/** Provider code of the Stripe adapter. */
export const STRIPE_PROVIDER = 'stripe';

export interface StripeAdapterOptions {
  /** Longest time one request to Stripe may take, in milliseconds. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

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
  ]);
  private readonly timeoutMs: number;

  constructor(options: StripeAdapterOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

    const client = new Stripe(credentials.secretKey, {
      timeout: this.timeoutMs,
      // Both calls are reads, so one automatic retry cannot duplicate anything.
      maxNetworkRetries: 1,
      telemetry: false,
      appInfo: { name: 'MerchantFlow' },
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
