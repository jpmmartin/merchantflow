import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import {
  ERROR_DEFINITIONS,
  type ErrorCode,
} from '../src/modules/errors/api/error-codes.js';
import { errorResponseSchema } from '../src/modules/errors/api/error-response.js';
import {
  API,
  startMerchantApi,
  type MerchantApi,
} from './support/merchant-api.js';
import {
  createIntent,
  creationEvents,
  intentBody,
  intentRows,
  merchantWithKeys,
  newKey,
  recordRows,
  setStatus,
  type ApiPaymentIntent,
} from './support/payment-intents.js';
import { snapshotDatabase } from './support/tenants.js';

const BIGINT_MAX = '9223372036854775807';
const ABOVE_MAX_SAFE_INTEGER = '9007199254740993';

type Tenant = Awaited<ReturnType<typeof merchantWithKeys>>;

describe('GET /payment-intents/:id', () => {
  let api: MerchantApi;
  let a: Tenant;
  let b: Tenant;
  /** What the create command answered for the intent of A, byte for byte. */
  let createdByA: { text: string; body: ApiPaymentIntent };
  let intentOfB: ApiPaymentIntent;

  const pathOf = (id: string) => `${API}/payment-intents/${id}`;

  async function createFor(
    tenant: Tenant,
    overrides: Record<string, unknown> = {},
  ) {
    const response = await createIntent(
      api,
      tenant.admin.key,
      newKey(),
      intentBody(overrides),
    );
    expect(response.status).toBe(201);
    return { text: response.text, body: response.body as ApiPaymentIntent };
  }

  beforeAll(async () => {
    api = await startMerchantApi();
    a = await merchantWithKeys(api);
    b = await merchantWithKeys(api);
    createdByA = await createFor(a);
    intentOfB = (await createFor(b)).body;
  }, 180_000);

  afterAll(async () => {
    await api.stop();
  });

  function expectError(
    response: request.Response,
    code: ErrorCode,
    issues?: unknown,
  ): void {
    expect(response.status).toBe(ERROR_DEFINITIONS[code].status);
    errorResponseSchema.parse(response.body);
    expect(response.body).toEqual({
      error: {
        code,
        message: ERROR_DEFINITIONS[code].message,
        correlationId: response.headers['x-correlation-id'],
        ...(issues === undefined ? {} : { issues }),
      },
    });
  }

  /** An error response as a caller sees it, without the correlation ID. */
  function withoutCorrelation(response: request.Response) {
    const { error } = errorResponseSchema.parse(response.body);
    return {
      status: response.status,
      contentType: response.headers['content-type'],
      contentLength: response.headers['content-length'],
      wwwAuthenticate: response.headers['www-authenticate'],
      error: { ...error, correlationId: '<correlation-id>' },
    };
  }

  /** Runs a request and asserts that it changed no table at all. */
  async function expectNothingChanged(
    send: () => Promise<request.Response>,
  ): Promise<request.Response> {
    const before = await snapshotDatabase(api);
    const response = await send();
    expect(await snapshotDatabase(api)).toEqual(before);
    return response;
  }

  describe('reading an own intent', () => {
    it.each([
      ['MERCHANT_ADMIN', () => a.admin.key],
      ['MERCHANT_READ_ONLY', () => a.readOnly.key],
    ])(
      '%s reads it with the body the create command returned',
      async (_role, key) => {
        const response = await api.get(key(), pathOf(createdByA.body.id));

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toMatch(/^application\/json/);
        expect(response.body).toEqual(createdByA.body);
        // The same bytes, so the key order and every digit match the create
        // response and its replays.
        expect(response.text).toBe(createdByA.text);
        expect(response.body).toMatchObject({
          merchant_id: a.merchant.id,
          amount_minor: '1000',
          currency: 'USD',
          status: 'CREATED',
        });
        expect(typeof (response.body as ApiPaymentIntent).amount_minor).toBe(
          'string',
        );
      },
    );

    it('reads the intent of each merchant with its own key only', async () => {
      const fromB = await api.get(b.readOnly.key, pathOf(intentOfB.id));

      expect(fromB.status).toBe(200);
      expect(fromB.body).toEqual(intentOfB);
    });

    it('takes the merchant from the key and ignores a header, a query parameter, and a path that name another one', async () => {
      const response = await api
        .get(
          a.admin.key,
          `${pathOf(createdByA.body.id)}?merchant_id=${b.merchant.id}&merchantId=${b.merchant.id}`,
        )
        .set('X-Merchant-Id', b.merchant.id);

      expect(response.status).toBe(200);
      expect(response.text).toBe(createdByA.text);
    });

    it('returns the amount exactly at the BIGINT maximum and above the safe integer range', async () => {
      const cases = [
        BIGINT_MAX,
        ABOVE_MAX_SAFE_INTEGER,
        '9007199254740992',
        '1',
      ];
      for (const amount of cases) {
        const created = await createFor(a, { amount_minor: amount });

        const response = await api.get(a.admin.key, pathOf(created.body.id));

        expect(response.status).toBe(200);
        expect((response.body as ApiPaymentIntent).amount_minor).toBe(amount);
        expect(response.text).toContain(`"amount_minor":"${amount}"`);
        expect(response.text).toBe(created.text);
        const stored = await intentRows(api, a.merchant.id);
        expect(
          stored.find((row) => row.id === created.body.id)?.amount_minor,
        ).toBe(amount);
      }
    });
  });

  describe('an intent that is not the merchant’s', () => {
    it.each([
      ['MERCHANT_ADMIN', () => a.admin.key],
      ['MERCHANT_READ_ONLY', () => a.readOnly.key],
    ])(
      'gives %s the same 404 for another merchant’s intent as for a missing one',
      async (_role, key) => {
        const other = await expectNothingChanged(() =>
          api.get(key(), pathOf(intentOfB.id)),
        );
        const missing = await expectNothingChanged(() =>
          api.get(key(), pathOf(randomUUID())),
        );

        expectError(other, 'NOT_FOUND');
        expectError(missing, 'NOT_FOUND');
        expect(withoutCorrelation(other)).toEqual(withoutCorrelation(missing));
        expect(other.text).not.toContain(intentOfB.id);
        expect(other.text).not.toContain(b.merchant.id);
        expect(other.text).not.toContain(intentOfB.merchant_reference);
      },
    );

    it('answers both directions with the same 404', async () => {
      const aAboutB = await api.get(a.admin.key, pathOf(intentOfB.id));
      const bAboutA = await api.get(b.admin.key, pathOf(createdByA.body.id));
      const missing = await api.get(a.admin.key, pathOf(randomUUID()));

      expectError(aAboutB, 'NOT_FOUND');
      expectError(bAboutA, 'NOT_FOUND');
      expect(withoutCorrelation(aAboutB)).toEqual(withoutCorrelation(missing));
      expect(withoutCorrelation(bAboutA)).toEqual(withoutCorrelation(missing));
    });
  });

  describe('a malformed id', () => {
    it.each([
      'not-a-uuid',
      '12345',
      `${randomUUID()}0`,
      randomUUID().replaceAll('-', ''),
      `${randomUUID().slice(0, 35)}g`,
      '%20',
    ])('is a 400 that names no merchant: %s', async (id) => {
      const fromA = await expectNothingChanged(() =>
        api.get(a.admin.key, pathOf(id)),
      );
      const fromB = await api.get(b.readOnly.key, pathOf(id));

      expect(fromA.status).toBe(400);
      errorResponseSchema.parse(fromA.body);
      expect(fromA.body).toMatchObject({
        error: { code: 'VALIDATION_FAILED' },
      });
      // The same answer for every tenant, so the id is checked before any
      // tenant is consulted.
      expect(withoutCorrelation(fromA)).toEqual(withoutCorrelation(fromB));
      expect(fromA.text).not.toContain(a.merchant.id);
    });
  });

  describe('authentication and roles', () => {
    it.each([
      ['an existing intent', () => createdByA.body.id],
      ['an intent of another merchant', () => intentOfB.id],
      ['a missing intent', () => randomUUID()],
      ['a malformed id', () => 'not-a-uuid'],
    ])(
      'gives the platform key 403 INSUFFICIENT_ROLE for %s',
      async (_label, id) => {
        const response = await expectNothingChanged(() =>
          api.get(api.platform.key, pathOf(id())),
        );

        expectError(response, 'INSUFFICIENT_ROLE');
      },
    );

    it('gives the platform key the same 403 whether or not the intent exists', async () => {
      const existing = await api.get(
        api.platform.key,
        pathOf(createdByA.body.id),
      );
      const missing = await api.get(api.platform.key, pathOf(randomUUID()));

      expect(withoutCorrelation(existing)).toEqual(withoutCorrelation(missing));
      expect(existing.text).not.toContain(createdByA.body.id);
    });

    it('answers 401 without a key and with a wrong one', async () => {
      const none = await api.get(undefined, pathOf(createdByA.body.id));
      const wrong = await api.get(
        `mfk_${'0'.repeat(16)}_${'0'.repeat(64)}`,
        pathOf(createdByA.body.id),
      );

      expectError(none, 'UNAUTHENTICATED');
      expectError(wrong, 'UNAUTHENTICATED');
      expect(withoutCorrelation(none)).toEqual(withoutCorrelation(wrong));
    });

    it('answers 401 for a revoked key', async () => {
      const key = await api.keyFor(a.merchant.id, 'MERCHANT_READ_ONLY');
      expect((await api.get(key.key, pathOf(createdByA.body.id))).status).toBe(
        200,
      );
      const revoked = await api.post(
        api.platform.key,
        `${API}/merchants/${a.merchant.id}/api-keys/${key.id}/revoke`,
      );
      expect(revoked.status).toBe(200);

      const response = await api.get(key.key, pathOf(createdByA.body.id));

      expectError(response, 'UNAUTHENTICATED');
    });
  });

  describe('merchant status', () => {
    it('lets a suspended merchant read its intents with both roles, and a reactivated one still reads them', async () => {
      const tenant = await merchantWithKeys(api);
      const created = await createFor(tenant);
      await setStatus(api, tenant.merchant.id, 'SUSPENDED');

      for (const key of [tenant.admin.key, tenant.readOnly.key]) {
        const response = await api.get(key, pathOf(created.body.id));
        expect(response.status).toBe(200);
        expect(response.text).toBe(created.text);
      }

      await setStatus(api, tenant.merchant.id, 'ACTIVE');
      const again = await api.get(tenant.admin.key, pathOf(created.body.id));
      expect(again.text).toBe(created.text);
    });

    it('keeps a suspended merchant’s intents invisible to everyone else', async () => {
      const tenant = await merchantWithKeys(api);
      const created = await createFor(tenant);
      await setStatus(api, tenant.merchant.id, 'SUSPENDED');

      const response = await api.get(a.admin.key, pathOf(created.body.id));

      expectError(response, 'NOT_FOUND');
    });

    it('gives a DRAFT merchant a 404 for every id, since it can have no intents', async () => {
      const draft = await merchantWithKeys(api, 'DRAFT');

      for (const key of [draft.admin.key, draft.readOnly.key]) {
        const own = await api.get(key, pathOf(randomUUID()));
        const other = await api.get(key, pathOf(createdByA.body.id));
        expectError(own, 'NOT_FOUND');
        expect(withoutCorrelation(other)).toEqual(withoutCorrelation(own));
      }
    });

    it('does not look at the merchant status: a row stored for a DRAFT merchant is read', async () => {
      // Not reachable through the API (only an ACTIVE merchant creates an
      // intent and a merchant never returns to DRAFT). The row is written
      // directly to pin that the read depends on the key's merchant and not
      // on the merchant's status.
      const draft = await merchantWithKeys(api, 'DRAFT');
      const id = randomUUID();
      await api.postgres.client.query(
        `insert into payment_intents
           (id, merchant_id, amount_minor, currency, merchant_reference,
            status, created_at, updated_at)
         values ($1, $2, 500, 'USD', 'draft-row', 'CREATED', $3, $3)`,
        [id, draft.merchant.id, api.clock.now()],
      );

      const response = await api.get(draft.readOnly.key, pathOf(id));

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        id,
        merchant_id: draft.merchant.id,
        amount_minor: '500',
      });
    });
  });

  describe('a read has no side effect', () => {
    it('writes no row and no audit event, and touches no idempotency record', async () => {
      const key = newKey();
      const created = await createIntent(
        api,
        a.admin.key,
        key,
        intentBody({ merchant_reference: 'no-side-effect' }),
      );
      const id = (created.body as ApiPaymentIntent).id;
      const before = await snapshotDatabase(api);
      const events = (await creationEvents(api, a.merchant.id)).length;
      const records = await recordRows(api, a.merchant.id);
      const allEvents = (await api.auditRows()).length;

      const responses = [
        await api.get(a.admin.key, pathOf(id)),
        await api.get(a.readOnly.key, pathOf(id)),
        await api.get(a.admin.key, pathOf(intentOfB.id)),
        await api.get(a.admin.key, pathOf(randomUUID())),
        await api.get(a.admin.key, pathOf('not-a-uuid')),
        await api.get(api.platform.key, pathOf(id)),
        await api.get(undefined, pathOf(id)),
      ];

      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 404, 404, 400, 403, 401,
      ]);
      expect(await snapshotDatabase(api)).toEqual(before);
      expect((await creationEvents(api, a.merchant.id)).length).toBe(events);
      expect((await api.auditRows()).length).toBe(allEvents);
      expect(await recordRows(api, a.merchant.id)).toEqual(records);

      // The create key still replays its stored response, unchanged.
      const replay = await createIntent(
        api,
        a.admin.key,
        key,
        intentBody({ merchant_reference: 'no-side-effect' }),
      );
      expect(replay.status).toBe(201);
      expect(replay.text).toBe(created.text);
    });
  });

  describe('a stored row that the domain does not accept', () => {
    it('is an unexpected error that is logged, never a 404 or an altered value', async () => {
      const id = randomUUID();
      // The database check on `currency` is format-only (AD-63), so a code
      // that Money does not support can be stored.
      await api.postgres.client.query(
        `insert into payment_intents
           (id, merchant_id, amount_minor, currency, merchant_reference,
            status, created_at, updated_at)
         values ($1, $2, 700, 'EUR', 'unsupported-currency', 'CREATED', $3, $3)`,
        [id, a.merchant.id, api.clock.now()],
      );

      const response = await expectNothingChanged(() =>
        api.get(a.admin.key, pathOf(id)),
      );

      expectError(response, 'INTERNAL_ERROR');
      expect(response.text).not.toContain('EUR');
      expect(response.text).not.toContain(id);
      const unhandled = api
        .lines()
        .filter(
          (line) =>
            line.msg === 'Unhandled exception' &&
            JSON.stringify(line).includes(id),
        );
      expect(unhandled.length).toBe(1);

      // Another merchant still gets a 404 and learns nothing of the row.
      const other = await api.get(b.admin.key, pathOf(id));
      expectError(other, 'NOT_FOUND');
      // The other intents of the same merchant stay readable.
      const healthy = await api.get(a.admin.key, pathOf(createdByA.body.id));
      expect(healthy.status).toBe(200);
    });
  });
});
