import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { errorResponseSchema } from '../src/modules/errors/api/error-response.js';
import { ProbeController } from './support/probe.controller.js';
import { startApp } from './support/start-app.js';

const UNREACHABLE_DATABASE_URL =
  'postgresql://nobody:placeholder@127.0.0.1:1/placeholder';

describe('OpenAPI document in production', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    // The configuration is read when the application module is imported, which
    // `startApp` does after this call.
    vi.stubEnv('NODE_ENV', 'production');
    ({ app, server } = await startApp(UNREACHABLE_DATABASE_URL, {
      controllers: [ProbeController],
    }));
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it.each(['/docs', '/docs/openapi.json'])(
    'does not serve %s',
    async (path) => {
      const response = await request(server).get(path);

      expect(response.status).toBe(404);
      expect(errorResponseSchema.parse(response.body).error.code).toBe(
        'NOT_FOUND',
      );
      expect(response.text).not.toMatch(/swagger|openapi/i);
    },
  );

  it('still serves the API and the health probes', async () => {
    const live = await request(server).get('/health/live');
    const created = await request(server).post('/api/v1/probe/items').send({});

    expect(live.status).toBe(200);
    expect(created.status).toBe(400);
  });
});
