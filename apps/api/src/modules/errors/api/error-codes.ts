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
  'IDEMPOTENCY_KEY_MISSING',
  'IDEMPOTENCY_KEY_INVALID',
  'IDEMPOTENCY_KEY_REUSED',
  'OPERATION_IN_PROGRESS',
  'OPERATION_TIMEOUT',
  'SERVICE_BUSY',
  'MERCHANT_NOT_ACTIVE',
  'MERCHANT_CURRENCY_MISMATCH',
  'DUPLICATE_MERCHANT_REFERENCE',
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
