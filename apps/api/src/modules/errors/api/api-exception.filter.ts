import type { IncomingMessage, ServerResponse } from 'node:http';
import { isDatabaseBusy } from '@merchantflow/database';
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { ApiException } from './api-exception.js';
import type { ErrorCode } from './error-codes.js';
import { replyWithError } from './error-reply.js';
import type { ValidationIssue } from './error-response.js';

/** How an exception is reported to the client, or that it must not be. */
type Outcome =
  | {
      readonly kind: 'expected';
      readonly status: number;
      readonly code: ErrorCode;
      readonly issues?: readonly ValidationIssue[] | undefined;
    }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unexpected' };

const BAD_REQUEST = 400;
const NOT_FOUND = 404;
const MAX_CLIENT_ERROR_STATUS = 499;

/**
 * Decides the public outcome of an exception. Only the exception's kind and
 * status are read, never its message. A Nest `HttpException` with a 4xx status
 * is a client error. A database checkout that found no free connection in time
 * ran nothing, so it is the retryable `SERVICE_BUSY`, whichever code path
 * waited. Every other exception, including a 5xx `HttpException`, is
 * unexpected and answered with a generic 500.
 */
function classify(exception: unknown): Outcome {
  if (isDatabaseBusy(exception)) {
    return { kind: 'busy' };
  }
  if (exception instanceof ApiException) {
    return {
      kind: 'expected',
      status: exception.getStatus(),
      code: exception.code,
      issues: exception.issues,
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === NOT_FOUND) {
      return { kind: 'expected', status, code: 'NOT_FOUND' };
    }
    if (status >= BAD_REQUEST && status <= MAX_CLIENT_ERROR_STATUS) {
      return { kind: 'expected', status, code: 'REQUEST_REJECTED' };
    }
    return { kind: 'unexpected' };
  }
  return { kind: 'unexpected' };
}

/**
 * Turns every exception into the one error shape. Responses carry a fixed
 * message per code, so no framework, parser, or internal text reaches the
 * client. A busy database is logged as a warning, since it means the pool is
 * too small for the load. An unexpected exception is logged once with its
 * stack and the correlation ID, and answered with a generic 500.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ApiExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<IncomingMessage>();
    const response = http.getResponse<ServerResponse>();
    const { httpAdapter } = this.httpAdapterHost;

    const outcome = classify(exception);
    switch (outcome.kind) {
      case 'expected':
        replyWithError(httpAdapter, request, response, outcome.code, {
          status: outcome.status,
          issues: outcome.issues,
        });
        return;
      case 'busy':
        this.logger.warn('No database connection became free in time');
        replyWithError(httpAdapter, request, response, 'SERVICE_BUSY');
        return;
      case 'unexpected':
        this.logger.error({ err: exception }, 'Unhandled exception');
        replyWithError(httpAdapter, request, response, 'INTERNAL_ERROR');
        return;
    }
  }
}
