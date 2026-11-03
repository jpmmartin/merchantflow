import { MERCHANT_STATUSES, type MerchantStatus } from '@merchantflow/domain';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { errorResponseSchema } from '../src/modules/errors/api/error-response.js';
import {
  API,
  startMerchantApi,
  type ApiMerchant,
  type MerchantApi,
} from './support/merchant-api.js';

const VALID_TRANSITIONS: ReadonlyArray<
  readonly [MerchantStatus, MerchantStatus]
> = [
  ['DRAFT', 'ACTIVE'],
  ['ACTIVE', 'SUSPENDED'],
  ['SUSPENDED', 'ACTIVE'],
];

const INVALID_TRANSITIONS: ReadonlyArray<
  readonly [MerchantStatus, MerchantStatus]
> = [
  ['DRAFT', 'DRAFT'],
  ['DRAFT', 'SUSPENDED'],
  ['ACTIVE', 'DRAFT'],
  ['ACTIVE', 'ACTIVE'],
  ['SUSPENDED', 'DRAFT'],
  ['SUSPENDED', 'SUSPENDED'],
];

describe('merchant status changes', () => {
  let api: MerchantApi;

  beforeAll(async () => {
    api = await startMerchantApi();
  });

  afterAll(async () => {
    await api.stop();
  });

  const statusPath = (id: string) => `${API}/merchants/${id}/status`;

  async function merchantIn(status: MerchantStatus): Promise<ApiMerchant> {
    const merchant = await api.createMerchant();
    if (status === 'DRAFT') return merchant;
    await api.post(api.platform.key, statusPath(merchant.id), {
      status: 'ACTIVE',
    });
    if (status === 'SUSPENDED') {
      await api.post(api.platform.key, statusPath(merchant.id), {
        status: 'SUSPENDED',
      });
    }
    return (await api.get(api.platform.key, `${API}/merchants/${merchant.id}`))
      .body as ApiMerchant;
  }

  it('covers all nine ordered pairs of statuses', () => {
    expect(VALID_TRANSITIONS.length + INVALID_TRANSITIONS.length).toBe(
      MERCHANT_STATUSES.length * MERCHANT_STATUSES.length,
    );
  });

  it.each(VALID_TRANSITIONS)(
    'moves a merchant from %s to %s, with its clock time and one audit event',
    async (from, to) => {
      const merchant = await merchantIn(from);
      const eventsBefore = await api.auditRows('MERCHANT_STATUS_CHANGED');
      api.clock.advance(90_000);

      const response = await api.post(
        api.platform.key,
        statusPath(merchant.id),
        {
          status: to,
        },
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        ...merchant,
        status: to,
        updated_at: api.clock.now().toISOString(),
      });
      const stored = (
        await api.postgres.client.query(
          'select status, updated_at from merchants where id = $1',
          [merchant.id],
        )
      ).rows[0] as { status: string; updated_at: Date };
      expect(stored.status).toBe(to);
      expect(stored.updated_at.toISOString()).toBe(
        api.clock.now().toISOString(),
      );

      const events = (await api.auditRows('MERCHANT_STATUS_CHANGED')).filter(
        (event) => event.target_id === merchant.id,
      );
      const earlier = eventsBefore.filter(
        (event) => event.target_id === merchant.id,
      );
      const [added] = events.slice(earlier.length);
      expect(events.length - earlier.length).toBe(1);
      expect(added).toMatchObject({
        actor_type: 'API_KEY',
        actor_id: api.platform.id,
        target_type: 'MERCHANT',
        merchant_id: merchant.id,
        metadata: { from, to },
      });
      expect(added?.occurred_at.toISOString()).toBe(
        api.clock.now().toISOString(),
      );
      expect(added?.correlation_id).toBe(response.headers['x-correlation-id']);
    },
  );

  it.each(INVALID_TRANSITIONS)(
    'refuses to move a merchant from %s to %s with its own code and changes nothing',
    async (from, to) => {
      const merchant = await merchantIn(from);
      const before = await api.state();

      const response = await api.post(
        api.platform.key,
        statusPath(merchant.id),
        {
          status: to,
        },
      );

      expect(response.status).toBe(409);
      expect(errorResponseSchema.parse(response.body).error.code).toBe(
        'MERCHANT_TRANSITION_NOT_ALLOWED',
      );
      expect(await api.state()).toEqual(before);
    },
  );

  it('walks the whole lifecycle in order', async () => {
    const merchant = await merchantIn('DRAFT');

    for (const status of ['ACTIVE', 'SUSPENDED', 'ACTIVE'] as const) {
      // Distinct instants, so the events have a defined order to read back.
      api.clock.advance(1_000);
      const response = await api.post(
        api.platform.key,
        statusPath(merchant.id),
        {
          status,
        },
      );
      expect(response.status).toBe(200);
    }

    const events = (await api.auditRows('MERCHANT_STATUS_CHANGED')).filter(
      (event) => event.target_id === merchant.id,
    );
    expect(events.map((event) => event.metadata)).toEqual([
      { from: 'DRAFT', to: 'ACTIVE' },
      { from: 'ACTIVE', to: 'SUSPENDED' },
      { from: 'SUSPENDED', to: 'ACTIVE' },
    ]);
  });

  it.each([
    ['a status that does not exist', { status: 'PENDING_REVIEW' }],
    ['a lowercase status', { status: 'active' }],
    ['a missing status', {}],
    ['an unknown field', { status: 'ACTIVE', reason: 'because' }],
    ['a number', { status: 1 }],
  ])('rejects %s with 400 and changes nothing', async (_name, body) => {
    const merchant = await merchantIn('DRAFT');
    const before = await api.state();

    const response = await api.post(
      api.platform.key,
      statusPath(merchant.id),
      body,
    );

    expect(response.status).toBe(400);
    expect(errorResponseSchema.parse(response.body).error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(await api.state()).toEqual(before);
  });

  it('answers 404 for a merchant that does not exist', async () => {
    const before = await api.state();

    const response = await api.post(
      api.platform.key,
      statusPath('4c1f6a52-7d0e-4f0a-9d53-2f2b6a1c9e10'),
      { status: 'ACTIVE' },
    );

    expect(response.status).toBe(404);
    expect(await api.state()).toEqual(before);
  });

  describe('concurrent changes', () => {
    it('lets exactly one of several simultaneous activations win, each time', async () => {
      for (let round = 0; round < 5; round += 1) {
        const merchant = await merchantIn('DRAFT');

        const responses = await Promise.all(
          Array.from({ length: 8 }, () =>
            api.post(api.platform.key, statusPath(merchant.id), {
              status: 'ACTIVE',
            }),
          ),
        );

        const won = responses.filter((response) => response.status === 200);
        const lost = responses.filter((response) => response.status !== 200);
        expect(won).toHaveLength(1);
        expect(lost).toHaveLength(7);
        for (const response of lost) {
          expect(response.status).toBe(409);
          expect([
            'MERCHANT_STATUS_CONFLICT',
            'MERCHANT_TRANSITION_NOT_ALLOWED',
          ]).toContain(errorResponseSchema.parse(response.body).error.code);
        }
        const events = (await api.auditRows('MERCHANT_STATUS_CHANGED')).filter(
          (event) => event.target_id === merchant.id,
        );
        expect(events).toHaveLength(1);
        const current = await api.get(
          api.platform.key,
          `${API}/merchants/${merchant.id}`,
        );
        expect((current.body as ApiMerchant).status).toBe('ACTIVE');
      }
    });

    it('lets exactly one of a suspension and a second suspension win', async () => {
      const merchant = await merchantIn('ACTIVE');

      const responses = await Promise.all([
        api.post(api.platform.key, statusPath(merchant.id), {
          status: 'SUSPENDED',
        }),
        api.post(api.platform.key, statusPath(merchant.id), {
          status: 'SUSPENDED',
        }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
    });

    it('answers MERCHANT_STATUS_CONFLICT and changes nothing when another change lands between the read and the update', async () => {
      const merchant = await merchantIn('DRAFT');
      // A second connection moves the merchant to ACTIVE and keeps the change
      // uncommitted, so the request still reads DRAFT and then waits for the row.
      const other = new Client({
        connectionString: api.postgres.connectionString,
      });
      await other.connect();
      try {
        await other.query('begin');
        await other.query(
          `update merchants set status = 'ACTIVE', updated_at = created_at where id = $1`,
          [merchant.id],
        );
        const eventsBefore = await api.auditRows('MERCHANT_STATUS_CHANGED');

        const pending = api.post(api.platform.key, statusPath(merchant.id), {
          status: 'ACTIVE',
        });
        const settled = pending.then((response) => response);
        await vi.waitFor(async () => {
          const waiting = await api.postgres.client.query(
            `select count(*)::int as total from pg_stat_activity
             where wait_event_type = 'Lock' and query like 'update "merchants"%'`,
          );
          expect((waiting.rows[0] as { total: number }).total).toBe(1);
        });
        await other.query('commit');
        const response = await settled;

        expect(response.status).toBe(409);
        expect(errorResponseSchema.parse(response.body).error.code).toBe(
          'MERCHANT_STATUS_CONFLICT',
        );
        // The losing request wrote no audit event of its own.
        expect(await api.auditRows('MERCHANT_STATUS_CHANGED')).toEqual(
          eventsBefore,
        );
        const repeated = await api.post(
          api.platform.key,
          statusPath(merchant.id),
          {
            status: 'ACTIVE',
          },
        );
        expect(errorResponseSchema.parse(repeated.body).error.code).toBe(
          'MERCHANT_TRANSITION_NOT_ALLOWED',
        );
      } finally {
        await other.end();
      }
    });
  });
});
