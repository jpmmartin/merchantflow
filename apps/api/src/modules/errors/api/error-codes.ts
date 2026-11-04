/**
 * Stable machine-readable error codes. A code is part of the public API
 * contract: it is never renamed or reused for another meaning, and clients may
 * branch on it. Each code has one fixed safe message.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'MALFORMED_JSON',
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'INSUFFICIENT_ROLE',
  'SESSION_REQUIRED',
  'NOT_FOUND',
  'MERCHANT_TRANSITION_NOT_ALLOWED',
  'MERCHANT_STATUS_CONFLICT',
  'USER_EMAIL_TAKEN',
  'USER_SELF_DISABLE_NOT_ALLOWED',
  'IDEMPOTENCY_KEY_MISSING',
  'IDEMPOTENCY_KEY_INVALID',
  'IDEMPOTENCY_KEY_REUSED',
  'OPERATION_IN_PROGRESS',
  'OPERATION_TIMEOUT',
  'SERVICE_BUSY',
  'MERCHANT_NOT_ACTIVE',
  'MERCHANT_CURRENCY_MISMATCH',
  'DUPLICATE_MERCHANT_REFERENCE',
  'PROCESSOR_PROVIDER_UNSUPPORTED',
  'PROCESSOR_LIVE_CREDENTIALS_REJECTED',
  'PROCESSOR_CREDENTIALS_INVALID',
  'PROCESSOR_ACCOUNT_ALREADY_CONNECTED',
  'PROCESSOR_ACCOUNT_DISABLED',
  'PROCESSOR_UNAVAILABLE',
  'CREDENTIALS_KEY_NOT_CONFIGURED',
  'PAYMENT_OUTCOME_UNKNOWN',
  'PAYMENT_ATTEMPT_IN_PROGRESS',
  'PAYMENT_INTENT_NOT_CONFIRMABLE',
  'PAYMENT_ACTION_NOT_PENDING',
  'PROCESSOR_ACCOUNT_NOT_FOUND',
  'PROCESSOR_ACCOUNT_NOT_DEFAULT',
  'PROCESSOR_LOOKUP_UNAVAILABLE',
  'PAYMENT_INTENT_NOT_REFUNDABLE',
  'REFUND_AMOUNT_EXCEEDS_REFUNDABLE',
  'REFUND_OUTCOME_UNKNOWN',
  'PUBLIC_BASE_URL_NOT_CONFIGURED',
  'WEBHOOK_ENDPOINT_REJECTED',
  'WEBHOOK_PROVIDER_UNAVAILABLE',
  'WEBHOOK_CONFIGURATION_CHANGED',
  'WEBHOOK_REJECTED',
  'WEBHOOK_PROCESSING_FAILED',
  'REFUND_NOT_REFRESHABLE',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'REQUEST_REJECTED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface ErrorDefinition {
  /** HTTP status sent with the code. */
  readonly status: number;
  /** Human-readable text that is safe to show to any caller. */
  readonly message: string;
  /** Headers that always accompany the code, such as `WWW-Authenticate`. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * The status and message of every code. Messages are written here and never
 * built from an exception, a parser, or user input, so nothing internal or
 * received can reach a response through them.
 */
export const ERROR_DEFINITIONS: Readonly<Record<ErrorCode, ErrorDefinition>> = {
  VALIDATION_FAILED: {
    status: 400,
    message: 'The request does not match the expected format.',
  },
  MALFORMED_JSON: {
    status: 400,
    message: 'The request body is not valid JSON.',
  },
  // One message and one challenge for every authentication failure, so the
  // response never tells a missing key from a malformed, unknown, wrong, or
  // revoked one. The challenge carries no `error` parameter for the same reason.
  UNAUTHENTICATED: {
    status: 401,
    message: 'A valid API key is required.',
    headers: { 'WWW-Authenticate': 'Bearer' },
  },
  // One answer for every failed sign-in: an unknown email, a wrong password,
  // and a disabled user are not told apart.
  INVALID_CREDENTIALS: {
    status: 401,
    message: 'The email or password is incorrect.',
    headers: { 'WWW-Authenticate': 'Bearer' },
  },
  INSUFFICIENT_ROLE: {
    status: 403,
    message: 'The API key role does not allow this operation.',
  },
  // Sign-out ends a user session; an API key is revoked through its own
  // endpoint instead.
  SESSION_REQUIRED: {
    status: 403,
    message: 'This operation applies only to a signed-in user session.',
  },
  NOT_FOUND: {
    status: 404,
    message: 'The requested resource was not found.',
  },
  // The merchant's current status does not allow the requested one, including
  // asking for the status it already has.
  MERCHANT_TRANSITION_NOT_ALLOWED: {
    status: 409,
    message: 'The merchant status cannot change to the requested status.',
  },
  // Another request changed the merchant's status after this one read it, so
  // nothing was changed. Reading the merchant again shows the new status.
  MERCHANT_STATUS_CONFLICT: {
    status: 409,
    message: 'The merchant status was changed by another request.',
  },
  // Another user, of any merchant or of the platform, already signs in with
  // this email, which is unique across the platform. The answer reveals that
  // the address is registered.
  USER_EMAIL_TAKEN: {
    status: 409,
    message: 'A user with this email already exists.',
  },
  // A signed-in user asked to disable itself, which would end its own access.
  USER_SELF_DISABLE_NOT_ALLOWED: {
    status: 409,
    message: 'A user cannot disable itself.',
  },
  // A command was sent without the Idempotency-Key header it requires.
  IDEMPOTENCY_KEY_MISSING: {
    status: 400,
    message: 'The Idempotency-Key header is required.',
  },
  // The header is present but is not 1 to 255 visible ASCII characters.
  IDEMPOTENCY_KEY_INVALID: {
    status: 400,
    message:
      'The Idempotency-Key header must be 1 to 255 visible ASCII characters.',
  },
  // The key was already used by this merchant for a different request.
  IDEMPOTENCY_KEY_REUSED: {
    status: 409,
    message: 'The Idempotency-Key was already used for a different request.',
  },
  // The same request under the same key has not finished yet, or its outcome
  // is not known yet. Retrying the same request later returns its result.
  OPERATION_IN_PROGRESS: {
    status: 409,
    message: 'A request with this Idempotency-Key is still in progress.',
    headers: { 'Retry-After': '1' },
  },
  // The command waited too long for a resource that another request was
  // holding and gave up; nothing of it was stored, so the same request with the
  // same key can be sent again.
  OPERATION_TIMEOUT: {
    status: 503,
    message:
      'The operation could not be completed in time. Nothing was changed; retry the same request.',
    headers: { 'Retry-After': '1' },
  },
  // Every database connection stayed busy for the whole wait, so the request
  // ran nothing on the database: it changed nothing and can be sent again.
  SERVICE_BUSY: {
    status: 503,
    message:
      'The service is busy. Nothing was changed; retry the same request.',
    headers: { 'Retry-After': '1' },
  },
  // Payment commands require an ACTIVE merchant.
  MERCHANT_NOT_ACTIVE: {
    status: 403,
    message: 'The merchant must be active to run payment commands.',
  },
  // The request names a currency other than the merchant's default currency,
  // which is fixed at creation.
  MERCHANT_CURRENCY_MISMATCH: {
    status: 422,
    message: "The currency does not match the merchant's default currency.",
  },
  // The merchant already has a payment intent with this merchant_reference,
  // created under another Idempotency-Key.
  DUPLICATE_MERCHANT_REFERENCE: {
    status: 409,
    message: 'A payment intent with this merchant_reference already exists.',
  },
  // No adapter is registered for the provider code, or the adapter cannot
  // validate credentials.
  PROCESSOR_PROVIDER_UNSUPPORTED: {
    status: 422,
    message: 'The processor provider is not supported.',
  },
  // A key is a live-mode key, or the provider reported live mode for it. Only
  // test-mode credentials are accepted; nothing is stored.
  PROCESSOR_LIVE_CREDENTIALS_REJECTED: {
    status: 422,
    message: 'Live-mode credentials are not accepted; use test-mode keys.',
  },
  // A key has the wrong format, or the provider does not accept the secret
  // key or does not let it read the account. The provider's own message is
  // never returned, because it can repeat part of the key.
  PROCESSOR_CREDENTIALS_INVALID: {
    status: 422,
    message: 'The processor credentials are not valid.',
  },
  // The merchant already has this provider account connected and enabled.
  PROCESSOR_ACCOUNT_ALREADY_CONNECTED: {
    status: 409,
    message: 'This processor account is already connected to the merchant.',
  },
  // A disabled processor account cannot become the default.
  PROCESSOR_ACCOUNT_DISABLED: {
    status: 409,
    message: 'The processor account is disabled.',
  },
  // The provider could not be reached or gave no usable answer while the
  // credentials were validated. Nothing was stored; the request can be sent
  // again.
  PROCESSOR_UNAVAILABLE: {
    status: 503,
    message:
      'The processor could not validate the credentials. Nothing was changed; retry later.',
  },
  // The master key that encrypts processor secrets is not configured, so no
  // account can be connected and no account's secret can be used.
  CREDENTIALS_KEY_NOT_CONFIGURED: {
    status: 503,
    message:
      'Processor accounts cannot be connected or used until the credentials master key is configured.',
  },
  // An attempt of the payment intent may have charged and its outcome is not
  // known yet, so no new attempt can start under any key until it is
  // resolved. Paying again could charge twice.
  PAYMENT_OUTCOME_UNKNOWN: {
    status: 409,
    message:
      'A previous attempt of this payment has an unknown outcome; do not pay again until it is resolved.',
  },
  // Another attempt of the payment intent is executing or waits for the
  // customer's action, such as 3D Secure.
  PAYMENT_ATTEMPT_IN_PROGRESS: {
    status: 409,
    message: 'Another attempt of this payment is still in progress.',
  },
  // The payment intent is in a final status (SUCCEEDED, FAILED,
  // PARTIALLY_REFUNDED, or REFUNDED); none accepts a new attempt.
  PAYMENT_INTENT_NOT_CONFIRMABLE: {
    status: 409,
    message: 'The payment is in a final status and cannot be confirmed.',
  },
  // A completion was requested for a payment intent that is not waiting for
  // customer action, for example because its result was already applied.
  PAYMENT_ACTION_NOT_PENDING: {
    status: 409,
    message: 'The payment is not waiting for customer action.',
  },
  // The processor account named by the request does not exist for the
  // merchant; another merchant's account is answered the same way.
  PROCESSOR_ACCOUNT_NOT_FOUND: {
    status: 422,
    message: 'The processor account was not found for this merchant.',
  },
  // A new payment uses only the merchant's default processor account.
  PROCESSOR_ACCOUNT_NOT_DEFAULT: {
    status: 409,
    message: "The processor account is not the merchant's default account.",
  },
  // The provider could not report the payment's current state. Nothing was
  // changed; the request can be sent again.
  PROCESSOR_LOOKUP_UNAVAILABLE: {
    status: 503,
    message:
      'The processor could not report the payment status. Nothing was changed; retry later.',
  },
  // Only a captured payment that is not fully refunded can be refunded: the
  // payment intent must be SUCCEEDED or PARTIALLY_REFUNDED.
  PAYMENT_INTENT_NOT_REFUNDABLE: {
    status: 409,
    message:
      'The payment cannot be refunded: only a captured payment that is not fully refunded can be.',
  },
  // The requested amount is above what can still be refunded: the captured
  // amount minus the refunds that succeeded or are still in progress.
  REFUND_AMOUNT_EXCEEDS_REFUNDABLE: {
    status: 409,
    message:
      'The refund amount is above the amount that can still be refunded, which counts refunds still in progress.',
  },
  // A refund of the payment intent may have returned money and its outcome is
  // not known yet, so no new refund can start under any key until it is
  // resolved. Refunding again could refund twice.
  REFUND_OUTCOME_UNKNOWN: {
    status: 409,
    message:
      'An earlier refund of this payment has an unknown outcome; do not refund again until it is resolved.',
  },
  // The API has no public base URL (PUBLIC_API_BASE_URL), so no webhook
  // endpoint can be registered at a provider.
  PUBLIC_BASE_URL_NOT_CONFIGURED: {
    status: 503,
    message:
      'Webhooks cannot be configured automatically until the public base URL of the API is configured.',
  },
  // The provider refused to create the webhook endpoint, for example because
  // of its URL. Nothing was stored.
  WEBHOOK_ENDPOINT_REJECTED: {
    status: 422,
    message: 'The processor refused the webhook endpoint. Nothing was stored.',
  },
  // The provider gave no usable answer while a webhook endpoint was created or
  // deleted. The configuration was not changed.
  WEBHOOK_PROVIDER_UNAVAILABLE: {
    status: 503,
    message:
      'The processor did not confirm the webhook change. The configuration was not changed; retry later.',
  },
  // Another change of the same webhook configuration was stored first.
  WEBHOOK_CONFIGURATION_CHANGED: {
    status: 409,
    message:
      'The webhook configuration changed while this request ran. Nothing was stored; read it again.',
  },
  // A webhook delivery that cannot be verified: the same answer whatever the
  // reason, so it reveals nothing about the account or the signature.
  WEBHOOK_REJECTED: {
    status: 400,
    message: 'The webhook request was rejected.',
  },
  // A verified event was stored but could not be processed yet; the provider
  // delivers it again later, and it is processed then.
  WEBHOOK_PROCESSING_FAILED: {
    status: 503,
    message:
      'The event was received but not processed. Deliver it again later.',
  },
  // The refund cannot be checked with the processor: it is still executing,
  // or the processor never identified it.
  REFUND_NOT_REFRESHABLE: {
    status: 409,
    message:
      'The refund cannot be checked with the processor yet: it is still executing or has no processor identifier.',
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    message: 'The request body is too large.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: 'The request body encoding is not supported.',
  },
  REQUEST_REJECTED: {
    status: 400,
    message: 'The request could not be processed.',
  },
  INTERNAL_ERROR: {
    status: 500,
    message: 'An internal error occurred.',
  },
};
