import { randomUUID } from 'node:crypto';

/** Response header carrying the identifier generated for this request. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Request and response header carrying the identifier shared across a flow. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Accepted shape of an incoming correlation ID: 8 to 64 characters from
 * letters, digits, dot, underscore, and hyphen. A UUID fits. The bound and the
 * restricted alphabet keep log lines small and rule out control characters,
 * spaces, and delimiters that could forge fields in downstream log parsers.
 */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

/** Generates the identifier of a single request. */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Returns the incoming correlation ID when it passes the format check and
 * otherwise the fallback. A repeated header arrives as one comma-joined string
 * that fails the check, so duplicates are replaced rather than guessed at.
 */
export function resolveCorrelationId(
  incoming: string | string[] | undefined,
  fallback: string,
): string {
  if (typeof incoming === 'string' && CORRELATION_ID_PATTERN.test(incoming)) {
    return incoming;
  }
  return fallback;
}
