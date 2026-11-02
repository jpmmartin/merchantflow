import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { GetLivenessService } from '../src/modules/health/application/get-liveness.service.js';

describe('GET /health/live', () => {
  let app: INestApplication;
  let server: Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    // Nest types the HTTP server as `any`; it is a Node HTTP server for the Express adapter.
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('responds 200 with an ok status', async () => {
    const response = await request(server).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('serves the report produced by the injected provider', async () => {
    const provider = app.get(GetLivenessService);
    const execute = vi.spyOn(provider, 'execute');

    const response = await request(server).get('/health/live');

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(response.body).toEqual(execute.mock.results[0]?.value);
  });
});
