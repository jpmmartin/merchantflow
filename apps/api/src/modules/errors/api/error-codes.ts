/**
 * Stable machine-readable error codes. A code is part of the public API
 * contract: it is never renamed or reused for another meaning, and clients may
 * branch on it. Each code has one fixed safe message.
 */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'MALFORMED_JSON',
  'NOT_FOUND',
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
  NOT_FOUND: {
    status: 404,
    message: 'The requested resource was not found.',
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
