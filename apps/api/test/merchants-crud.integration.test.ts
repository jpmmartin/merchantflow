import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { errorResponseSchema } from '../src/modules/errors/api/error-response.js';
import {
  API,
  startMerchantApi,
  type ApiMerchant,
  type MerchantApi,
} from './support/merchant-api.js';

const VALID = {
  legal_name: 'Acme Payments Ltd',
  display_name: 'Acme',
  business_type: 'LLC',
  industry: 'Retail',
  country_code: 'US',
  default_currency: 'USD',
};

const MERCHANT_FIELDS = [
  'business_type',
  'country_code',
  'created_at',
  'default_currency',
  'display_name',
  'id',
  'industry',
  'legal_name',
  'status',
  'updated_at',
];

function issuesOf(response: request.Response) {
  return errorResponseSchema.parse(response.body).error.issues;
}

describe('merchant create, read, list, and update', () => {
  let api: MerchantApi;

  beforeAll(async () => {
    api = await startMerchantApi();
  });

  afterAll(async () => {
    await api.stop();
  });

  describe('POST /merchants', () => {
    it('creates a DRAFT merchant with an application id and the clock time', async () => {
      api.clock.set(new Date('2026-11-03T13:30:00.123Z'));

      const response = await api.post(
        api.platform.key,
        `${API}/merchants`,
        VALID,
      );

      expect(response.status).toBe(201);
      const merchant = response.body as ApiMerchant;
      expect(Object.keys(merchant).sort()).toEqual(MERCHANT_FIELDS);
      expect(merchant).toMatchObject({ ...VALID, status: 'DRAFT' });
      expect(merchant.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(merchant.created_at).toBe('2026-11-03T13:30:00.123Z');
      expect(merchant.updated_at).toBe('2026-11-03T13:30:00.123Z');
    });

    it('stores what it returns', async () => {
      const merchant = await api.createMerchant();

      const row = (
        await api.postgres.client.query(
          'select * from merchants where id = $1',
          [merchant.id],
        )
      ).rows[0] as Record<string, unknown>;

      expect(row).toMatchObject({
        id: merchant.id,
        legal_name: merchant.legal_name,
        display_name: merchant.display_name,
        status: 'DRAFT',
        default_currency: 'USD',
      });
    });

    it('trims text and accepts values exactly at the column bounds', async () => {
      const response = await api.post(api.platform.key, `${API}/merchants`, {
        ...VALID,
        legal_name: `  ${'l'.repeat(200)}  `,
        display_name: 'd'.repeat(100),
        business_type: 'b'.repeat(50),
        industry: 'i'.repeat(100),
      });

      expect(response.status).toBe(201);
      expect((response.body as ApiMerchant).legal_name).toBe('l'.repeat(200));
    });

    it('issues no API key', async () => {
      const before = (await api.state()).apiKeys;

      await api.createMerchant();

      expect((await api.state()).apiKeys).toEqual(before);
    });

    it.each([
      ['a missing field', { ...VALID, industry: undefined }, ['industry']],
      ['a blank legal_name', { ...VALID, legal_name: '   ' }, ['legal_name']],
      [
        'a legal_name over 200 characters',
        { ...VALID, legal_name: 'l'.repeat(201) },
        ['legal_name'],
      ],
      [
        'a display_name over 100 characters',
        { ...VALID, display_name: 'd'.repeat(101) },
        ['display_name'],
      ],
      [
        'a business_type over 50 characters',
        { ...VALID, business_type: 'b'.repeat(51) },
        ['business_type'],
      ],
      [
        'an industry over 100 characters',
        { ...VALID, industry: 'i'.repeat(101) },
        ['industry'],
      ],
      [
        'a lowercase country_code',
        { ...VALID, country_code: 'us' },
        ['country_code'],
      ],
      [
        'a three-letter country_code',
        { ...VALID, country_code: 'USA' },
        ['country_code'],
      ],
      [
        'a lowercase default_currency',
        { ...VALID, default_currency: 'usd' },
        ['default_currency'],
      ],
      [
        'a two-letter default_currency',
        { ...VALID, default_currency: 'US' },
        ['default_currency'],
      ],
      ['a number as legal_name', { ...VALID, legal_name: 7 }, ['legal_name']],
      ['an unknown field', { ...VALID, nickname: 'x' }, []],
      ['a status', { ...VALID, status: 'ACTIVE' }, []],
      ['an id', { ...VALID, id: '4c1f6a52-7d0e-4f0a-9d53-2f2b6a1c9e10' }, []],
      [
        'a created_at',
        { ...VALID, created_at: '2020-01-01T00:00:00.000Z' },
        [],
      ],
    ])('rejects %s with 400 and stores nothing', async (_name, body, paths) => {
      const before = await api.state();

      const response = await api.post(
        api.platform.key,
        `${API}/merchants`,
        body,
      );

      expect(response.status).toBe(400);
      expect(errorResponseSchema.parse(response.body).error.code).toBe(
        'VALIDATION_FAILED',
      );
      if (paths.length > 0) {
        expect(issuesOf(response)?.map((issue) => issue.path)).toContainEqual(
          paths,
        );
      }
      expect(await api.state()).toEqual(before);
    });

    it('rejects a body that is not an object, and a missing body', async () => {
      const before = await api.state();

      const array = await api.post(
        api.platform.key,
        `${API}/merchants`,
        [] as never,
      );
      const missing = await api.post(api.platform.key, `${API}/merchants`);

      expect(array.status).toBe(400);
      expect(missing.status).toBe(400);
      expect(await api.state()).toEqual(before);
    });
  });

  describe('GET /merchants/:id', () => {
    it('returns the merchant to the platform key and to its own keys', async () => {
      const merchant = await api.createActiveMerchant();
      const admin = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');
      const readOnly = await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY');

      for (const key of [api.platform.key, admin.key, readOnly.key]) {
        const response = await api.get(key, `${API}/merchants/${merchant.id}`);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ...merchant });
        expect(Object.keys(response.body as object).sort()).toEqual(
          MERCHANT_FIELDS,
        );
      }
    });

    it('still returns a suspended merchant to its own key', async () => {
      const merchant = await api.createActiveMerchant();
      const readOnly = await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY');
      await api.post(
        api.platform.key,
        `${API}/merchants/${merchant.id}/status`,
        {
          status: 'SUSPENDED',
        },
      );

      const response = await api.get(
        readOnly.key,
        `${API}/merchants/${merchant.id}`,
      );

      expect(response.status).toBe(200);
      expect((response.body as ApiMerchant).status).toBe('SUSPENDED');
    });

    it('rejects an id that is not a UUID with 400', async () => {
      const response = await api.get(
        api.platform.key,
        `${API}/merchants/not-a-uuid`,
      );

      expect(response.status).toBe(400);
    });
  });

  describe('GET /merchants', () => {
    it('lists every merchant for the platform key and only its own for a merchant key', async () => {
      const first = await api.createActiveMerchant();
      const second = await api.createActiveMerchant();
      const firstKey = await api.keyFor(first.id, 'MERCHANT_READ_ONLY');
      const secondKey = await api.keyFor(second.id, 'MERCHANT_ADMIN');

      const all = await api.get(api.platform.key, `${API}/merchants?limit=100`);
      const mine = await api.get(firstKey.key, `${API}/merchants`);
      const theirs = await api.get(secondKey.key, `${API}/merchants`);

      const ids = (all.body as { data: ApiMerchant[] }).data.map((m) => m.id);
      expect(ids).toContain(first.id);
      expect(ids).toContain(second.id);
      expect(mine.status).toBe(200);
      expect(mine.body).toEqual({ data: [first], next_cursor: null });
      expect(theirs.body).toEqual({ data: [second], next_cursor: null });
    });
  });

  describe('PATCH /merchants/:id', () => {
    it('lets the platform key change every profile field and nothing else', async () => {
      const merchant = await api.createActiveMerchant();
      api.clock.advance(60_000);

      const response = await api.patch(
        api.platform.key,
        `${API}/merchants/${merchant.id}`,
        {
          legal_name: 'Renamed Holdings Ltd',
          display_name: 'Renamed',
          business_type: 'Corporation',
          industry: 'Software',
          country_code: 'ES',
        },
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ...merchant,
        legal_name: 'Renamed Holdings Ltd',
        display_name: 'Renamed',
        business_type: 'Corporation',
        industry: 'Software',
        country_code: 'ES',
        updated_at: api.clock.now().toISOString(),
      });
      const row = (
        await api.postgres.client.query(
          'select status, default_currency, created_at from merchants where id = $1',
          [merchant.id],
        )
      ).rows[0] as Record<string, unknown>;
      expect(row['status']).toBe('ACTIVE');
      expect(row['default_currency']).toBe('USD');
      expect((row['created_at'] as Date).toISOString()).toBe(
        merchant.created_at,
      );
    });

    it('lets MERCHANT_ADMIN change display_name and industry of its own merchant', async () => {
      const merchant = await api.createActiveMerchant();
      const admin = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');
      api.clock.advance(1_000);

      const response = await api.patch(
        admin.key,
        `${API}/merchants/${merchant.id}`,
        {
          display_name: 'Brand New',
          industry: 'Travel',
        },
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ...merchant,
        display_name: 'Brand New',
        industry: 'Travel',
        updated_at: api.clock.now().toISOString(),
      });
    });

    it('lets MERCHANT_ADMIN edit the profile of its own suspended merchant', async () => {
      const merchant = await api.createActiveMerchant();
      const admin = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');
      await api.post(
        api.platform.key,
        `${API}/merchants/${merchant.id}/status`,
        {
          status: 'SUSPENDED',
        },
      );

      const response = await api.patch(
        admin.key,
        `${API}/merchants/${merchant.id}`,
        {
          display_name: 'Edited While Suspended',
        },
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        display_name: 'Edited While Suspended',
        status: 'SUSPENDED',
      });
      // The audit event keeps the previous value, so the change can be reviewed.
      const [event] = (await api.auditRows('MERCHANT_UPDATED')).filter(
        (row) => row.target_id === merchant.id,
      );
      expect(event?.actor_id).toBe(admin.id);
      expect(event?.metadata).toEqual({
        changed_fields: ['display_name'],
        previous: { display_name: merchant.display_name },
        current: { display_name: 'Edited While Suspended' },
      });
    });

    it.each([
      ['an empty body', {}],
      ['an unknown field', { nickname: 'x' }],
      ['a blank display_name', { display_name: '  ' }],
      ['a display_name over 100 characters', { display_name: 'd'.repeat(101) }],
      ['an id', { id: '4c1f6a52-7d0e-4f0a-9d53-2f2b6a1c9e10' }],
      ['updated_at', { updated_at: '2020-01-01T00:00:00.000Z' }],
    ])(
      'rejects %s with 400 for the platform key and changes nothing',
      async (_name, body) => {
        const merchant = await api.createActiveMerchant();
        const before = await api.state();

        const response = await api.patch(
          api.platform.key,
          `${API}/merchants/${merchant.id}`,
          body,
        );

        expect(response.status).toBe(400);
        expect(errorResponseSchema.parse(response.body).error.code).toBe(
          'VALIDATION_FAILED',
        );
        expect(await api.state()).toEqual(before);
      },
    );

    it.each(['status', 'default_currency'])(
      'refuses the platform key that names %s in a profile update, and changes nothing',
      async (field) => {
        const merchant = await api.createActiveMerchant();
        const before = await api.state();

        const response = await api.patch(
          api.platform.key,
          `${API}/merchants/${merchant.id}`,
          { display_name: 'Renamed', [field]: 'SOMETHING' },
        );

        expect(response.status).toBe(400);
        expect(issuesOf(response)).toEqual([
          { path: [field], code: 'not_updatable' },
        ]);
        expect(await api.state()).toEqual(before);
      },
    );

    it('treats an update that changes no value as no mutation', async () => {
      const merchant = await api.createActiveMerchant();
      const before = await api.state();
      api.clock.advance(5_000);

      const response = await api.patch(
        api.platform.key,
        `${API}/merchants/${merchant.id}`,
        { display_name: merchant.display_name, industry: merchant.industry },
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual(merchant);
      expect(await api.state()).toEqual(before);
    });

    it('chains the audit events of simultaneous updates of the same field', async () => {
      for (let round = 0; round < 5; round += 1) {
        const merchant = await api.createActiveMerchant();

        const responses = await Promise.all(
          ['Alpha', 'Beta', 'Gamma'].map((name) =>
            api.patch(api.platform.key, `${API}/merchants/${merchant.id}`, {
              display_name: name,
            }),
          ),
        );

        expect(responses.every((response) => response.status === 200)).toBe(
          true,
        );
        const events = (await api.auditRows('MERCHANT_UPDATED')).filter(
          (row) => row.target_id === merchant.id,
        );
        expect(events).toHaveLength(3);
        // The row is locked while it is read and changed, so each event starts
        // from the value the previous one produced, with no lost update.
        const steps = events.map((event) => ({
          from: (event.metadata['previous'] as Record<string, string>)[
            'display_name'
          ],
          to: (event.metadata['current'] as Record<string, string>)[
            'display_name'
          ],
        }));
        let value: string | undefined = merchant.display_name;
        const remaining = [...steps];
        while (remaining.length > 0) {
          const index = remaining.findIndex((step) => step.from === value);
          expect(index).toBeGreaterThanOrEqual(0);
          value = remaining.splice(index, 1)[0]?.to;
        }
        const current = await api.get(
          api.platform.key,
          `${API}/merchants/${merchant.id}`,
        );
        expect((current.body as ApiMerchant).display_name).toBe(value);
      }
    });

    it('records only the fields that changed, with their old and new values', async () => {
      const merchant = await api.createActiveMerchant();

      await api.patch(api.platform.key, `${API}/merchants/${merchant.id}`, {
        display_name: merchant.display_name,
        industry: 'Software',
      });

      const [event] = (await api.auditRows('MERCHANT_UPDATED')).filter(
        (row) => row.target_id === merchant.id,
      );
      expect(event?.actor_id).toBe(api.platform.id);
      expect(event?.merchant_id).toBe(merchant.id);
      expect(event?.metadata).toEqual({
        changed_fields: ['industry'],
        previous: { industry: merchant.industry },
        current: { industry: 'Software' },
      });
    });
  });
});
