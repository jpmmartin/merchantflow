import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS } from '../src/modules/payments/application/create-payment-intent.service.js';
import { errorResponseSchema } from '../src/modules/errors/api/error-response.js';
import { startMerchantApi, type MerchantApi } from './support/merchant-api.js';
import {
  createIntent,
  creationEvents,
  intentBody,
  intentRows,
  merchantWithKeys,
  newKey,
  recordOf,
  recordRows,
} from './support/payment-intents.js';
import { snapshotDatabase } from './support/tenants.js';

/*
 * Overlap is forced, not hoped for: a connection of the test holds the lock a
 * merchant status change takes (FOR NO KEY UPDATE on the merchant row), so
 * every request stops inside its transaction at a known statement. The test
 * waits until pg_stat_activity shows each of them waiting, then releases the
 * lock. Nothing sleeps; the waits are condition polls well inside the
 * command's lock timeout.
 */

/** Fewer requests than the pool's 10 connections, so all can wait at once. */
const REQUESTS = 8;

/** How long the test may poll for the waits it set up. */
const POLL = {
  timeout: PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS / 2,
  interval: 10,
};

describe('payment intent creation under concurrency', () => {
  let api: MerchantApi;
  let gate: Client;

  beforeAll(async () => {
    api = await startMerchantApi();
    gate = new Client({ connectionString: api.postgres.connectionString });
    await gate.connect();
  });

  afterEach(async () => {
    await gate.query('rollback');
  });

  afterAll(async () => {
    await gate.end();
    await api.stop();
  });

  /** Holds the row lock of a merchant status change until the test ends it. */
  async function holdMerchantRow(merchantId: string): Promise<void> {
    await gate.query('begin');
    await gate.query(
      'select 1 from merchants where id = $1 for no key update',
      [merchantId],
    );
  }

  /** Counts sessions waiting for a lock in a statement that starts with `prefix`. */
  async function waitingIn(prefix: string): Promise<number> {
    const result = await api.postgres.client.query<{ total: number }>(
      `select count(*)::int as total from pg_stat_activity
       where wait_event_type = 'Lock' and query like $1`,
      [`${prefix}%`],
    );
    return result.rows[0]?.total ?? 0;
  }

  const CLAIM = 'insert into "idempotency_records"';
  const MERCHANT_READ =
    'select "id", "status", "default_currency" from "merchants"';

  /** Starts a request now and returns its eventual response. */
  function start(call: request.Test): Promise<request.Response> {
    return call.then((response) => response);
  }

  const codeOf = (response: request.Response) =>
    errorResponseSchema.parse(response.body).error.code;

  it('creates one intent for concurrent requests with one key and replays it to the others', async () => {
    const tenant = await merchantWithKeys(api);
    const key = newKey();
    const body = intentBody();
    await holdMerchantRow(tenant.merchant.id);

    const pending = Array.from({ length: REQUESTS }, () =>
      start(createIntent(api, tenant.admin.key, key, body)),
    );
    // The owner of the key waits on the merchant row; every other request
    // waits on the owner's uncommitted claim.
    await vi.waitFor(async () => {
      expect(await waitingIn(MERCHANT_READ)).toBe(1);
      expect(await waitingIn(CLAIM)).toBe(REQUESTS - 1);
    }, POLL);
    await gate.query('commit');
    const responses = await Promise.all(pending);

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: REQUESTS }, () => 201),
    );
    const [first] = responses;
    for (const response of responses) {
      expect(response.text).toBe(first?.text);
    }
    expect(await intentRows(api, tenant.merchant.id)).toHaveLength(1);
    expect(await creationEvents(api, tenant.merchant.id)).toHaveLength(1);
    expect(await recordRows(api, tenant.merchant.id)).toMatchObject([
      { idempotency_key: key, status: 'COMPLETED', response_body: first?.text },
    ]);
  });

  it('creates one intent for concurrent requests with different keys for one merchant_reference', async () => {
    const tenant = await merchantWithKeys(api);
    const body = intentBody();
    const keys = Array.from({ length: REQUESTS }, () => newKey());
    await holdMerchantRow(tenant.merchant.id);

    const pending = keys.map((key) =>
      start(createIntent(api, tenant.admin.key, key, body)),
    );
    // Each request owns its own key and waits on the merchant row.
    await vi.waitFor(async () => {
      expect(await waitingIn(MERCHANT_READ)).toBe(REQUESTS);
    }, POLL);
    await gate.query('commit');
    const responses = await Promise.all(pending);

    const created = responses.filter((response) => response.status === 201);
    const refused = responses.filter((response) => response.status !== 201);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(REQUESTS - 1);
    for (const response of refused) {
      expect(response.status).toBe(409);
      expect(codeOf(response)).toBe('DUPLICATE_MERCHANT_REFERENCE');
    }
    expect(await intentRows(api, tenant.merchant.id)).toHaveLength(1);
    expect(await creationEvents(api, tenant.merchant.id)).toHaveLength(1);
    const winner =
      keys[responses.findIndex((response) => response.status === 201)];
    expect(
      (await recordRows(api, tenant.merchant.id)).map(
        (row) => row.idempotency_key,
      ),
    ).toEqual([winner]);
  });

  describe('a wait longer than the lock timeout', () => {
    it('answers a claim that waits on a stuck owner of the key with 503 OPERATION_TIMEOUT', async () => {
      const tenant = await merchantWithKeys(api);
      const key = newKey();
      const body = intentBody();
      // An owner whose transaction never ends: an uncommitted claim of the key.
      await gate.query('begin');
      await gate.query(
        `insert into idempotency_records
           (id, merchant_id, operation, idempotency_key, request_fingerprint,
            operation_id, status, created_at, expires_at)
         values ($1, $2, 'CREATE_PAYMENT_INTENT', $3, $4, $5, 'IN_PROGRESS',
                 now(), now() + interval '1 day')`,
        [randomUUID(), tenant.merchant.id, key, 'a'.repeat(64), randomUUID()],
      );
      const before = await snapshotDatabase(api);

      const startedAt = performance.now();
      const pending = start(createIntent(api, tenant.admin.key, key, body));
      await vi.waitFor(async () => {
        expect(await waitingIn(CLAIM)).toBe(1);
      }, POLL);
      const response = await pending;
      const elapsed = performance.now() - startedAt;

      expect(response.status).toBe(503);
      expect(codeOf(response)).toBe('OPERATION_TIMEOUT');
      expect(response.headers['retry-after']).toBe('1');
      // PostgreSQL ended the wait at the lock timeout, before the pool's 5 s
      // query timeout could throw on the client.
      expect(elapsed).toBeGreaterThanOrEqual(
        PAYMENT_COMMAND_LOCK_TIMEOUT_MILLIS - 50,
      );
      expect(elapsed).toBeLessThan(5_000);
      // The server is no longer waiting: the statement was aborted, not left
      // running behind a client that gave up.
      expect(await waitingIn(CLAIM)).toBe(0);
      expect(await snapshotDatabase(api)).toEqual(before);

      await gate.query('rollback');
      const retried = await createIntent(api, tenant.admin.key, key, body);
      expect(retried.status).toBe(201);
    });

    it('answers a command that waits on a stuck merchant status change with 503 and releases its claim', async () => {
      const tenant = await merchantWithKeys(api);
      const key = newKey();
      const body = intentBody();
      await holdMerchantRow(tenant.merchant.id);
      const before = await snapshotDatabase(api);

      const pending = start(createIntent(api, tenant.admin.key, key, body));
      await vi.waitFor(async () => {
        expect(await waitingIn(MERCHANT_READ)).toBe(1);
      }, POLL);
      const response = await pending;

      expect(response.status).toBe(503);
      expect(codeOf(response)).toBe('OPERATION_TIMEOUT');
      expect(response.headers['retry-after']).toBe('1');
      expect(await snapshotDatabase(api)).toEqual(before);

      await gate.query('commit');
      expect(await recordOf(api, tenant.merchant.id, key)).toBeUndefined();
      const retried = await createIntent(api, tenant.admin.key, key, body);
      expect(retried.status).toBe(201);
    });
  });

  describe('a merchant suspension that overlaps a creation', () => {
    it('waits for a creation that read the merchant first, and the creation commits', async () => {
      const tenant = await merchantWithKeys(api);
      const blocker = new Client({
        connectionString: api.postgres.connectionString,
      });
      await blocker.connect();
      try {
        // A creation stopped after its merchant read: the test holds the
        // reference it inserts, so it waits there holding its share lock.
        const body = intentBody();
        await blocker.query('begin');
        await blocker.query(
          `insert into payment_intents
             (id, merchant_id, amount_minor, currency, merchant_reference,
              status, created_at, updated_at)
           values ($1, $2, 1, 'USD', $3, 'CREATED', now(), now())`,
          [randomUUID(), tenant.merchant.id, body.merchant_reference],
        );
        const creation = start(
          createIntent(api, tenant.admin.key, newKey(), body),
        );
        await vi.waitFor(async () => {
          expect(await waitingIn('insert into "payment_intents"')).toBe(1);
        }, POLL);

        // The suspension now waits for the creation's share lock.
        const suspension = start(
          api.post(
            api.platform.key,
            `/api/v1/merchants/${tenant.merchant.id}/status`,
            { status: 'SUSPENDED' },
          ),
        );
        await vi.waitFor(async () => {
          expect(await waitingIn('update "merchants"')).toBe(1);
        }, POLL);

        await blocker.query('rollback');
        const [created, suspended] = await Promise.all([creation, suspension]);
        expect(created.status).toBe(201);
        expect(suspended.status).toBe(200);
      } finally {
        await blocker.end();
      }
    });

    it('makes a creation that starts during a suspension read the new status', async () => {
      const tenant = await merchantWithKeys(api);
      // An uncommitted suspension, as ChangeMerchantStatusService writes it.
      await gate.query('begin');
      await gate.query(
        `update merchants set status = 'SUSPENDED' where id = $1`,
        [tenant.merchant.id],
      );

      const creation = start(
        createIntent(api, tenant.admin.key, newKey(), intentBody()),
      );
      await vi.waitFor(async () => {
        expect(await waitingIn(MERCHANT_READ)).toBe(1);
      }, POLL);
      await gate.query('commit');
      const response = await creation;

      expect(response.status).toBe(403);
      expect(codeOf(response)).toBe('MERCHANT_NOT_ACTIVE');
      expect(await intentRows(api, tenant.merchant.id)).toEqual([]);
      expect(await recordRows(api, tenant.merchant.id)).toEqual([]);
    });
  });
});
