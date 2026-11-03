import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HttpServer } from '@nestjs/common';
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  generateRequestId,
  resolveCorrelationId,
} from '../../logging/correlation.js';
import { ERROR_DEFINITIONS, type ErrorCode } from './error-codes.js';
import type { ErrorResponse, ValidationIssue } from './error-response.js';

/**
 * Returns the correlation ID of the response. The logging middleware sets it
 * for every request it handles; a request rejected before that middleware ran
 * (for instance by the body parser) gets the same identifiers assigned here.
 */
export function ensureCorrelationId(
  request: IncomingMessage,
  response: ServerResponse,
): string {
  const existing = response.getHeader(CORRELATION_ID_HEADER);
  if (typeof existing === 'string') return existing;
  const requestId = generateRequestId();
  const correlationId = resolveCorrelationId(
    request.headers[CORRELATION_ID_HEADER],
    requestId,
  );
  response.setHeader(REQUEST_ID_HEADER, requestId);
  response.setHeader(CORRELATION_ID_HEADER, correlationId);
  return correlationId;
}

/**
 * Sends the error shape for a code, with the status and message the code
 * defines. `status` overrides the code's status for the codes that cover
 * several statuses.
 */
export function replyWithError(
  httpAdapter: HttpServer,
  request: IncomingMessage,
  response: ServerResponse,
  code: ErrorCode,
  options: {
    readonly status?: number | undefined;
    readonly issues?: readonly ValidationIssue[] | undefined;
  } = {},
): void {
  const definition = ERROR_DEFINITIONS[code];
  const body: ErrorResponse = {
    error: {
      code,
      message: definition.message,
      correlationId: ensureCorrelationId(request, response),
      ...(options.issues === undefined ? {} : { issues: [...options.issues] }),
    },
  };
  if (response.headersSent) return;
  httpAdapter.reply(response, body, options.status ?? definition.status);
}
