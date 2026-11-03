import { startPostgres } from '@merchantflow/test-support';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIALS, sessionsOf } from './support/database-fixtures.js';
import { startApp } from './support/start-app.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('application shutdown with PostgreSQL up', () => {
  it('closes every connection of the pool', async () => {
    const postgres = await startPostgres(CREDENTIALS);
    try {
      const { app, server, lines } = await startApp(
        postgres.getConnectionUri(),
      );
      await request(server).get('/health/ready').expect(200);
      expect(await sessionsOf(postgres, 'merchantflow-api')).toBeGreaterThan(0);

      await app.close();

      await vi.waitFor(
        async () =>
          expect(await sessionsOf(postgres, 'merchantflow-api')).toBe(0),
        { timeout: 5_000 },
      );
      expect(lines().map((line) => line.msg)).toContain('database pool closed');
    } finally {
      await postgres.stop();
    }
  });
});
