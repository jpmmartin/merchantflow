import type { ErrorCode } from './error-codes.js';

/**
 * Returns the code for an error raised by the JSON body parser, or `undefined`
 * for any other error. The parser's errors are `http-errors` objects that carry
 * a `type`; only these known types are recognized, so an unrelated error that
 * merely has a status property (a provider SDK error, say) is never reported as
 * a client error.
 */
export function bodyParserErrorCode(error: unknown): ErrorCode | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  switch ((error as { type?: unknown }).type) {
    case 'entity.parse.failed':
      return 'MALFORMED_JSON';
    case 'entity.too.large':
      return 'PAYLOAD_TOO_LARGE';
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return 'UNSUPPORTED_MEDIA_TYPE';
    case 'request.aborted':
    case 'request.size.invalid':
      return 'REQUEST_REJECTED';
    default:
      return undefined;
  }
}
