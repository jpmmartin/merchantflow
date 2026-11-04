import type { ProcessorErrorCategory } from './error-category.js';

/**
 * The credentials of one processor account, as the merchant entered them. The
 * secret key is held in memory only for the call that needs it; the
 * publishable key is not secret and is used by the browser card form.
 */
export interface ProcessorCredentials {
  readonly secretKey: string;
  readonly publishableKey: string;
}

/**
 * Why credentials were refused. None of them carries a provider message, which
 * could repeat part of a key.
 *
 * - `MALFORMED_KEY`: a key does not have the provider's format.
 * - `LIVE_MODE_KEY`: a key is a live-mode key; only test keys are accepted.
 * - `LIVE_MODE_ACCOUNT`: the provider reported live mode for the key.
 * - `AUTHENTICATION_FAILED`: the provider does not accept the secret key.
 * - `PERMISSION_DENIED`: the key is valid but may not read the account.
 */
export const CREDENTIAL_REJECTION_REASONS = [
  'MALFORMED_KEY',
  'LIVE_MODE_KEY',
  'LIVE_MODE_ACCOUNT',
  'AUTHENTICATION_FAILED',
  'PERMISSION_DENIED',
] as const;

export type CredentialRejectionReason =
  (typeof CREDENTIAL_REJECTION_REASONS)[number];

/**
 * The outcome of validating credentials.
 *
 * - `valid`: the provider accepted the secret key in test mode, and
 *   `providerAccountId` identifies the account it belongs to; it is display
 *   data, not a secret.
 * - `rejected`: the credentials cannot be used, for the given reason.
 * - `unavailable`: the provider could not give an answer, so the credentials
 *   are neither accepted nor refused and the caller may try again.
 */
export type CredentialValidationResult =
  | { readonly outcome: 'valid'; readonly providerAccountId: string }
  | {
      readonly outcome: 'rejected';
      readonly reason: CredentialRejectionReason;
    }
  | {
      readonly outcome: 'unavailable';
      readonly category: Exclude<ProcessorErrorCategory, 'ISSUER_DECLINE'>;
    };
