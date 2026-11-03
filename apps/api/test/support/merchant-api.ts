import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { IssueApiKeyService } from '../../src/modules/auth/application/issue-api-key.service.js';
import { parseApiKey } from '../../src/modules/auth/application/api-key-secret.js';
import type { Clock } from '../../src/modules/clock/clock.js';
import {
  startMigratedPostgres,
  type MigratedPostgres,
} from './migrated-postgres.js';
import { startApp, type LogLine } from './start-app.js';

export const START_TIME = new Date('2026-11-03T12:00:00.000Z');

export const API = '/api/v1';

/** A clock a test moves by hand. Every `now()` returns a new `Date`. */
export class ControllableClock implements Clock {
  private current = START_TIME;

  now(): Date {
    return new Date(this.current);
  }

  set(time: Date): void {
    this.current = new Date(time);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

/** A merchant as the API returns it. */
export interface ApiMerchant {
  readonly id: string;
  readonly legal_name: string;
  readonly display_name: string;
  readonly business_type: string;
  readonly industry: string;
  readonly country_code: string;
  readonly default_currency: string;
  readonly status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED';
  readonly created_at: string;
  readonly updated_at: string;
}

/** A key as an issuance returned it, with the parts a test searches for. */
export interface IssuedKey {
  /** The full key, which is the bearer token. */
  readonly key: string;
  readonly secret: string;
  readonly lookupId: string;
  /** Identifier of the key row, used to revoke it. */
  readonly id: string;
  readonly merchantId: string | null;
}

export type MerchantRole = 'MERCHANT_ADMIN' | 'MERCHANT_READ_ONLY';

/** Every table a request can change, read through a connection of its own. */
export interface DatabaseState {
  readonly merchants: unknown[];
  readonly auditEvents: unknown[];
  readonly apiKeys: unknown[];
}

export interface AuditRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly merchant_id: string | null;
  readonly correlation_id: string;
  readonly metadata: Record<string, unknown>;
}

export interface MerchantApi {
  readonly postgres: MigratedPostgres;
  readonly app: INestApplication;
  readonly server: Server;
  readonly clock: ControllableClock;
  readonly output: string[];
  readonly lines: () => LogLine[];
  /** The platform administrator key every test starts with. */
  readonly platform: IssuedKey;
  /** The text of every response received through this object. */
  readonly responses: string[];
  /** Every key issued through this object, for searches in logs and rows. */
  readonly issued: IssuedKey[];
  get(key: string | undefined, path: string): request.Test;
  post(key: string | undefined, path: string, body?: object): request.Test;
  patch(key: string | undefined, path: string, body: object): request.Test;
  /** Registers a merchant through the API as the platform administrator. */
  createMerchant(overrides?: Record<string, unknown>): Promise<ApiMerchant>;
  /** Registers a merchant and moves it to `ACTIVE`. */
  createActiveMerchant(): Promise<ApiMerchant>;
  /** Issues a key through the API as the platform administrator. */
  keyFor(merchantId: string, role: MerchantRole): Promise<IssuedKey>;
  state(): Promise<DatabaseState>;
  auditRows(action?: string): Promise<AuditRow[]>;
  stop(): Promise<void>;
}

let merchantCounter = 0;

/**
 * Starts PostgreSQL on Testcontainers with the project's migrations and the
 * whole application on top of it, with a controllable clock and one platform
 * administrator key. Use one per test file (see `startApp`).
 */
export async function startMerchantApi(): Promise<MerchantApi> {
  const postgres = await startMigratedPostgres();
  const clock = new ControllableClock();
  const { app, server, output, lines } = await startApp(
    postgres.connectionString,
    { clock },
  );
  const responses: string[] = [];
  const issued: IssuedKey[] = [];

  const track = (call: request.Test, key: string | undefined) => {
    if (key !== undefined) call.set('Authorization', `Bearer ${key}`);
    // Every response is remembered so a test can search all of them at once.
    call.on('response', (response: request.Response) => {
      responses.push(response.text);
    });
    return call;
  };

  const record = (
    key: string,
    id: string,
    merchantId: string | null,
  ): IssuedKey => {
    const parsed = parseApiKey(key);
    if (parsed === undefined) throw new Error('Expected a well-formed key');
    const entry = {
      key,
      secret: parsed.secret,
      lookupId: parsed.lookupId,
      id,
      merchantId,
    };
    issued.push(entry);
    return entry;
  };

  const issueService = app.get(IssueApiKeyService);
  const platformResult = await issueService.execute({
    actor: { actorType: 'SYSTEM', actorId: 'merchant-api-test' },
    scope: { kind: 'PLATFORM', role: 'PLATFORM_ADMIN' },
    correlationId: randomUUID(),
  });
  if (!platformResult.ok) throw new Error('Expected the platform key');
  const platform = record(platformResult.key, platformResult.apiKey.id, null);

  const api: MerchantApi = {
    postgres,
    app,
    server,
    clock,
    output,
    lines,
    platform,
    responses,
    issued,
    get: (key, path) => track(request(server).get(path), key),
    post: (key, path, body) => {
      const call = request(server).post(path);
      if (body !== undefined) call.send(body);
      return track(call, key);
    },
    patch: (key, path, body) =>
      track(request(server).patch(path).send(body), key),
    async createMerchant(overrides = {}) {
      merchantCounter += 1;
      const response = await api.post(platform.key, `${API}/merchants`, {
        legal_name: `Merchant ${merchantCounter} Ltd`,
        display_name: `Merchant ${merchantCounter}`,
        business_type: 'LLC',
        industry: 'Retail',
        country_code: 'US',
        default_currency: 'USD',
        ...overrides,
      });
      if (response.status !== 201) {
        throw new Error(`Expected 201, got ${response.status}`);
      }
      return response.body as ApiMerchant;
    },
    async createActiveMerchant() {
      const merchant = await api.createMerchant();
      const response = await api.post(
        platform.key,
        `${API}/merchants/${merchant.id}/status`,
        { status: 'ACTIVE' },
      );
      if (response.status !== 200) {
        throw new Error(`Expected 200, got ${response.status}`);
      }
      return response.body as ApiMerchant;
    },
    async keyFor(merchantId, role) {
      const response = await api.post(
        platform.key,
        `${API}/merchants/${merchantId}/api-keys`,
        { role },
      );
      if (response.status !== 201) {
        throw new Error(`Expected 201, got ${response.status}`);
      }
      const body = response.body as { id: string; key: string };
      return record(body.key, body.id, merchantId);
    },
    async state() {
      const read = async (table: string) =>
        (await postgres.client.query(`select * from ${table} order by id`))
          .rows as unknown[];
      return {
        merchants: await read('merchants'),
        auditEvents: await read('audit_events'),
        apiKeys: await read('api_keys'),
      };
    },
    async auditRows(action) {
      const result = await postgres.client.query<AuditRow>(
        action === undefined
          ? 'select * from audit_events order by occurred_at, id'
          : 'select * from audit_events where action = $1 order by occurred_at, id',
        action === undefined ? [] : [action],
      );
      return result.rows;
    },
    async stop() {
      await app.close();
      await postgres.stop();
    },
  };
  return api;
}
