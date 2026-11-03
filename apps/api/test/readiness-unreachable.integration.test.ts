import { DEFAULT_DATABASE_SETTINGS } from '@merchantflow/database';
import { startSilentServer } from '@merchantflow/test-support';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CREDENTIALS } from './support/database-fixtures.js';
import { startApp } from './support/start-app.js';
import { connectionFragments } from './support/connection-details.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /health/ready with PostgreSQL unreachable', () => {
  it('answers 503 within the configured connection timeout when the server never responds', async () => {
    const silent = await startSilentServer();
    const url = `postgresql://${CREDENTIALS.username}:${CREDENTIALS.password}@127.0.0.1:${String(silent.port)}/${CREDENTIALS.database}`;
    const { app, server, output, lines } = await startApp(url);
    try {
      const started = performance.now();
      const response = await request(server).get('/health/ready');
      const elapsed = performance.now() - started;

      const timeout = DEFAULT_DATABASE_SETTINGS.connectionTimeoutMillis;
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: 'unavailable' });
      // It waited for the timeout instead of failing at once, and not longer.
      expect(elapsed).toBeGreaterThanOrEqual(timeout - 200);
      expect(elapsed).toBeLessThan(timeout + 1_500);

      const written = output.join('');
      for (const fragment of connectionFragments(url)) {
        expect(response.text).not.toContain(fragment);
        expect(written).not.toContain(fragment);
      }
      expect(
        lines().find((line) => line.msg === 'readiness check failed'),
      ).toMatchObject({ reason: 'TIMEOUT' });
    } finally {
      await app.close();
      await silent.stop();
    }
  });
});
