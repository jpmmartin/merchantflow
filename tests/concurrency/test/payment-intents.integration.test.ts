import { randomUUID } from 'node:crypto';
import { DEFAULT_DATABASE_SETTINGS } from '@merchantflow/database';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  startApi,
  type CreateIntentBody,
  type RunningApi,
} from './support/api.js';
import type { HttpResponse } from './support/http.js';
import { creationEvents, intentRows, recordRows } from './support/rows.js';
import {
  apiSessions,
  CLAIM_STATEMENT,
  MERCHANT_READ_STATEMENT,
  MerchantRowGate,
  waitsIn,
  type ApiSession,
} from './support/sessions.js';

/*
 * Each scenario sends 50 requests at once, each over its own TCP connection, to
 * the API listening on a real port. The API's pool has 10 connections (AD-33),
 * so at most 10 requests are inside PostgreSQL at a time and the other 40 wait
 * for a connection.
 *
 * Overlap is forced, not hoped for: a connection of the test holds the lock a
 * merchant status change takes, so each request that reaches the merchant read
 * stops there. The test waits until the HTTP server has all 50 requests open,
 * no response has been sent, and all 10 pool sessions are waiting for a lock,
 * then releases the gate. The outcome is asserted first, then which lock each
 * session waited for, so a broken invariant shows as a wrong outcome.
 *
 * Nothing sleeps. The only wait is a condition poll every 10 ms, bounded by
 * half of the pool's 2 s connection timeout, which is also the command's lock
 * timeout (AD-64): the gate is released while no request can have hit either.
 */

const REQUESTS = 50;
const POOL_SIZE = DEFAULT_DATABASE_SETTINGS.maxConnections;
const RELEASE_BUDGET_MILLIS =
  DEFAULT_DATABASE_SETTINGS.connectionTimeoutMillis / 2;
const POLL = { timeout: RELEASE_BUDGET_MILLIS, interval: 10 };

/**
 * Responses each scenario accepts, written as `<status>` or `<status> <code>`.
 * Every other response fails the test. The command claims the key and stores
 * the response in one transaction, so a record is never committed in progress
 * and `409 OPERATION_IN_PROGRESS` cannot occur; the gate is released before any
 * wait reaches 2 s, so neither `503` can occur either. When the gate is held
 * past every wait, only the two retryable answers that store nothing remain:
 * a lock wait over the command's lock timeout and a wait for a pool connection
 * over the pool's connection timeout.
 */
const ALLOWED_FOR_ONE_KEY = ['201'];
const ALLOWED_FOR_ONE_REFERENCE = ['201', '409 DUPLICATE_MERCHANT_REFERENCE'];
const ALLOWED_WHILE_HELD = ['503 OPERATION_TIMEOUT', '503 SERVICE_BUSY'];

/** The status of a response, with the error code when it is an error. */
function outcomeOf(response: HttpResponse): string {
  if (response.status < 400) return String(response.status);
  const body = JSON.parse(response.text) as { error?: { code?: unknown } };
  return `${response.status} ${String(body.error?.code)}`;
}

function intentBody(): CreateIntentBody {
  return {
    amount_minor: '1000',
    currency: 'USD',
    merchant_reference: `order-${randomUUID()}`,
  };
}

function newKey(): string {
  return `key-${randomUUID()}`;
}

describe('payment intent creation under 50 concurrent HTTP requests', () => {
  // Both stay unassigned when the start fails, which the hooks below allow
  // for, so the start's error is the one reported.
  let api: RunningApi | undefined;
  let gate: MerchantRowGate | undefined;

  beforeAll(async () => {
    api = await startApi();
    gate = await MerchantRowGate.open(api.connectionString);
  });

  /** The started API and gate, for code that runs only after the start. */
  function started(): { api: RunningApi; gate: MerchantRowGate } {
    if (api === undefined || gate === undefined) {
      throw new Error('The API did not start');
    }
    return { api, gate };
  }

  afterEach(async () => {
    await gate?.reset();
  });

  afterAll(async () => {
    await gate?.close();
    await api?.stop();
  });

  /** Sends every request at once and counts those that have been answered. */
  function burst(send: (index: number) => Promise<HttpResponse>) {
    let answered = 0;
    const pending = Array.from({ length: REQUESTS }, (_, index) =>
      send(index).finally(() => {
        answered += 1;
      }),
    );
    return { pending, answered: () => answered };
  }

  /**
   * Waits until every request is open on the server and every pool session
   * waits for a lock, and returns those sessions.
   */
  async function waitForSaturation(
    api: RunningApi,
    startedAt: number,
  ): Promise<ApiSession[]> {
    const sessions = await vi.waitFor(async () => {
      expect(api.requestsInFlight()).toBe(REQUESTS);
      const current = await apiSessions(api.sql);
      expect(current).toHaveLength(POOL_SIZE);
      expect(
        current.filter((session) => session.waitEventType === 'Lock'),
      ).toHaveLength(POOL_SIZE);
      return current;
    }, POLL);
    expect(performance.now() - startedAt).toBeLessThan(RELEASE_BUDGET_MILLIS);
    return sessions;
  }

  it('creates one intent for 50 requests with one key and answers each with the original 201', async () => {
    const { api, gate } = started();
    const merchant = await api.createActiveMerchant();
    const key = newKey();
    const body = intentBody();
    await gate.hold(merchant.merchantId);

    const startedAt = performance.now();
    const { pending, answered } = burst(() =>
      api.createIntent(merchant.adminKey, key, body),
    );
    const sessions = await waitForSaturation(api, startedAt);
    expect(answered()).toBe(0);
    await gate.release();
    const responses = await Promise.all(pending);

    // Every request travelled over a connection of its own.
    expect(new Set(responses.map((response) => response.localPort)).size).toBe(
      REQUESTS,
    );
    for (const response of responses) {
      expect(ALLOWED_FOR_ONE_KEY).toContain(outcomeOf(response));
    }
    const events = await creationEvents(api.sql, merchant.merchantId);
    expect(events).toHaveLength(1);
    const [event] = events;
    // The audit event carries the correlation ID of the creating request.
    const original = responses.find(
      (response) =>
        response.headers['x-correlation-id'] === event?.correlation_id,
    );
    if (original === undefined)
      throw new Error('Expected the creating response');
    for (const response of responses) {
      expect(response.text).toBe(original.text);
    }
    const intentId = (JSON.parse(original.text) as { id: string }).id;
    expect(event?.target_id).toBe(intentId);
    expect(await intentRows(api.sql, merchant.merchantId)).toEqual([
      { id: intentId, merchant_reference: body.merchant_reference },
    ]);
    expect(await recordRows(api.sql, merchant.merchantId)).toEqual([
      {
        idempotency_key: key,
        operation_id: intentId,
        status: 'COMPLETED',
        response_status_code: 201,
        response_body: original.text,
      },
    ]);

    // While the gate was held, the owner of the key waited for the merchant
    // row, and the other nine waited for the owner's uncommitted claim.
    const owners = sessions.filter((session) =>
      waitsIn(session, MERCHANT_READ_STATEMENT),
    );
    const claimers = sessions.filter((session) =>
      waitsIn(session, CLAIM_STATEMENT),
    );
    expect(owners.map((session) => session.blockers)).toEqual([[gate.pid]]);
    expect(claimers).toHaveLength(POOL_SIZE - 1);
    for (const claimer of claimers) {
      expect(claimer.blockers).toEqual([owners[0]?.pid]);
    }
  });

  it('creates one intent for 50 requests with different keys for one merchant_reference', async () => {
    const { api, gate } = started();
    const merchant = await api.createActiveMerchant();
    const body = intentBody();
    const keys = Array.from({ length: REQUESTS }, () => newKey());
    await gate.hold(merchant.merchantId);

    const startedAt = performance.now();
    const { pending, answered } = burst((index) =>
      api.createIntent(merchant.adminKey, keys[index] ?? '', body),
    );
    const sessions = await waitForSaturation(api, startedAt);
    expect(answered()).toBe(0);
    await gate.release();
    const responses = await Promise.all(pending);

    expect(new Set(responses.map((response) => response.localPort)).size).toBe(
      REQUESTS,
    );
    for (const response of responses) {
      expect(ALLOWED_FOR_ONE_REFERENCE).toContain(outcomeOf(response));
    }
    const winners = responses.flatMap((response, index) =>
      response.status === 201 ? [{ response, key: keys[index] }] : [],
    );
    expect(winners).toHaveLength(1);
    const [winner] = winners;
    if (winner === undefined) throw new Error('Expected one created intent');
    const intentId = (JSON.parse(winner.response.text) as { id: string }).id;
    expect(await creationEvents(api.sql, merchant.merchantId)).toEqual([
      {
        target_id: intentId,
        correlation_id: winner.response.headers['x-correlation-id'],
      },
    ]);
    expect(await intentRows(api.sql, merchant.merchantId)).toEqual([
      { id: intentId, merchant_reference: body.merchant_reference },
    ]);
    // The 49 refused requests stored nothing under their keys (AD-64).
    expect(await recordRows(api.sql, merchant.merchantId)).toEqual([
      {
        idempotency_key: winner.key,
        operation_id: intentId,
        status: 'COMPLETED',
        response_status_code: 201,
        response_body: winner.response.text,
      },
    ]);

    // While the gate was held, all ten sessions had claimed their own key and
    // waited for the same merchant row: on the gate, or queued behind another
    // waiter for the row's tuple lock.
    for (const session of sessions) {
      expect(waitsIn(session, MERCHANT_READ_STATEMENT)).toBe(true);
    }
    const waiters = new Set([gate.pid, ...sessions.map((s) => s.pid)]);
    for (const session of sessions) {
      expect(session.blockers.length).toBeGreaterThan(0);
      for (const blocker of session.blockers) {
        expect(waiters.has(blocker)).toBe(true);
      }
    }
    expect(sessions.flatMap((session) => session.blockers)).toContain(gate.pid);
  });
  it('answers every request with a retryable 503 and stores nothing while the gate outlasts every timeout', async () => {
    const { api, gate } = started();
    const merchant = await api.createActiveMerchant();
    const key = newKey();
    const body = intentBody();
    await gate.hold(merchant.merchantId);

    const startedAt = performance.now();
    const { pending } = burst(() =>
      api.createIntent(merchant.adminKey, key, body),
    );
    await waitForSaturation(api, startedAt);
    // The gate stays held until every request has been answered.
    const responses = await Promise.all(pending);
    await gate.release();

    for (const response of responses) {
      expect(ALLOWED_WHILE_HELD).toContain(outcomeOf(response));
      expect(response.headers['retry-after']).toBe('1');
    }
    // Requests queued for a connection before saturation cannot be admitted
    // before the first lock timeout frees one, 2 s after their own wait began.
    expect(
      responses.filter((response) => outcomeOf(response) === '503 SERVICE_BUSY')
        .length,
    ).toBeGreaterThan(0);
    expect(await intentRows(api.sql, merchant.merchantId)).toEqual([]);
    expect(await recordRows(api.sql, merchant.merchantId)).toEqual([]);
    expect(await creationEvents(api.sql, merchant.merchantId)).toEqual([]);

    // Nothing was stored, so the same request under the same key now succeeds.
    const retried = await api.createIntent(merchant.adminKey, key, body);
    expect(retried.status).toBe(201);
  });
});
