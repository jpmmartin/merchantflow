/**
 * A provider account a merchant connected, as the application and the API see
 * it. It never holds the secret key: only its last four characters as a hint.
 */
export interface ProcessorAccount {
  readonly id: string;
  readonly merchantId: string;
  /** Provider code of the adapter, for example `stripe`. */
  readonly provider: string;
  readonly displayName: string;
  /** Identifier of the account at the provider; display data, not a secret. */
  readonly providerAccountId: string;
  /** Not a secret: the browser card form needs it. */
  readonly publishableKey: string;
  /** Last four characters of the secret key. */
  readonly secretKeyHint: string;
  readonly enabled: boolean;
  /** The account payments use; at most one per merchant, and only an enabled one. */
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Number of trailing characters of the secret key kept as its hint. */
export const SECRET_KEY_HINT_LENGTH = 4;

export function secretKeyHintOf(secretKey: string): string {
  return secretKey.slice(-SECRET_KEY_HINT_LENGTH);
}

/** How an account's webhook was configured. */
export const WEBHOOK_MODES = ['AUTOMATIC', 'MANUAL'] as const;

export type WebhookMode = (typeof WEBHOOK_MODES)[number];

/**
 * The webhook configuration of a processor account as the application and
 * the API see it. It never holds the signing secret: only its last four
 * characters as a hint.
 */
export interface ProcessorAccountWebhook {
  readonly mode: WebhookMode;
  readonly signingSecretHint: string;
  /** The provider's endpoint the platform created; `null` for `MANUAL`. */
  readonly endpointId: string | null;
  readonly configuredAt: Date;
}

/** Number of trailing characters of the signing secret kept as its hint. */
export const SIGNING_SECRET_HINT_LENGTH = 4;

export function signingSecretHintOf(signingSecret: string): string {
  return signingSecret.slice(-SIGNING_SECRET_HINT_LENGTH);
}
