import type { IncomingMessage } from 'node:http';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ApiException } from '../../errors/api/api-exception.js';

/** Name of the header that carries a command's idempotency key. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * The format the store accepts (`idempotency_records_idempotency_key_check`):
 * 1 to 255 visible ASCII characters, so no space, control character, or
 * character outside ASCII, and so nothing to trim or normalize.
 */
const IDEMPOTENCY_KEY_FORMAT = /^[!-~]{1,255}$/;

/**
 * Validates the `Idempotency-Key` header of a request and returns it unchanged.
 * A missing header is `IDEMPOTENCY_KEY_MISSING` and a header outside the format
 * is `IDEMPOTENCY_KEY_INVALID`, both 400; neither response repeats the value.
 * Node.js joins repeated headers with `, `, which contains a space, so a key
 * sent twice is invalid rather than silently picked.
 *
 * Declare it as the first parameter of a handler: an extractor that throws is
 * reported before the body is validated, so a request without a key gets this
 * answer whatever its body.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const value = context.switchToHttp().getRequest<IncomingMessage>().headers[
      IDEMPOTENCY_KEY_HEADER.toLowerCase()
    ];
    if (value === undefined) throw new ApiException('IDEMPOTENCY_KEY_MISSING');
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_FORMAT.test(value)) {
      throw new ApiException('IDEMPOTENCY_KEY_INVALID');
    }
    return value;
  },
);
