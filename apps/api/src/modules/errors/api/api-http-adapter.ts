import { ExpressAdapter } from '@nestjs/platform-express';
import { ApiException } from './api-exception.js';
import { bodyParserErrorCode } from './body-parser-error.js';

/**
 * Express adapter that gives body-parser failures their own error code.
 * Nest's default mapping turns a JSON syntax error into a `BadRequestException`
 * that keeps only the parser's message, so the filter could not tell malformed
 * JSON from any other bad request. `mapException` is the adapter hook that
 * runs before the exception filters, and the original error is still intact
 * there.
 */
export class ApiHttpAdapter extends ExpressAdapter {
  override mapException(error: unknown): unknown {
    const code = bodyParserErrorCode(error);
    return code === undefined
      ? super.mapException(error)
      : new ApiException(code);
  }
}
