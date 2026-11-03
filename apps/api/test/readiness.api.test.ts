import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Logger } from 'nestjs-pino';
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
import { DATABASE } from '../src/modules/database/database.module.js';
import { LOG_DESTINATION } from '../src/modules/logging/logging.module.js';
import {
  collectStrings,
  connectionFragments,
} from './support/connection-details.js';

interface LogLine {
  level: number;
  msg?: string;
  reason?: string;
  [key: string]: unknown;
}

// These tests run with DATABASE_URL pointing at a port where nothing listens
// (see vitest.config.ts), so PostgreSQL is unavailable in every one of them.
describe('GET /health/ready without a reachable database', () => {
  let app: INestApplication;
  let server: Server;
  let databaseUrl: string;
  let output: string[];

  const lines = (): LogLine[] =>
    output
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as LogLine);

  async function createApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOG_DESTINATION)
      .useValue({ write: (chunk: string) => void output.push(chunk) })
      .compile();
    const created = moduleRef.createNestApplication({ bufferLogs: true });
    created.useLogger(created.get(Logger));
    await created.init();
    return created;
  }

  beforeAll(async () => {
    output = [];
    app = await createApp();
    server = app.getHttpServer() as Server;
    databaseUrl = app
      .get<ConfigService<{ DATABASE_URL: string }, true>>(ConfigService)
      .get('DATABASE_URL', { infer: true });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    output.length = 0;
  });

  it('responds 503 with only a status', async () => {
    const response = await request(server).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ status: 'unavailable' });
  });

  it('answers while liveness keeps responding 200', async () => {
    const ready = await request(server).get('/health/ready');
    const live = await request(server).get('/health/live');

    expect(ready.status).toBe(503);
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });
  });

  it('exposes no connection detail in the body or the headers', async () => {
    const response = await request(server).get('/health/ready');

    const exposed = [
      response.text,
      ...collectStrings(response.headers),
      ...collectStrings(response.body),
    ].join('\n');
    for (const fragment of connectionFragments(databaseUrl)) {
      expect(exposed).not.toContain(fragment);
    }
  });

  it('logs the cause as a code and no connection detail', async () => {
    const response = await request(server)
      .get('/health/ready')
      .set('X-Correlation-Id', 'ready-check-0001');

    const written = output.join('');
    for (const fragment of connectionFragments(databaseUrl)) {
      expect(written).not.toContain(fragment);
    }
    const failure = lines().find(
      (line) => line.msg === 'readiness check failed',
    );
    expect(failure).toMatchObject({
      level: 40,
      reason: 'ECONNREFUSED',
      correlationId: 'ready-check-0001',
    });
    expect(response.headers['x-correlation-id']).toBe('ready-check-0001');
  });

  it('answers every request, including repeated ones', async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      statuses.push((await request(server).get('/health/ready')).status);
    }

    expect(statuses).toEqual([503, 503, 503, 503, 503]);
  });

  it('closes the database pool when the application shuts down', async () => {
    const closing = await createApp();
    const destroy = vi.spyOn(closing.get(DATABASE), 'destroy');
    output.length = 0;

    await closing.close();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(lines().map((line) => line.msg)).toContain('database pool closed');
  });
});
