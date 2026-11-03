import type { IncomingMessage, ServerResponse } from 'node:http';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ensureCorrelationId } from '../errors/api/error-reply.js';

/**
 * Gives a handler the correlation ID of its request: the value of the
 * `X-Correlation-Id` response header, which is the client's valid incoming ID
 * or a generated one. It is what use cases record on audit events.
 */
export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const http = context.switchToHttp();
    return ensureCorrelationId(
      http.getRequest<IncomingMessage>(),
      http.getResponse<ServerResponse>(),
    );
  },
);
