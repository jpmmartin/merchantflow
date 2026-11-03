import type { IncomingMessage, ServerResponse } from 'node:http';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule, type Params } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
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

export function createLoggerParams(
  level: Env['LOG_LEVEL'],
  destination: DestinationStream | null,
): Params {
  const options: Exclude<Params['pinoHttp'], DestinationStream | unknown[]> = {
    level,
    redact: { paths: REDACTED_PATHS, censor: '[Redacted]' },
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
    // Allowlist: only these fields are ever logged for a request and a
    // response. Headers, cookies, query strings, and bodies are never included.
    // These run for any `req` or `res` key, so they tolerate arbitrary shapes.
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
  return { pinoHttp: destination ? [options, destination] : options };
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
