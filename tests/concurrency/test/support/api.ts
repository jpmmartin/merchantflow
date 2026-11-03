import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { migrateTestDatabase } from '@merchantflow/database/testing';
import { startPostgres } from '@merchantflow/test-support';
import type { SeedCliOptions } from '@merchantflow/api/testing';
import { Client } from 'pg';
import { vi } from 'vitest';
import { send, type HttpRequest, type HttpResponse } from './http.js';

export const API = '/api/v1';

/** A merchant in `ACTIVE` status with a `MERCHANT_ADMIN` key. */
export interface ActiveMerchant {
  readonly merchantId: string;
  readonly adminKey: string;
}

/** A create request body as the API receives it. */
export interface CreateIntentBody {
  readonly amount_minor: string;
  readonly currency: string;
  readonly merchant_reference: string;
}

/** The API process under test, listening on a port of its own. */
export interface RunningApi {
  readonly port: number;
  readonly connectionString: string;
  /** A raw connection of the test, outside the application's pool. */
  readonly sql: Client;
  /** Requests the HTTP server has received and not yet answered. */
  requestsInFlight(): number;
  send(call: HttpRequest): Promise<HttpResponse>;
  /** Registers a merchant, activates it, and issues it a `MERCHANT_ADMIN` key. */
  createActiveMerchant(): Promise<ActiveMerchant>;
  createIntent(
    adminKey: string,
    idempotencyKey: string,
    body: CreateIntentBody,
  ): Promise<HttpResponse>;
  stop(): Promise<void>;
}

/** Fails with the response text when a setup call does not answer `status`. */
function expectStatus(response: HttpResponse, status: number): HttpResponse {
  if (response.status !== status) {
    throw new Error(
      `Expected ${status}, got ${response.status}: ${response.text}`,
    );
  }
  return response;
}

/**
 * Creates the development platform administrator key through the seed, the
 * same code as `pnpm db:seed`, and reads it from the seed's output.
 */
async function seedPlatformKey(
  runSeedCli: (options: SeedCliOptions) => Promise<number>,
): Promise<string> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runSeedCli({
    stdout: { write: (text) => stdout.push(text) },
    stderr: { write: (text) => stderr.push(text) },
  });
  if (exitCode !== 0) {
    throw new Error(`The seed failed: ${stderr.join('')}`);
  }
  const key = /^\s+(mfk_\S+)$/m.exec(stdout.join(''))?.[1];
  if (key === undefined) throw new Error('The seed printed no key');
  return key;
}

let merchantCounter = 0;

/**
 * Starts PostgreSQL 17 on Testcontainers, applies the project's migrations,
 * and starts the API as its server process creates it, listening on an
 * ephemeral port of 127.0.0.1. Every request of the suite goes through a real
 * socket. The pool keeps its defaults (AD-33). Use one per test file: the
 * configuration is read once per module graph.
 */
export async function startApi(): Promise<RunningApi> {
  const postgres = await startPostgres();
  const connectionString = postgres.getConnectionUri();
  await migrateTestDatabase(connectionString);

  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATABASE_URL', connectionString);
  // Only unexpected failures are logged, so a passing run prints nothing.
  vi.stubEnv('LOG_LEVEL', 'error');
  const { createApiApplication, runSeedCli } =
    await import('@merchantflow/api/testing');

  const platformKey = await seedPlatformKey(runSeedCli);
  const app = await createApiApplication();
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as Server;
  const { port } = server.address() as AddressInfo;

  let inFlight = 0;
  server.on('request', (_request, response) => {
    inFlight += 1;
    response.on('close', () => {
      inFlight -= 1;
    });
  });

  const sql = new Client({ connectionString });
  await sql.connect();

  const call = (call: HttpRequest) => send(port, call);
  const post = (key: string, path: string, body: unknown) =>
    call({
      method: 'POST',
      path,
      headers: { Authorization: `Bearer ${key}` },
      body,
    });

  return {
    port,
    connectionString,
    sql,
    requestsInFlight: () => inFlight,
    send: call,
    async createActiveMerchant() {
      merchantCounter += 1;
      const created = expectStatus(
        await post(platformKey, `${API}/merchants`, {
          legal_name: `Concurrency Merchant ${merchantCounter} Ltd`,
          display_name: `Concurrency Merchant ${merchantCounter}`,
          business_type: 'LLC',
          industry: 'Retail',
          country_code: 'US',
          default_currency: 'USD',
        }),
        201,
      );
      const merchantId = (JSON.parse(created.text) as { id: string }).id;
      expectStatus(
        await post(platformKey, `${API}/merchants/${merchantId}/status`, {
          status: 'ACTIVE',
        }),
        200,
      );
      const issued = expectStatus(
        await post(platformKey, `${API}/merchants/${merchantId}/api-keys`, {
          role: 'MERCHANT_ADMIN',
        }),
        201,
      );
      const adminKey = (JSON.parse(issued.text) as { key: string }).key;
      return { merchantId, adminKey };
    },
    createIntent: (adminKey, idempotencyKey, body) =>
      call({
        method: 'POST',
        path: `${API}/payment-intents`,
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'Idempotency-Key': idempotencyKey,
          // A known correlation ID per request ties the audit event to the
          // response of the request that created the intent.
          'X-Correlation-Id': randomUUID(),
        },
        body,
      }),
    async stop() {
      await sql.end();
      await app.close();
      await postgres.stop();
      vi.unstubAllEnvs();
    },
  };
}
