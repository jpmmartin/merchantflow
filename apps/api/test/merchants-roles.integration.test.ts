import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import {
  errorResponseSchema,
  type ErrorResponse,
} from '../src/modules/errors/api/error-response.js';
import {
  API,
  startMerchantApi,
  type ApiMerchant,
  type IssuedKey,
  type MerchantApi,
} from './support/merchant-api.js';

/** One merchant with a key of each merchant role and a key to revoke. */
interface Fixture {
  readonly merchant: ApiMerchant;
  readonly admin: IssuedKey;
  readonly readOnly: IssuedKey;
  readonly spare: IssuedKey;
}

type Actor =
  'PLATFORM_ADMIN' | 'MERCHANT_ADMIN' | 'MERCHANT_READ_ONLY' | 'NONE';

interface EndpointCase {
  readonly name: string;
  readonly send: (
    api: MerchantApi,
    key: string | undefined,
    f: Fixture,
  ) => request.Test;
  readonly expected: Record<Actor, number>;
}

const ENDPOINTS: readonly EndpointCase[] = [
  {
    name: 'POST /merchants',
    send: (api, key) =>
      api.post(key, `${API}/merchants`, {
        legal_name: 'Created Ltd',
        display_name: 'Created',
        business_type: 'LLC',
        industry: 'Retail',
        country_code: 'US',
        default_currency: 'USD',
      }),
    expected: {
      PLATFORM_ADMIN: 201,
      MERCHANT_ADMIN: 403,
      MERCHANT_READ_ONLY: 403,
      NONE: 401,
    },
  },
  {
    name: 'GET /merchants',
    send: (api, key) => api.get(key, `${API}/merchants`),
    expected: {
      PLATFORM_ADMIN: 200,
      MERCHANT_ADMIN: 200,
      MERCHANT_READ_ONLY: 200,
      NONE: 401,
    },
  },
  {
    name: 'GET /merchants/:id',
    send: (api, key, f) => api.get(key, `${API}/merchants/${f.merchant.id}`),
    expected: {
      PLATFORM_ADMIN: 200,
      MERCHANT_ADMIN: 200,
      MERCHANT_READ_ONLY: 200,
      NONE: 401,
    },
  },
  {
    name: 'PATCH /merchants/:id',
    send: (api, key, f) =>
      api.patch(key, `${API}/merchants/${f.merchant.id}`, {
        display_name: 'Renamed',
      }),
    expected: {
      PLATFORM_ADMIN: 200,
      MERCHANT_ADMIN: 200,
      MERCHANT_READ_ONLY: 403,
      NONE: 401,
    },
  },
  {
    name: 'POST /merchants/:id/status',
    send: (api, key, f) =>
      api.post(key, `${API}/merchants/${f.merchant.id}/status`, {
        status: 'SUSPENDED',
      }),
    expected: {
      PLATFORM_ADMIN: 200,
      MERCHANT_ADMIN: 403,
      MERCHANT_READ_ONLY: 403,
      NONE: 401,
    },
  },
  {
    name: 'POST /merchants/:id/api-keys',
    send: (api, key, f) =>
      api.post(key, `${API}/merchants/${f.merchant.id}/api-keys`, {
        role: 'MERCHANT_READ_ONLY',
      }),
    expected: {
      PLATFORM_ADMIN: 201,
      MERCHANT_ADMIN: 403,
      MERCHANT_READ_ONLY: 403,
      NONE: 401,
    },
  },
  {
    name: 'POST /merchants/:id/api-keys/:keyId/revoke',
    send: (api, key, f) =>
      api.post(
        key,
        `${API}/merchants/${f.merchant.id}/api-keys/${f.spare.id}/revoke`,
      ),
    expected: {
      PLATFORM_ADMIN: 200,
      MERCHANT_ADMIN: 403,
      MERCHANT_READ_ONLY: 403,
      NONE: 401,
    },
  },
];

const ACTORS: readonly Actor[] = [
  'PLATFORM_ADMIN',
  'MERCHANT_ADMIN',
  'MERCHANT_READ_ONLY',
  'NONE',
];

function errorOf(response: request.Response): ErrorResponse['error'] {
  return errorResponseSchema.parse(response.body).error;
}

/** The error without the one field that legitimately differs per request. */
function withoutCorrelationId(response: request.Response) {
  return { ...errorOf(response), correlationId: '<correlation-id>' };
}

describe('merchant endpoints by role', () => {
  let api: MerchantApi;

  beforeAll(async () => {
    api = await startMerchantApi();
  });

  afterAll(async () => {
    await api.stop();
  });

  async function fixture(): Promise<Fixture> {
    const merchant = await api.createActiveMerchant();
    return {
      merchant,
      admin: await api.keyFor(merchant.id, 'MERCHANT_ADMIN'),
      readOnly: await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY'),
      spare: await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY'),
    };
  }

  function keyOf(actor: Actor, f: Fixture): string | undefined {
    switch (actor) {
      case 'PLATFORM_ADMIN':
        return api.platform.key;
      case 'MERCHANT_ADMIN':
        return f.admin.key;
      case 'MERCHANT_READ_ONLY':
        return f.readOnly.key;
      case 'NONE':
        return undefined;
    }
  }

  describe.each(ENDPOINTS)('$name', (endpoint) => {
    it.each(ACTORS)(
      'answers %s as the authorization model says',
      async (actor) => {
        const f = await fixture();
        const before = await api.state();

        const response = await endpoint.send(api, keyOf(actor, f), f);

        const status = endpoint.expected[actor];
        expect(response.status).toBe(status);
        if (status === 401) {
          expect(errorOf(response).code).toBe('UNAUTHENTICATED');
        }
        if (status === 403) {
          expect(errorOf(response).code).toBe('INSUFFICIENT_ROLE');
        }
        if (status === 401 || status === 403) {
          // A refused request changes neither a table nor the audit trail.
          expect(await api.state()).toEqual(before);
        }
      },
    );
  });

  describe('a merchant key and another merchant', () => {
    let own: Fixture;
    let other: Fixture;
    const unknownId = '4c1f6a52-7d0e-4f0a-9d53-2f2b6a1c9e10';

    beforeAll(async () => {
      own = await fixture();
      other = await fixture();
    });

    /** Every request that names a merchant, aimed at the given merchant. */
    function requestsAbout(merchantId: string, keyId: string) {
      return [
        [
          'GET merchant',
          (key: string) => api.get(key, `${API}/merchants/${merchantId}`),
        ],
        [
          'PATCH merchant, a permitted field',
          (key: string) =>
            api.patch(key, `${API}/merchants/${merchantId}`, {
              display_name: 'Takeover',
            }),
        ],
        [
          'PATCH merchant, a forbidden field',
          (key: string) =>
            api.patch(key, `${API}/merchants/${merchantId}`, {
              legal_name: 'Takeover Ltd',
            }),
        ],
        [
          'PATCH merchant, the status',
          (key: string) =>
            api.patch(key, `${API}/merchants/${merchantId}`, {
              status: 'SUSPENDED',
            }),
        ],
        [
          'POST status',
          (key: string) =>
            api.post(key, `${API}/merchants/${merchantId}/status`, {
              status: 'SUSPENDED',
            }),
        ],
        [
          'POST api key',
          (key: string) =>
            api.post(key, `${API}/merchants/${merchantId}/api-keys`, {
              role: 'MERCHANT_ADMIN',
            }),
        ],
        [
          'POST revoke api key',
          (key: string) =>
            api.post(
              key,
              `${API}/merchants/${merchantId}/api-keys/${keyId}/revoke`,
            ),
        ],
      ] as const;
    }

    it.each([
      ['MERCHANT_ADMIN', () => own.admin.key],
      ['MERCHANT_READ_ONLY', () => own.readOnly.key],
    ] as const)(
      'gives %s a 404 for every request about another merchant, before any role check',
      async (_role, keyOf) => {
        const before = await api.state();

        for (const [name, send] of requestsAbout(
          other.merchant.id,
          other.spare.id,
        )) {
          const response = await send(keyOf());
          expect(response.status, name).toBe(404);
          expect(errorOf(response).code, name).toBe('NOT_FOUND');
        }

        expect(await api.state()).toEqual(before);
      },
    );

    it('gives the same answer for another merchant that exists and for one that does not', async () => {
      const key = own.readOnly.key;
      const existing = requestsAbout(other.merchant.id, other.spare.id);
      const missing = requestsAbout(unknownId, other.spare.id);

      for (const [index, [name, sendExisting]] of existing.entries()) {
        const sendMissing = missing[index]?.[1];
        if (sendMissing === undefined) throw new Error('mismatched cases');
        const first = await sendExisting(key);
        const second = await sendMissing(key);
        expect(second.status, name).toBe(first.status);
        expect(withoutCorrelationId(second), name).toEqual(
          withoutCorrelationId(first),
        );
      }
    });

    it('does not take the merchant from a header or the body', async () => {
      const response = await api
        .patch(own.admin.key, `${API}/merchants/${other.merchant.id}`, {
          display_name: 'Takeover',
        })
        .set('X-Merchant-Id', own.merchant.id);

      expect(response.status).toBe(404);
      const unchanged = await api.get(
        api.platform.key,
        `${API}/merchants/${other.merchant.id}`,
      );
      expect((unchanged.body as ApiMerchant).display_name).toBe(
        other.merchant.display_name,
      );
    });

    it('does not let a key of one merchant revoke a key of another through its own id', async () => {
      const response = await api.post(
        api.platform.key,
        `${API}/merchants/${own.merchant.id}/api-keys/${other.spare.id}/revoke`,
      );

      // Even the platform key cannot revoke it through the wrong merchant.
      expect(response.status).toBe(404);
      const stillWorks = await api.get(
        other.spare.key,
        `${API}/merchants/${other.merchant.id}`,
      );
      expect(stillWorks.status).toBe(200);
    });

    it('lets the platform administrator get a 404 for an unknown merchant', async () => {
      // Naming the status in a profile update is refused as invalid input
      // (400) for a platform key, before the merchant is looked up.
      const cases = requestsAbout(unknownId, other.spare.id).filter(
        ([name]) => name !== 'PATCH merchant, the status',
      );
      for (const [name, send] of cases) {
        const response = await send(api.platform.key);
        expect(response.status, name).toBe(404);
      }
    });
  });

  describe('denied fields and status changes', () => {
    const FORBIDDEN_BODIES: ReadonlyArray<readonly [string, object]> = [
      ['legal_name', { legal_name: 'Renamed Ltd' }],
      ['business_type', { business_type: 'Corporation' }],
      ['country_code', { country_code: 'ES' }],
      ['status', { status: 'SUSPENDED' }],
      ['status to the current value', { status: 'ACTIVE' }],
      ['default_currency', { default_currency: 'EUR' }],
      [
        'a permitted field together with a forbidden one',
        { display_name: 'Renamed', legal_name: 'Renamed Ltd' },
      ],
    ];

    it.each(FORBIDDEN_BODIES)(
      'refuses MERCHANT_ADMIN that sends %s with 403 and changes nothing',
      async (_name, body) => {
        const f = await fixture();
        const before = await api.state();

        const response = await api.patch(
          f.admin.key,
          `${API}/merchants/${f.merchant.id}`,
          body,
        );

        expect(response.status).toBe(403);
        expect(errorOf(response).code).toBe('INSUFFICIENT_ROLE');
        expect(await api.state()).toEqual(before);
      },
    );

    it.each(FORBIDDEN_BODIES.concat([['display_name', { display_name: 'X' }]]))(
      'refuses MERCHANT_READ_ONLY that sends %s with 403 and changes nothing',
      async (_name, body) => {
        const f = await fixture();
        const before = await api.state();

        const response = await api.patch(
          f.readOnly.key,
          `${API}/merchants/${f.merchant.id}`,
          body,
        );

        expect(response.status).toBe(403);
        expect(await api.state()).toEqual(before);
      },
    );

    it.each(['DRAFT', 'ACTIVE', 'SUSPENDED'] as const)(
      'refuses a status change to %s by a merchant key, whatever the current status',
      async (target) => {
        for (const initial of ['DRAFT', 'ACTIVE', 'SUSPENDED'] as const) {
          const merchant = await api.createMerchant();
          if (initial !== 'DRAFT') {
            await api.post(
              api.platform.key,
              `${API}/merchants/${merchant.id}/status`,
              {
                status: 'ACTIVE',
              },
            );
          }
          if (initial === 'SUSPENDED') {
            await api.post(
              api.platform.key,
              `${API}/merchants/${merchant.id}/status`,
              {
                status: 'SUSPENDED',
              },
            );
          }
          const admin = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');
          const readOnly = await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY');
          const before = await api.state();

          for (const key of [admin.key, readOnly.key]) {
            const response = await api.post(
              key,
              `${API}/merchants/${merchant.id}/status`,
              { status: target },
            );
            expect(response.status, `${initial} to ${target}`).toBe(403);
            expect(errorOf(response).code).toBe('INSUFFICIENT_ROLE');
          }

          expect(await api.state()).toEqual(before);
        }
      },
    );

    it('refuses MERCHANT_ADMIN on its own suspended merchant, so it cannot reactivate itself', async () => {
      const f = await fixture();
      await api.post(
        api.platform.key,
        `${API}/merchants/${f.merchant.id}/status`,
        {
          status: 'SUSPENDED',
        },
      );
      const before = await api.state();

      const viaStatus = await api.post(
        f.admin.key,
        `${API}/merchants/${f.merchant.id}/status`,
        { status: 'ACTIVE' },
      );
      const viaPatch = await api.patch(
        f.admin.key,
        `${API}/merchants/${f.merchant.id}`,
        { status: 'ACTIVE' },
      );

      expect(viaStatus.status).toBe(403);
      expect(viaPatch.status).toBe(403);
      expect(await api.state()).toEqual(before);
      const current = await api.get(
        f.admin.key,
        `${API}/merchants/${f.merchant.id}`,
      );
      expect((current.body as ApiMerchant).status).toBe('SUSPENDED');
    });
  });
});
