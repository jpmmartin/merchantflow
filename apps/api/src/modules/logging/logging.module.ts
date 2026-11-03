import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule, PinoLogger, type Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { pinoHttp, type HttpLogger, type Options } from 'pino-http';
import type { Env } from '../config/env.schema.js';
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  generateRequestId,
  resolveCorrelationId,
} from './correlation.js';

/**
 * Where log lines are written. It is `null` in the application, which selects
 * Pino's default (standard output), and tests override it to capture output.
 */
export const LOG_DESTINATION = Symbol('LOG_DESTINATION');

@Module({
  providers: [{ provide: LOG_DESTINATION, useValue: null }],
  exports: [LOG_DESTINATION],
})
class LogDestinationModule {}

/**
 * Header and field paths removed from any logged object. The serializers below
 * already allowlist what the access log contains; this second layer covers
 * application code that logs a request, a response, or a header map.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
];

/** True for the error pino-http makes up when a response has a 5xx status. */
function isPlaceholderError(error: Error, statusCode: number): boolean {
  return error.message === `failed with status code ${statusCode}`;
}

/**
 * How a request is identified and what its access line contains. Everything
 * here is independent of configuration, so the same options serve the logging
 * middleware and the fallback for requests that middleware does not cover.
 */
const ACCESS_LOG_OPTIONS: Options = {
  // The request ID is always generated here. The correlation ID is stored in
  // the response header so that `customProps` and the client see one value.
  genReqId: (req: IncomingMessage, res: ServerResponse) => {
    const requestId = generateRequestId();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.setHeader(
      CORRELATION_ID_HEADER,
      resolveCorrelationId(req.headers[CORRELATION_ID_HEADER], requestId),
    );
    return requestId;
  },
  // Bound to the request logger, so every log line written while the request
  // is handled carries both identifiers.
  customProps: (req: IncomingMessage, res: ServerResponse) => ({
    requestId: req.id,
    correlationId: String(res.getHeader(CORRELATION_ID_HEADER)),
  }),
  // A 5xx response makes pino-http attach an error it creates itself, with a
  // stack that points at its own code. The real error is logged once, with its
  // true stack, by the exception filter, so the access line omits that
  // placeholder and keeps any genuine error (a failed response stream).
  customErrorObject: (_req, res, error, values: Record<string, unknown>) =>
    isPlaceholderError(error, res.statusCode)
      ? { res: values['res'], responseTime: values['responseTime'] }
      : values,
  customErrorMessage: () => 'request completed',
  // Allowlist: only these fields are ever logged for a request and a response.
  // Headers, cookies, query strings, and bodies are never included. These run
  // for any `req` or `res` key, so they tolerate arbitrary shapes.
  serializers: {
    req: (req: Partial<Record<'method' | 'url', unknown>>) => ({
      method: typeof req.method === 'string' ? req.method : undefined,
      path: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
    }),
    res: (res: Partial<Record<'statusCode', unknown>>) => ({
      statusCode:
        typeof res.statusCode === 'number' ? res.statusCode : undefined,
    }),
  },
};

export function createLoggerParams(
  level: Env['LOG_LEVEL'],
  destination: DestinationStream | null,
): Params {
  const options: Options = {
    ...ACCESS_LOG_OPTIONS,
    level,
    redact: { paths: REDACTED_PATHS, censor: '[Redacted]' },
  };
  return { pinoHttp: destination ? [options, destination] : options };
}

/**
 * Access-log middleware for the requests the module middleware cannot see.
 * Nest applies the global prefix to that middleware, so a path outside the
 * prefix that no route claims would otherwise leave no access line. It writes
 * through the application's own logger, so level, destination, and fields are
 * the same. Call it only after the application has been initialized.
 */
export function createUnmatchedRequestLogger(): HttpLogger {
  return pinoHttp({ ...ACCESS_LOG_OPTIONS, logger: PinoLogger.root });
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [LogDestinationModule],
      inject: [ConfigService, LOG_DESTINATION],
      useFactory: (
        config: ConfigService<Env, true>,
        destination: DestinationStream | null,
      ) =>
        createLoggerParams(
          config.get('LOG_LEVEL', { infer: true }),
          destination,
        ),
    }),
  ],
})
export class LoggingModule {}
