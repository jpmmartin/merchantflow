import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { errorResponseSchema } from '../src/modules/errors/api/error-response.js';
import {
  API,
  START_TIME,
  startMerchantApi,
  type ApiMerchant,
  type MerchantApi,
} from './support/merchant-api.js';

interface Page {
  readonly data: ApiMerchant[];
  readonly next_cursor: string | null;
}

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('merchant list pagination', () => {
  let api: MerchantApi;
  /** Every merchant created for the walks, in creation order. */
  const created: ApiMerchant[] = [];

  beforeAll(async () => {
    api = await startMerchantApi();
    // 12 merchants: three distinct instants, four merchants created at each, so
    // the order inside an instant depends on the id and not on the time.
    for (let instant = 0; instant < 3; instant += 1) {
      api.clock.set(new Date(START_TIME.getTime() + instant * 1_000));
      for (let index = 0; index < 4; index += 1) {
        created.push(await api.createMerchant());
      }
    }
  });

  afterAll(async () => {
    await api.stop();
  });

  const list = (query: string, key = api.platform.key) =>
    api.get(key, `${API}/merchants${query}`);

  const page = (response: request.Response) => response.body as Page;

  /** The order PostgreSQL itself gives: creation time, then id. */
  async function databaseOrder(): Promise<string[]> {
    const rows = await api.postgres.client.query<{ id: string }>(
      'select id from merchants order by created_at, id',
    );
    return rows.rows.map((row) => row.id);
  }

  /** Reads every page with `limit`, running `between` after each page. */
  async function walk(
    limit: number,
    between: (pageNumber: number) => Promise<void> = () => Promise.resolve(),
  ): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const query: string =
        cursor === null
          ? `?limit=${limit}`
          : `?limit=${limit}&cursor=${cursor}`;
      const response = await list(query);
      expect(response.status).toBe(200);
      pages.push(page(response).data.map((merchant) => merchant.id));
      cursor = page(response).next_cursor;
      await between(pages.length);
    } while (cursor !== null);
    return pages;
  }

  it('returns a stable order: creation time, then id', async () => {
    const response = await list('?limit=100');

    const ids = page(response).data.map((merchant) => merchant.id);
    expect(ids).toEqual(await databaseOrder());
    expect(ids).toHaveLength(created.length);
    // Within one instant the order is by id, not by insertion.
    const firstInstant = page(response)
      .data.filter(
        (merchant) => merchant.created_at === START_TIME.toISOString(),
      )
      .map((merchant) => merchant.id);
    expect(firstInstant).toEqual([...firstInstant].sort());
  });

  it('answers the same request with the same page', async () => {
    const first = await list('?limit=5');
    const second = await list('?limit=5');

    expect(second.body).toEqual(first.body);
  });

  it.each([1, 3, 4, 5, 12, 100])(
    'walks every merchant exactly once with a page size of %i',
    async (limit) => {
      const pages = await walk(limit);

      expect(pages.flat()).toEqual(await databaseOrder());
      expect(new Set(pages.flat()).size).toBe(created.length);
      for (const ids of pages.slice(0, -1)) {
        expect(ids).toHaveLength(limit);
      }
    },
  );

  it('ends with next_cursor null on the last page, also when the total is a multiple of the page size', async () => {
    const pages = await walk(4);

    expect(pages).toHaveLength(3);
    const last = await list('?limit=12');
    expect(page(last).next_cursor).toBeNull();
    expect(page(last).data).toHaveLength(12);
  });

  it('keeps the walk stable when merchants are inserted between requests', async () => {
    const existing = await databaseOrder();
    const addedLater: string[] = [];
    const addedEarlier: string[] = [];

    const pages = await walk(4, async (pageNumber) => {
      if (pageNumber === 1) {
        // Created after the whole walk began: it sorts after every existing row.
        api.clock.set(new Date(START_TIME.getTime() + 60_000));
        addedLater.push((await api.createMerchant()).id);
      }
      if (pageNumber === 2) {
        // Inserted behind the cursor, as a slow transaction that commits late
        // would: with offset pagination this shifts every later row by one and
        // repeats a merchant, and a keyset walk does not notice it.
        const id = randomUUID();
        await api.postgres.client.query(
          `insert into merchants (id, legal_name, display_name, business_type,
             industry, country_code, default_currency, status, created_at, updated_at)
           values ($1, 'Early Ltd', 'Early', 'LLC', 'Retail', 'US', 'USD', 'DRAFT', $2, $2)`,
          [id, new Date(START_TIME.getTime() - 60_000)],
        );
        addedEarlier.push(id);
      }
    });

    const seen = pages.flat();
    expect(new Set(seen).size).toBe(seen.length);
    // Nothing that existed when the walk began is missing, in the same order.
    expect(seen.filter((id) => existing.includes(id))).toEqual(existing);
    // A merchant created ahead of the cursor is seen; one behind it is not.
    expect(seen).toContain(addedLater[0]);
    expect(seen).not.toContain(addedEarlier[0]);
  });

  describe('page size', () => {
    it('defaults to 20', async () => {
      const response = await list('');

      expect(response.status).toBe(200);
      expect(page(response).data).toHaveLength(14);
      for (let index = 0; index < 8; index += 1) {
        await api.createMerchant();
      }
      const second = await list('');
      expect(page(second).data).toHaveLength(20);
      expect(page(second).next_cursor).not.toBeNull();
    });

    it('accepts 1 and 100', async () => {
      const one = await list('?limit=1');
      const hundred = await list('?limit=100');

      expect(page(one).data).toHaveLength(1);
      expect(page(one).next_cursor).not.toBeNull();
      expect(hundred.status).toBe(200);
    });

    it.each(['0', '101', '-1', '1000', 'abc', '1.5', '', '1&limit=2'])(
      'rejects limit=%s with 400',
      async (limit) => {
        const response = await list(`?limit=${limit}`);

        expect(response.status).toBe(400);
        expect(errorResponseSchema.parse(response.body).error.code).toBe(
          'VALIDATION_FAILED',
        );
      },
    );

    it('rejects a query parameter it does not know', async () => {
      const response = await list('?limit=5&offset=5');

      expect(response.status).toBe(400);
    });
  });

  describe('cursor', () => {
    const id = randomUUID();
    const INVALID: ReadonlyArray<readonly [string, string]> = [
      ['text outside the base64url alphabet', 'not a cursor!'],
      [
        'base64url that is not JSON',
        Buffer.from('hello').toString('base64url'),
      ],
      ['JSON that is not an object', encode([1, 2])],
      ['JSON of another shape', encode({ x: 1 })],
      ['a time that is not a date', encode({ c: 'yesterday', i: id })],
      [
        'a time without milliseconds',
        encode({ c: '2026-11-03T12:00:00Z', i: id }),
      ],
      [
        'a time with more than milliseconds',
        encode({ c: '2026-11-03T12:00:00.123456Z', i: id }),
      ],
      [
        'an id that is not a UUID',
        encode({ c: START_TIME.toISOString(), i: 'abc' }),
      ],
      ['a missing id', encode({ c: START_TIME.toISOString() })],
      ['an over-long value', 'a'.repeat(201)],
      ['a plain id', id],
    ];

    it.each(INVALID)(
      'rejects %s with 400 and names the cursor',
      async (_name, cursor) => {
        const response = await list(`?cursor=${cursor}`);

        expect(response.status).toBe(400);
        const error = errorResponseSchema.parse(response.body).error;
        expect(error.code).toBe('VALIDATION_FAILED');
        expect(error.issues?.map((issue) => issue.path)).toContainEqual([
          'cursor',
        ]);
      },
    );

    it('rejects an empty cursor', async () => {
      const response = await list('?cursor=');

      expect(response.status).toBe(400);
    });

    it('does not echo the cursor in the error', async () => {
      const response = await list('?cursor=zzzz-distinct-cursor-4f1e');

      expect(JSON.stringify(response.body)).not.toContain('zzzz-distinct');
    });

    it('returns an empty last page for a cursor past the end', async () => {
      const response = await list(
        `?cursor=${encode({ c: '2999-01-01T00:00:00.000Z', i: id })}`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: [], next_cursor: null });
    });

    it('continues exactly after the position it names', async () => {
      const [first, second] = (await databaseOrder()).slice(0, 2);
      const row = (
        await api.postgres.client.query<{ created_at: Date }>(
          'select created_at from merchants where id = $1',
          [first],
        )
      ).rows[0];
      if (row === undefined) throw new Error('missing merchant');

      const response = await list(
        `?limit=1&cursor=${encode({ c: row.created_at.toISOString(), i: first })}`,
      );

      expect(page(response).data.map((merchant) => merchant.id)).toEqual([
        second,
      ]);
    });

    it('lets a merchant key use a cursor without seeing anyone else', async () => {
      const merchant = created[0];
      if (merchant === undefined) throw new Error('no merchant');
      const key = await api.keyFor(merchant.id, 'MERCHANT_READ_ONLY');

      const fromStart = await list('?limit=1', key.key);
      const fromEarly = await list(
        `?cursor=${encode({ c: '2000-01-01T00:00:00.000Z', i: id })}`,
        key.key,
      );
      const fromLate = await list(
        `?cursor=${encode({ c: '2999-01-01T00:00:00.000Z', i: id })}`,
        key.key,
      );

      expect(page(fromStart).data.map((m) => m.id)).toEqual([merchant.id]);
      expect(page(fromStart).next_cursor).toBeNull();
      expect(page(fromEarly).data.map((m) => m.id)).toEqual([merchant.id]);
      expect(page(fromLate).data).toEqual([]);
    });
  });

  it('serves the listing through the index', async () => {
    const plan = await api.postgres.client.query<{ 'QUERY PLAN': string }>(
      `begin;
       set local enable_seqscan = off;
       explain select * from merchants
       where (created_at, id) > ('2026-11-03T12:00:00Z', '00000000-0000-0000-0000-000000000000')
       order by created_at, id limit 5;
       rollback`,
    );
    const text = JSON.stringify(plan);

    expect(text).toContain('merchants_created_at_id_idx');
  });
});
