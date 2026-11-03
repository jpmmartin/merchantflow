import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { errorResponseSchema } from '../src/modules/errors/api/error-response.js';
import {
  API,
  startMerchantApi,
  type ApiMerchant,
  type IssuedKey,
  type MerchantApi,
} from './support/merchant-api.js';

interface Subject {
  readonly merchant: ApiMerchant;
  readonly spare: IssuedKey;
}

interface Mutation {
  readonly action: string;
  readonly send: (api: MerchantApi, subject: Subject) => request.Test;
}

const MUTATIONS: readonly Mutation[] = [
  {
    action: 'MERCHANT_CREATED',
    send: (api) =>
      api.post(api.platform.key, `${API}/merchants`, {
        legal_name: 'Audited Ltd',
        display_name: 'Audited',
        business_type: 'LLC',
        industry: 'Retail',
        country_code: 'US',
        default_currency: 'USD',
      }),
  },
  {
    action: 'MERCHANT_UPDATED',
    send: (api, { merchant }) =>
      api.patch(api.platform.key, `${API}/merchants/${merchant.id}`, {
        industry: 'Software',
      }),
  },
  {
    action: 'MERCHANT_STATUS_CHANGED',
    send: (api, { merchant }) =>
      api.post(api.platform.key, `${API}/merchants/${merchant.id}/status`, {
        status: 'SUSPENDED',
      }),
  },
  {
    action: 'API_KEY_ISSUED',
    send: (api, { merchant }) =>
      api.post(api.platform.key, `${API}/merchants/${merchant.id}/api-keys`, {
        role: 'MERCHANT_ADMIN',
      }),
  },
  {
    action: 'API_KEY_REVOKED',
    send: (api, { merchant, spare }) =>
      api.post(
        api.platform.key,
        `${API}/merchants/${merchant.id}/api-keys/${spare.id}/revoke`,
      ),
  },
];

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('audit events and API keys of the merchant endpoints', () => {
  let api: MerchantApi;

  beforeAll(async () => {
    api = await startMerchantApi();
  });

  afterAll(async () => {
    await api.stop();
  });

  async function subject(): Promise<Subject> {
    const merchant = await api.createActiveMerchant();
    return {
      merchant,
      spare: await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY'),
    };
  }

  describe('audit events', () => {
    it.each(MUTATIONS)(
      '$action: one request writes exactly one event, with the key as actor and the correlation id',
      async (mutation) => {
        const target = await subject();
        const before = await api.auditRows();
        api.clock.advance(1_000);

        const response = await mutation
          .send(api, target)
          .set('X-Correlation-Id', 'audit-correlation-0001');

        expect(response.status).toBeLessThan(300);
        const added = (await api.auditRows()).slice(before.length);
        expect(added).toHaveLength(1);
        expect(added[0]).toMatchObject({
          action: mutation.action,
          actor_type: 'API_KEY',
          actor_id: api.platform.id,
          correlation_id: 'audit-correlation-0001',
        });
        expect(added[0]?.occurred_at.toISOString()).toBe(
          api.clock.now().toISOString(),
        );
      },
    );

    it('writes no event for a read, a refused request, or an invalid one', async () => {
      const target = await subject();
      const admin = await api.keyFor(target.merchant.id, 'MERCHANT_ADMIN');
      const before = await api.auditRows();

      await api.get(api.platform.key, `${API}/merchants`);
      await api.get(admin.key, `${API}/merchants/${target.merchant.id}`);
      await api.post(
        admin.key,
        `${API}/merchants/${target.merchant.id}/status`,
        {
          status: 'SUSPENDED',
        },
      );
      await api.patch(admin.key, `${API}/merchants/${target.merchant.id}`, {
        legal_name: 'Nope Ltd',
      });
      await api.post(api.platform.key, `${API}/merchants`, { legal_name: 1 });
      await api.post(undefined, `${API}/merchants`, {});

      expect(await api.auditRows()).toEqual(before);
    });

    it('writes no event when a revoked key is revoked again', async () => {
      const target = await subject();
      const path = `${API}/merchants/${target.merchant.id}/api-keys/${target.spare.id}/revoke`;
      const first = await api.post(api.platform.key, path);
      const eventsAfterFirst = await api.auditRows('API_KEY_REVOKED');

      const second = await api.post(api.platform.key, path);

      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await api.auditRows('API_KEY_REVOKED')).toEqual(eventsAfterFirst);
    });

    it('records an event whose metadata holds no secret, hash, or key', async () => {
      const target = await subject();
      await api.keyFor(target.merchant.id, 'MERCHANT_ADMIN');

      const hashes = (
        await api.postgres.client.query<{ secret_hash: string }>(
          'select secret_hash from api_keys',
        )
      ).rows.map((row) => row.secret_hash);
      const events = JSON.stringify(await api.auditRows());

      expect(hashes.length).toBeGreaterThan(2);
      for (const hash of hashes) {
        expect(events).not.toContain(hash);
      }
      for (const issued of api.issued) {
        expect(events).not.toContain(issued.secret);
        expect(events).not.toContain(issued.key);
      }
    });
  });

  describe('a failed audit insert', () => {
    async function refuseAuditInserts(action: string) {
      await api.postgres.client.query(
        `create function test_refuse_audit() returns trigger language plpgsql as $$
         begin
           if new.action = tg_argv[0] then
             raise exception 'audit insert refused by the test';
           end if;
           return new;
         end $$`,
      );
      await api.postgres.client.query(
        `create trigger test_refuse_audit before insert on audit_events
         for each row execute function test_refuse_audit('${action}')`,
      );
    }

    async function allowAuditInserts() {
      await api.postgres.client.query(
        'drop trigger test_refuse_audit on audit_events',
      );
      await api.postgres.client.query('drop function test_refuse_audit()');
    }

    it.each(MUTATIONS)(
      '$action: rolls the change back and answers a generic 500',
      async (mutation) => {
        const target = await subject();
        const before = await api.state();
        await refuseAuditInserts(mutation.action);
        let refused: request.Response;
        try {
          refused = await mutation.send(api, target);
        } finally {
          await allowAuditInserts();
        }

        expect(refused.status).toBe(500);
        expect(errorResponseSchema.parse(refused.body).error.code).toBe(
          'INTERNAL_ERROR',
        );
        expect(JSON.stringify(refused.body)).not.toContain(
          'refused by the test',
        );
        // Neither the change nor its key nor any event stayed behind.
        expect(await api.state()).toEqual(before);

        // Without the fault the same request succeeds, so nothing was left
        // half done.
        const retried = await mutation.send(api, target);
        expect(retried.status).toBeLessThan(300);
      },
    );

    it('leaves a revoked-key attempt revocable and the key still working', async () => {
      const target = await subject();
      await refuseAuditInserts('API_KEY_REVOKED');
      try {
        await api.post(
          api.platform.key,
          `${API}/merchants/${target.merchant.id}/api-keys/${target.spare.id}/revoke`,
        );
      } finally {
        await allowAuditInserts();
      }

      const stillWorks = await api.get(
        target.spare.key,
        `${API}/merchants/${target.merchant.id}`,
      );

      expect(stillWorks.status).toBe(200);
    });
  });

  describe('issuing a key', () => {
    it('returns the key once, uncacheable, and never a hash', async () => {
      const merchant = await api.createActiveMerchant();

      const response = await api.post(
        api.platform.key,
        `${API}/merchants/${merchant.id}/api-keys`,
        { role: 'MERCHANT_ADMIN' },
      );

      expect(response.status).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'created_at',
        'id',
        'key',
        'merchant_id',
        'role',
      ]);
      expect(body['merchant_id']).toBe(merchant.id);
      expect(body['role']).toBe('MERCHANT_ADMIN');
      expect(String(body['key'])).toMatch(/^mfk_[0-9a-f]{16}_[0-9a-f]{64}$/);
      const stored = (
        await api.postgres.client.query<{ secret_hash: string }>(
          'select secret_hash from api_keys where id = $1',
          [body['id']],
        )
      ).rows[0];
      expect(response.text).not.toContain(stored?.secret_hash ?? 'missing');
    });

    it('gives a key that authenticates as the merchant with the issued role', async () => {
      const merchant = await api.createActiveMerchant();
      const other = await api.createActiveMerchant();
      const admin = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');
      const readOnly = await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY');

      const own = await api.get(admin.key, `${API}/merchants/${merchant.id}`);
      const renamed = await api.patch(
        admin.key,
        `${API}/merchants/${merchant.id}`,
        {
          display_name: 'By Admin',
        },
      );
      const refused = await api.patch(
        readOnly.key,
        `${API}/merchants/${merchant.id}`,
        { display_name: 'By Reader' },
      );
      const foreign = await api.get(admin.key, `${API}/merchants/${other.id}`);

      expect(own.status).toBe(200);
      expect(renamed.status).toBe(200);
      expect(refused.status).toBe(403);
      expect(foreign.status).toBe(404);
    });

    it('gives each issuance a different key', async () => {
      const merchant = await api.createActiveMerchant();

      const first = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');
      const second = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');

      expect(second.key).not.toBe(first.key);
      expect(second.id).not.toBe(first.id);
    });

    it.each(['DRAFT', 'SUSPENDED'] as const)(
      'issues a key for a %s merchant',
      async (status) => {
        const merchant = await api.createMerchant();
        if (status === 'SUSPENDED') {
          await api.post(
            api.platform.key,
            `${API}/merchants/${merchant.id}/status`,
            {
              status: 'ACTIVE',
            },
          );
          await api.post(
            api.platform.key,
            `${API}/merchants/${merchant.id}/status`,
            {
              status: 'SUSPENDED',
            },
          );
        }

        const response = await api.post(
          api.platform.key,
          `${API}/merchants/${merchant.id}/api-keys`,
          { role: 'MERCHANT_READ_ONLY' },
        );

        expect(response.status).toBe(201);
      },
    );

    it.each([
      ['a platform role', { role: 'PLATFORM_ADMIN' }],
      ['an unknown role', { role: 'ROOT' }],
      ['no role', {}],
      ['an unknown field', { role: 'MERCHANT_ADMIN', merchant_id: 'x' }],
    ])('rejects %s with 400 and issues nothing', async (_name, body) => {
      const merchant = await api.createActiveMerchant();
      const before = await api.state();

      const response = await api.post(
        api.platform.key,
        `${API}/merchants/${merchant.id}/api-keys`,
        body,
      );

      expect(response.status).toBe(400);
      expect(await api.state()).toEqual(before);
    });

    it('answers 404 for a merchant that does not exist', async () => {
      const before = await api.state();

      const response = await api.post(
        api.platform.key,
        `${API}/merchants/4c1f6a52-7d0e-4f0a-9d53-2f2b6a1c9e10/api-keys`,
        { role: 'MERCHANT_ADMIN' },
      );

      expect(response.status).toBe(404);
      expect(await api.state()).toEqual(before);
    });
  });

  describe('revoking a key', () => {
    it('stops the key at its very next request and records the clock time', async () => {
      const merchant = await api.createActiveMerchant();
      const key = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');
      const working = await api.get(key.key, `${API}/merchants/${merchant.id}`);
      api.clock.advance(5_000);

      const response = await api.post(
        api.platform.key,
        `${API}/merchants/${merchant.id}/api-keys/${key.id}/revoke`,
      );
      const after = await api.get(key.key, `${API}/merchants/${merchant.id}`);

      expect(working.status).toBe(200);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: key.id,
        merchant_id: merchant.id,
        role: 'MERCHANT_ADMIN',
        created_at: expect.any(String) as string,
        revoked_at: api.clock.now().toISOString(),
      });
      expect(after.status).toBe(401);
    });

    it('keeps the first revocation time when the key is revoked again', async () => {
      const merchant = await api.createActiveMerchant();
      const key = await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY');
      const path = `${API}/merchants/${merchant.id}/api-keys/${key.id}/revoke`;
      const first = await api.post(api.platform.key, path);
      api.clock.advance(60_000);

      const second = await api.post(api.platform.key, path);

      expect(second.status).toBe(200);
      expect((second.body as { revoked_at: string }).revoked_at).toBe(
        (first.body as { revoked_at: string }).revoked_at,
      );
    });

    it('revokes a key of a suspended merchant, so a compromised key can always be cut off', async () => {
      const merchant = await api.createActiveMerchant();
      const key = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');
      await api.post(
        api.platform.key,
        `${API}/merchants/${merchant.id}/status`,
        {
          status: 'SUSPENDED',
        },
      );

      const response = await api.post(
        api.platform.key,
        `${API}/merchants/${merchant.id}/api-keys/${key.id}/revoke`,
      );

      expect(response.status).toBe(200);
    });

    it('lets exactly one of several simultaneous revocations write the event', async () => {
      const merchant = await api.createActiveMerchant();
      const key = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');

      const responses = await Promise.all(
        Array.from({ length: 6 }, () =>
          api.post(
            api.platform.key,
            `${API}/merchants/${merchant.id}/api-keys/${key.id}/revoke`,
          ),
        ),
      );

      expect(responses.every((response) => response.status === 200)).toBe(true);
      const events = (await api.auditRows('API_KEY_REVOKED')).filter(
        (event) => event.target_id === key.id,
      );
      expect(events).toHaveLength(1);
    });

    it.each([
      [
        'a key of another merchant',
        async () => {
          const other = await api.createActiveMerchant();
          return (await api.keyFor(other.id, 'MERCHANT_ADMIN')).id;
        },
      ],
      ['a platform key', () => Promise.resolve(api.platform.id)],
      [
        'an unknown key',
        () => Promise.resolve('4c1f6a52-7d0e-4f0a-9d53-2f2b6a1c9e10'),
      ],
    ])('answers 404 for %s and revokes nothing', async (_name, pickKeyId) => {
      const merchant = await api.createActiveMerchant();
      const keyId = await pickKeyId();
      const before = await api.state();

      const response = await api.post(
        api.platform.key,
        `${API}/merchants/${merchant.id}/api-keys/${keyId}/revoke`,
      );

      expect(response.status).toBe(404);
      expect(await api.state()).toEqual(before);
    });

    it('rejects a key id that is not a UUID with 400', async () => {
      const merchant = await api.createActiveMerchant();

      const response = await api.post(
        api.platform.key,
        `${API}/merchants/${merchant.id}/api-keys/not-a-uuid/revoke`,
      );

      expect(response.status).toBe(400);
    });

    it('lets a merchant admin key revoke its own key', async () => {
      const merchant = await api.createActiveMerchant();
      const admin = await api.keyFor(merchant.id, 'MERCHANT_ADMIN');

      const response = await api.post(
        admin.key,
        `${API}/merchants/${merchant.id}/api-keys/${admin.id}/revoke`,
      );

      expect(response.status).toBe(200);
      const still = await api.get(admin.key, `${API}/merchants/${merchant.id}`);
      expect(still.status).toBe(401);
    });
  });

  describe('registering a merchant end to end', () => {
    it('lets a platform administrator register a merchant, receive its key once, and keep two merchants apart', async () => {
      const first = await api.createMerchant();
      const second = await api.createMerchant();
      const firstKey = await api.keyFor(first.id, 'MERCHANT_ADMIN');
      const secondKey = await api.keyFor(second.id, 'MERCHANT_ADMIN');

      const own = await api.get(firstKey.key, `${API}/merchants/${first.id}`);
      const crossed = await api.get(
        firstKey.key,
        `${API}/merchants/${second.id}`,
      );
      const reverse = await api.get(
        secondKey.key,
        `${API}/merchants/${first.id}`,
      );

      expect(own.status).toBe(200);
      expect(crossed.status).toBe(404);
      expect(reverse.status).toBe(404);
    });
  });

  describe('secrets', () => {
    it('shows each secret once, in its issuance response, and no hash anywhere', async () => {
      const logs = api.output.join('');
      const rows = JSON.stringify(await api.state());
      const hashes = (
        await api.postgres.client.query<{ secret_hash: string }>(
          'select secret_hash from api_keys',
        )
      ).rows.map((row) => row.secret_hash);
      const responses = api.responses.join('\n');

      // The search is not vacuous: many requests were made and logged.
      expect(api.issued.length).toBeGreaterThan(20);
      expect(
        api.lines().filter((line) => line.msg === 'request completed').length,
      ).toBeGreaterThan(100);

      for (const issued of api.issued) {
        const inResponses = occurrences(responses, issued.secret);
        // The platform key came from the service, not from a response.
        expect(inResponses).toBe(issued.merchantId === null ? 0 : 1);
        expect(logs).not.toContain(issued.secret);
        expect(logs).not.toContain(issued.key);
        expect(rows).not.toContain(issued.secret);
        expect(rows).not.toContain(issued.key);
      }
      for (const hash of hashes) {
        expect(responses).not.toContain(hash);
        expect(logs).not.toContain(hash);
        expect(JSON.stringify(await api.auditRows())).not.toContain(hash);
      }
      expect(responses).not.toContain('secret_hash');
      expect(responses).not.toContain('lookup_id');
    });
  });
});
