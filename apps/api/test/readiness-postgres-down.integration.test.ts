import { DEFAULT_DATABASE_SETTINGS } from '@merchantflow/database';
import { startPostgres } from '@merchantflow/test-support';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIALS } from './support/database-fixtures.js';
import { startApp } from './support/start-app.js';
import {
  collectStrings,
  connectionFragments,
} from './support/connection-details.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /health/ready with PostgreSQL going down', () => {
  it('responds 200 while it is up and 503 once it is stopped, without connection details', async () => {
    const postgres = await startPostgres(CREDENTIALS);
    const url = postgres.getConnectionUri();
    const { app, server, output, lines } = await startApp(url);
    try {
      const up = await request(server).get('/health/ready');
      expect(up.status).toBe(200);
      expect(up.body).toEqual({ status: 'ready' });

      await postgres.stop();
      output.length = 0;

      const started = performance.now();
      const down = await request(server)
        .get('/health/ready')
        .set('X-Correlation-Id', 'ready-down-0001');
      const elapsed = performance.now() - started;

      expect(down.status).toBe(503);
      expect(down.body).toEqual({ status: 'unavailable' });
      expect(elapsed).toBeLessThan(
        DEFAULT_DATABASE_SETTINGS.connectionTimeoutMillis + 1_500,
      );

      const exposed = [
        down.text,
        ...collectStrings(down.headers),
        ...collectStrings(down.body),
      ].join('\n');
      const written = output.join('');
      const fragments = [
        ...connectionFragments(url),
        ...Object.values(CREDENTIALS),
      ];
      for (const fragment of fragments) {
        expect(exposed).not.toContain(fragment);
        expect(written).not.toContain(fragment);
      }
      expect(
        lines().find((line) => line.msg === 'readiness check failed'),
      ).toMatchObject({ level: 40, correlationId: 'ready-down-0001' });

      const live = await request(server).get('/health/live');
      expect(live.status).toBe(200);
    } finally {
      await app.close();
    }
  });
});
