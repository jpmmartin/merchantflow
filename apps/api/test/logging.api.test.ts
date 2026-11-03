import type { Server } from 'node:http';
import { Logger as NestLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Logger, PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// The configuration is validated when the application module is imported, so
// the level must be set before the static imports below are evaluated.
vi.hoisted(() => {
  vi.stubEnv('LOG_LEVEL', 'info');
});

import { AppModule } from '../src/app.module.js';
import { LOG_DESTINATION } from '../src/modules/logging/logging.module.js';
import { GetLivenessService } from '../src/modules/health/application/get-liveness.service.js';

interface LogLine {
  level: number;
  msg?: string;
  requestId?: string;
  correlationId?: string;
  req?: Record<string, unknown>;
  res?: Record<string, unknown>;
  [key: string]: unknown;
}

const VALID_ID = 'client-flow-0001';
const AUTHORIZATION_VALUE = 'Bearer distinctive-token-9f3a7c';
const COOKIE_VALUE = 'session=distinctive-cookie-51d2b8';
const APP_LOG_MESSAGE = 'liveness checked by application code';

describe('structured logging', () => {
  let app: INestApplication;
  let server: Server;
  let output: string[];

  const lines = (): LogLine[] =>
    output
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogLine);

  beforeAll(async () => {
    output = [];
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOG_DESTINATION)
      .useValue({ write: (chunk: string) => void output.push(chunk) })
      .overrideProvider(GetLivenessService)
      .useFactory({
        inject: [PinoLogger],
        // Stand-in for application code that logs while handling a request.
        factory: (logger: PinoLogger) => ({
          execute: () => {
            logger.info(APP_LOG_MESSAGE);
            return { status: 'ok' };
          },
        }),
      })
      .compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    app.useLogger(app.get(Logger));
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    output.length = 0;
  });

  describe('correlation ID', () => {
    it('reuses a valid incoming value and returns it', async () => {
      const response = await request(server)
        .get('/health/live')
        .set('X-Correlation-Id', VALID_ID);

      expect(response.headers['x-correlation-id']).toBe(VALID_ID);
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.headers['x-request-id']).not.toBe(VALID_ID);
    });

    it('generates a value when none is sent and returns it', async () => {
      const response = await request(server).get('/health/live');

      expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it.each([
      ['too short', 'short'],
      ['oversized', 'a'.repeat(65)],
      ['with a space', 'has a space in it'],
      ['with forbidden characters', 'abc<script>12345'],
    ])('replaces an incoming value that is %s', async (_label, value) => {
      const response = await request(server)
        .get('/health/live')
        .set('X-Correlation-Id', value);

      const returned = response.headers['x-correlation-id'];
      expect(returned).toMatch(/^[0-9a-f-]{36}$/);
      expect(returned).not.toBe(value);
      expect(lines().some((l) => JSON.stringify(l).includes(value))).toBe(
        false,
      );
    });

    it('never trusts an incoming request ID', async () => {
      const response = await request(server)
        .get('/health/live')
        .set('X-Request-Id', VALID_ID);

      expect(response.headers['x-request-id']).not.toBe(VALID_ID);
    });
  });

  describe('log lines', () => {
    it('emits one access line per request with both identifiers', async () => {
      const response = await request(server)
        .get('/health/live?token=query-secret-77')
        .set('X-Correlation-Id', VALID_ID);

      const access = lines().filter((l) => l.res !== undefined);
      expect(access).toHaveLength(1);
      expect(access[0]).toMatchObject({
        requestId: response.headers['x-request-id'],
        correlationId: VALID_ID,
        req: { method: 'GET', path: '/health/live' },
        res: { statusCode: 200 },
      });
      expect(output.join('')).not.toContain('query-secret-77');
    });

    it('emits one access line for each of several requests', async () => {
      await request(server).get('/health/live');
      await request(server).get('/health/live');
      await request(server).get('/missing');

      expect(lines().filter((l) => l.res !== undefined)).toHaveLength(3);
    });

    it('gives application logs the request correlation and request IDs', async () => {
      const response = await request(server)
        .get('/health/live')
        .set('X-Correlation-Id', VALID_ID);

      const applicationLogs = lines().filter((l) => l.msg === APP_LOG_MESSAGE);
      const access = lines().filter((l) => l.res !== undefined);
      expect(applicationLogs).toHaveLength(1);
      expect(applicationLogs[0]).toMatchObject({
        correlationId: VALID_ID,
        requestId: response.headers['x-request-id'],
      });
      expect(applicationLogs[0]?.correlationId).toBe(access[0]?.correlationId);
      expect(applicationLogs[0]?.requestId).toBe(access[0]?.requestId);
    });

    it('keeps concurrent requests apart', async () => {
      const ids = ['flow-aaaaaaaa', 'flow-bbbbbbbb', 'flow-cccccccc'];
      await Promise.all(
        ids.map((id) =>
          request(server).get('/health/live').set('X-Correlation-Id', id),
        ),
      );

      const byRequest = new Map<string, Set<string>>();
      for (const line of lines()) {
        if (line.requestId && line.correlationId) {
          byRequest.set(
            line.requestId,
            (byRequest.get(line.requestId) ?? new Set()).add(
              line.correlationId,
            ),
          );
        }
      }
      expect(byRequest.size).toBe(3);
      for (const correlationIds of byRequest.values()) {
        expect(correlationIds.size).toBe(1);
      }
      expect(new Set([...byRequest.values()].map((s) => [...s][0]))).toEqual(
        new Set(ids),
      );
    });

    it('routes Nest logger output through Pino as JSON', () => {
      new NestLogger('Bootstrap').log('nest message through pino');

      expect(lines()).toContainEqual(
        expect.objectContaining({ msg: 'nest message through pino' }),
      );
    });
  });

  describe('redaction', () => {
    it('never logs the Authorization header or cookie values', async () => {
      await request(server)
        .get('/health/live')
        .set('Authorization', AUTHORIZATION_VALUE)
        .set('Cookie', COOKIE_VALUE);

      const raw = output.join('');
      expect(raw.length).toBeGreaterThan(0);
      expect(raw).not.toContain('distinctive-token-9f3a7c');
      expect(raw).not.toContain('distinctive-cookie-51d2b8');
      expect(raw.toLowerCase()).not.toContain('authorization');
      expect(raw.toLowerCase()).not.toContain('cookie');
    });

    it('drops headers from req and res objects that application code logs', async () => {
      const logger = await app.resolve(PinoLogger);
      logger.info(
        {
          req: { headers: { authorization: AUTHORIZATION_VALUE } },
          res: { headers: { 'set-cookie': ['sid=distinctive-setcookie-6e1'] } },
        },
        'request and response logged by mistake',
      );

      const raw = output.join('');
      expect(raw).toContain('request and response logged by mistake');
      expect(raw).not.toContain('distinctive-token-9f3a7c');
      expect(raw).not.toContain('distinctive-setcookie-6e1');
    });

    it('redacts a header map that application code logs', async () => {
      const logger = await app.resolve(PinoLogger);
      logger.info(
        {
          headers: {
            authorization: AUTHORIZATION_VALUE,
            cookie: COOKIE_VALUE,
            'set-cookie': ['sid=distinctive-setcookie-6e1'],
          },
        },
        'header map logged by mistake',
      );

      const raw = output.join('');
      expect(raw).toContain('[Redacted]');
      expect(raw).not.toContain('distinctive-token-9f3a7c');
      expect(raw).not.toContain('distinctive-cookie-51d2b8');
      expect(raw).not.toContain('distinctive-setcookie-6e1');
    });
  });
});
