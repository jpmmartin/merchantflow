import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_DEFINITIONS,
} from '../src/modules/errors/api/error-codes.js';
import {
  errorResponseSchema,
  type ErrorResponse,
} from '../src/modules/errors/api/error-response.js';
import {
  INTERNAL_FAILURE_MESSAGE,
  ProbeController,
} from './support/probe.controller.js';
import { startApp, type LogLine } from './support/start-app.js';

// Nothing listens on this port, so the readiness check reports the database
// as unavailable without any container.
const UNREACHABLE_DATABASE_URL =
  'postgresql://nobody:placeholder@127.0.0.1:1/placeholder';
const SECRET = 'distinctive-secret-7c1e90';
const ITEMS = '/api/v1/probe/items';
const VALID_ITEM = {
  name: 'a name that is long enough to pass',
  quantity: 2,
  kind: 'physical',
};

describe('API error contract', () => {
  let app: INestApplication;
  let server: Server;
  let output: string[];
  let lines: () => LogLine[];

  beforeAll(async () => {
    const started = await startApp(UNREACHABLE_DATABASE_URL, {
      controllers: [ProbeController],
    });
    ({ app, server, output, lines } = started);
  });

  afterAll(async () => {
    await app.close();
  });

  /** The `error` object of a response body, checked against the schema. */
  const errorOf = (response: request.Response) =>
    errorResponseSchema.parse(response.body).error;

  /** Asserts the shape every error shares and returns the parsed body. */
  function expectErrorShape(
    response: request.Response,
    status: number,
    code: (typeof ERROR_CODES)[number],
  ): ErrorResponse['error'] {
    expect(response.status).toBe(status);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    const parsed = errorResponseSchema.parse(response.body);
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.message).toBe(ERROR_DEFINITIONS[code].message);
    expect(parsed.error.correlationId).toBe(
      response.headers['x-correlation-id'],
    );
    return parsed.error;
  }

  describe('validation errors', () => {
    it('returns 400 with field paths and issue codes and never the received values', async () => {
      const response = await request(server)
        .post(ITEMS)
        .send({
          name: SECRET,
          quantity: `${SECRET}-quantity`,
          kind: `${SECRET}-kind`,
          tags: ['fits', `${SECRET}-tag`],
          [`${SECRET}-extra`]: SECRET,
        });

      const error = expectErrorShape(response, 400, 'VALIDATION_FAILED');
      expect(error.issues).toEqual(
        expect.arrayContaining([
          { path: ['name'], code: 'too_small' },
          { path: ['quantity'], code: 'invalid_type' },
          { path: ['kind'], code: 'invalid_value' },
          { path: ['tags', 1], code: 'too_big' },
          { path: [], code: 'unrecognized_keys' },
        ]),
      );
      expect(error.issues).toHaveLength(5);
      expect(response.text).not.toContain(SECRET);
      expect(output.join('')).not.toContain(SECRET);
    });

    it('reports a missing body as an issue on the root', async () => {
      const response = await request(server).post(ITEMS);

      const error = expectErrorShape(response, 400, 'VALIDATION_FAILED');
      expect(error.issues).toEqual([{ path: [], code: 'invalid_type' }]);
    });

    it('validates route and query parameters with the same shape', async () => {
      const response = await request(server).get(
        `${ITEMS}/${SECRET}?limit=${SECRET}`,
      );

      const error = expectErrorShape(response, 400, 'VALIDATION_FAILED');
      expect(error.issues).toHaveLength(1);
      expect(response.text).not.toContain(SECRET);
    });

    it('accepts a valid request and applies schema defaults', async () => {
      const created = await request(server).post(ITEMS).send(VALID_ITEM);
      expect(created.status).toBe(201);
      expect(created.body).toEqual({ created: VALID_ITEM });

      const id = '2d1ef0f6-5a1b-4b1e-9c53-0d6f2f5f6a11';
      const read = await request(server).get(`${ITEMS}/${id}`);
      expect(read.status).toBe(200);
      expect(read.body).toEqual({ id, limit: 20 });
    });
  });

  describe('request body errors', () => {
    it('maps malformed JSON to a stable code without the parser message', async () => {
      const response = await request(server)
        .post(ITEMS)
        .set('Content-Type', 'application/json')
        .send(`{"name": "${SECRET}", `);

      const error = expectErrorShape(response, 400, 'MALFORMED_JSON');
      expect(error.issues).toBeUndefined();
      expect(response.text).not.toContain(SECRET);
      expect(response.text).not.toMatch(
        /unexpected|position|token|SyntaxError/i,
      );
    });

    it('maps a body above the parser limit to a stable code', async () => {
      const response = await request(server)
        .post(ITEMS)
        .send({ name: 'x'.repeat(200_000) });

      expectErrorShape(response, 413, 'PAYLOAD_TOO_LARGE');
    });

    it('maps an unsupported charset to a stable code', async () => {
      const response = await request(server)
        .post(ITEMS)
        .set('Content-Type', 'application/json; charset=iso-8859-1')
        .send('{}');

      expectErrorShape(response, 415, 'UNSUPPORTED_MEDIA_TYPE');
    });
  });

  describe('routing errors', () => {
    it('maps an unknown route to NOT_FOUND without the framework message', async () => {
      const response = await request(server).get('/api/v1/does-not-exist');

      expectErrorShape(response, 404, 'NOT_FOUND');
      expect(response.text).not.toMatch(/Cannot GET/);
    });

    it('maps an unsupported method on an existing path to the same shape', async () => {
      const response = await request(server).delete(ITEMS);

      expectErrorShape(response, 404, 'NOT_FOUND');
      expect(response.text).not.toMatch(/Cannot DELETE/);
    });

    it('answers an unknown route and an unsupported method identically', async () => {
      const unknown = await request(server).get('/api/v1/does-not-exist');
      const unsupported = await request(server).delete(ITEMS);

      expect(errorOf(unknown).message).toBe(errorOf(unsupported).message);
      expect(errorOf(unknown).code).toBe(errorOf(unsupported).code);
    });
  });

  describe('other exceptions', () => {
    it('maps a client-error HttpException to REQUEST_REJECTED and hides its message', async () => {
      const response = await request(server).get('/api/v1/probe/forbidden');

      expectErrorShape(response, 403, 'REQUEST_REJECTED');
      expect(response.text).not.toContain(INTERNAL_FAILURE_MESSAGE);
    });

    it('maps an unknown error to a generic 500 with no stack or message', async () => {
      const response = await request(server).get('/api/v1/probe/crash');

      const error = expectErrorShape(response, 500, 'INTERNAL_ERROR');
      expect(Object.keys(error).sort()).toEqual([
        'code',
        'correlationId',
        'message',
      ]);
      expect(response.text).not.toContain(INTERNAL_FAILURE_MESSAGE);
      expect(response.text).not.toMatch(/\bat\s.+\(.+\)|stack|\.ts|\.js/);
    });

    it('treats a server-error HttpException as unexpected', async () => {
      const response = await request(server).get('/api/v1/probe/crash-service');

      expectErrorShape(response, 500, 'INTERNAL_ERROR');
      expect(response.text).not.toContain(INTERNAL_FAILURE_MESSAGE);
    });

    it('logs an unknown error once, with its stack and the correlation ID', async () => {
      const correlationId = 'trace-unknown-error-01';
      const before = lines().length;

      const response = await request(server)
        .get('/api/v1/probe/crash')
        .set('X-Correlation-Id', correlationId);

      expect(response.headers['x-correlation-id']).toBe(correlationId);
      const written = lines().slice(before);
      const failures = written.filter((line) => line['err'] !== undefined);
      expect(failures).toHaveLength(1);
      const [failure] = failures;
      expect(failure?.['correlationId']).toBe(correlationId);
      const err = failure?.['err'] as { message: string; stack: string };
      expect(err.message).toBe(INTERNAL_FAILURE_MESSAGE);
      expect(err.stack).toContain(INTERNAL_FAILURE_MESSAGE);
      expect(err.stack).toContain('probe.controller');
      expect(failure?.['msg']).toBe('Unhandled exception');
    });

    it('maps a database checkout timeout to a retryable 503 SERVICE_BUSY', async () => {
      const before = lines().length;

      const response = await request(server).get('/api/v1/probe/database-busy');

      expectErrorShape(response, 503, 'SERVICE_BUSY');
      expect(response.headers['retry-after']).toBe('1');
      expect(response.text).not.toContain('No database connection');
      const written = lines().slice(before);
      expect(written.filter((line) => line['err'] !== undefined)).toEqual([]);
      expect(
        written.filter(
          (line) => line.msg === 'No database connection became free in time',
        ),
      ).toHaveLength(1);
    });

    it('does not log an error line for expected failures', async () => {
      const before = lines().length;

      await request(server).post(ITEMS).send({});
      await request(server).get('/api/v1/does-not-exist');
      await request(server).get('/api/v1/probe/forbidden');

      const written = lines().slice(before);
      expect(written.filter((line) => line['err'] !== undefined)).toEqual([]);
    });
  });

  describe('correlation ID', () => {
    it('reuses a valid incoming ID in the header and the body', async () => {
      const response = await request(server)
        .post(ITEMS)
        .set('X-Correlation-Id', 'client-flow-0001')
        .send({});

      expect(response.headers['x-correlation-id']).toBe('client-flow-0001');
      expect(errorOf(response).correlationId).toBe('client-flow-0001');
    });

    it('replaces an invalid incoming ID and keeps header and body equal', async () => {
      const response = await request(server)
        .get('/api/v1/does-not-exist')
        .set('X-Correlation-Id', 'bad id!');

      expect(response.headers['x-correlation-id']).not.toBe('bad id!');
      expect(errorOf(response).correlationId).toBe(
        response.headers['x-correlation-id'],
      );
    });

    it('includes the ID on a request rejected before routing', async () => {
      const response = await request(server)
        .post(ITEMS)
        .set('Content-Type', 'application/json')
        .set('X-Correlation-Id', 'client-flow-0002')
        .send('{');

      expect(response.status).toBe(400);
      expect(response.headers['x-correlation-id']).toBe('client-flow-0002');
      expect(errorOf(response).correlationId).toBe('client-flow-0002');
      expect(response.headers['x-request-id']).toBeDefined();
    });
  });

  describe('access log', () => {
    it.each([
      ['an unknown route under the prefix', '/api/v1/nope', 404],
      ['an unknown route outside the prefix', '/nope', 404],
      ['an unknown error', '/api/v1/probe/crash', 500],
    ] as const)(
      'writes one access line for %s',
      async (_name, path, status) => {
        const before = lines().length;
        const correlationId = `access-log-${status}-${path.length}`;

        await request(server).get(path).set('X-Correlation-Id', correlationId);

        const access = lines()
          .slice(before)
          .filter((line) => line.msg === 'request completed');
        expect(access).toHaveLength(1);
        expect(access[0]?.['correlationId']).toBe(correlationId);
        expect(access[0]?.['res']).toEqual({ statusCode: status });
        expect(access[0]?.['err']).toBeUndefined();
      },
    );
  });

  describe('health endpoints and prefix', () => {
    it('keeps /health/live at its path', async () => {
      const response = await request(server).get('/health/live');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('keeps the /health/ready 503 body unchanged', async () => {
      const response = await request(server).get('/health/ready');

      expect(response.status).toBe(503);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.body).toEqual({ status: 'unavailable' });
    });

    it('does not serve the health endpoints under the API prefix', async () => {
      const response = await request(server).get('/api/v1/health/live');

      expectErrorShape(response, 404, 'NOT_FOUND');
    });

    it('does not serve business routes without the API prefix', async () => {
      const response = await request(server).post('/probe/items').send({});

      expectErrorShape(response, 404, 'NOT_FOUND');
    });
  });
});
