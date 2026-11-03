import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import {
  ERROR_DEFINITIONS,
  type ErrorCode,
} from '../src/modules/errors/api/error-codes.js';
import { errorResponseSchema } from '../src/modules/errors/api/error-response.js';
import {
  START_TIME,
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
  recordOf,
  recordRows,
  setStatus,
  type ApiPaymentIntent,
} from './support/payment-intents.js';
import { snapshotDatabase } from './support/tenants.js';
import { computeRequestFingerprint } from '../src/modules/idempotency/application/request-fingerprint.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BIGINT_MAX = '9223372036854775807';
const ABOVE_MAX_SAFE_INTEGER = '9007199254740993';

describe('POST /payment-intents', () => {
  let api: MerchantApi;
  let admin: string;
  let merchantId: string;

  beforeAll(async () => {
    api = await startMerchantApi();
    const tenant = await merchantWithKeys(api);
    admin = tenant.admin.key;
    merchantId = tenant.merchant.id;
  });

  afterAll(async () => {
    await api.stop();
  });

  /** Asserts the error shape, the code, and that the body holds nothing else. */
  function expectError(
    response: request.Response,
    code: ErrorCode,
    issues?: unknown,
  ): void {
    expect(response.status).toBe(ERROR_DEFINITIONS[code].status);
    const parsed = errorResponseSchema.parse(response.body);
    expect(response.body).toEqual({
      error: {
        code,
        message: ERROR_DEFINITIONS[code].message,
        correlationId: response.headers['x-correlation-id'],
        ...(issues === undefined ? {} : { issues }),
      },
    });
    expect(parsed.error.correlationId).toBe(
      response.headers['x-correlation-id'],
    );
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

  describe('creation', () => {
    it('creates one intent, one audit event, and one completed record', async () => {
      const key = newKey();
      const body = intentBody();
      const response = await createIntent(api, admin, key, body, {
        'X-Correlation-Id': 'create-intent-0001',
      });

      expect(response.status).toBe(201);
      const intent = response.body as ApiPaymentIntent;
      expect(intent).toEqual({
        id: expect.stringMatching(UUID) as unknown,
        merchant_id: merchantId,
        amount_minor: '1000',
        currency: 'USD',
        merchant_reference: body.merchant_reference,
        status: 'CREATED',
        created_at: START_TIME.toISOString(),
        updated_at: START_TIME.toISOString(),
      });
      expect(Object.keys(intent)).toEqual([
        'id',
        'merchant_id',
        'amount_minor',
        'currency',
        'merchant_reference',
        'status',
        'created_at',
        'updated_at',
      ]);

      const rows = (await intentRows(api, merchantId)).filter(
        (row) => row.id === intent.id,
      );
      expect(rows).toEqual([
        {
          id: intent.id,
          merchant_id: merchantId,
          amount_minor: '1000',
          currency: 'USD',
          merchant_reference: body.merchant_reference,
          status: 'CREATED',
          created_at: START_TIME,
          updated_at: START_TIME,
        },
      ]);

      const events = (await creationEvents(api, merchantId)).filter(
        (event) => event.target_id === intent.id,
      );
      const adminKeyId = api.issued.find((issued) => issued.key === admin)?.id;
      expect(events).toEqual([
        {
          id: expect.stringMatching(UUID) as unknown,
          occurred_at: START_TIME,
          actor_type: 'API_KEY',
          actor_id: adminKeyId,
          action: 'PAYMENT_INTENT_CREATED',
          target_type: 'PAYMENT_INTENT',
          target_id: intent.id,
          merchant_id: merchantId,
          correlation_id: 'create-intent-0001',
          metadata: {
            amount_minor: '1000',
            currency: 'USD',
            status: 'CREATED',
          },
        },
      ]);

      const record = await recordOf(api, merchantId, key);
      expect(record).toMatchObject({
        operation: 'CREATE_PAYMENT_INTENT',
        operation_id: intent.id,
        status: 'COMPLETED',
        response_status_code: 201,
        response_body: response.text,
      });
    });

    it('takes the merchant from the key and ignores an X-Merchant-Id header', async () => {
      const other = await merchantWithKeys(api);
      const response = await createIntent(api, admin, newKey(), intentBody(), {
        'X-Merchant-Id': other.merchant.id,
      });

      expect(response.status).toBe(201);
      expect((response.body as ApiPaymentIntent).merchant_id).toBe(merchantId);
      expect(await intentRows(api, other.merchant.id)).toEqual([]);
    });

    it('refuses merchant_id in the body as an unknown field', async () => {
      const response = await expectNothingChanged(() =>
        createIntent(
          api,
          admin,
          newKey(),
          intentBody({ merchant_id: merchantId }),
        ),
      );

      expectError(response, 'VALIDATION_FAILED', [
        { path: [], code: 'unrecognized_keys' },
      ]);
    });
  });

  describe('replay', () => {
    it('returns a byte-identical status and body and changes no table', async () => {
      const key = newKey();
      const body = intentBody();
      const first = await createIntent(api, admin, key, body);
      api.clock.advance(60_000);

      const replay = await expectNothingChanged(() =>
        createIntent(api, admin, key, body, {
          'X-Correlation-Id': 'replay-intent-0001',
        }),
      );

      expect(first.status).toBe(201);
      expect(replay.status).toBe(first.status);
      expect(replay.text).toBe(first.text);
      expect(replay.headers['content-type']).toBe(
        first.headers['content-type'],
      );
      expect(replay.headers['content-length']).toBe(
        first.headers['content-length'],
      );
      expect(replay.headers['x-correlation-id']).toBe('replay-intent-0001');
    });

    it('replays a request whose JSON differs only in key order and whitespace', async () => {
      const key = newKey();
      const reference = `order-${newKey()}`;
      const first = await createIntent(
        api,
        admin,
        key,
        `{"amount_minor":"2500","currency":"USD","merchant_reference":"${reference}"}`,
      );

      const replay = await expectNothingChanged(() =>
        createIntent(
          api,
          admin,
          key,
          `{ "merchant_reference" : "${reference}",\n  "currency": "USD", "amount_minor": "2500" }`,
        ),
      );

      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.text).toBe(first.text);
    });

    it('replays the stored response after the merchant was suspended', async () => {
      const tenant = await merchantWithKeys(api);
      const key = newKey();
      const body = intentBody();
      const first = await createIntent(api, tenant.admin.key, key, body);
      await setStatus(api, tenant.merchant.id, 'SUSPENDED');

      const replay = await expectNothingChanged(() =>
        createIntent(api, tenant.admin.key, key, body),
      );

      expect(replay.status).toBe(201);
      expect(replay.text).toBe(first.text);
    });

    it('writes no second audit event on repeated replays', async () => {
      const key = newKey();
      const body = intentBody();
      const first = await createIntent(api, admin, key, body);
      const id = (first.body as ApiPaymentIntent).id;

      for (let round = 0; round < 3; round += 1) {
        const replay = await createIntent(api, admin, key, body);
        expect(replay.text).toBe(first.text);
      }

      const events = (await creationEvents(api, merchantId)).filter(
        (event) => event.target_id === id,
      );
      expect(events).toHaveLength(1);
    });
  });

  describe('a request still in progress under the key', () => {
    it('is 409 OPERATION_IN_PROGRESS with Retry-After and changes nothing', async () => {
      // This command claims and completes in one transaction, so it never
      // leaves a committed record in progress; one is written directly, with
      // the fingerprint the same request would have.
      const key = newKey();
      const body = intentBody();
      await api.postgres.client.query(
        `insert into idempotency_records
           (id, merchant_id, operation, idempotency_key, request_fingerprint,
            operation_id, status, created_at, expires_at)
         values ($1, $2, 'CREATE_PAYMENT_INTENT', $3, $4, $5, 'IN_PROGRESS',
                 now(), now() + interval '1 day')`,
        [
          randomUUID(),
          merchantId,
          key,
          computeRequestFingerprint('CREATE_PAYMENT_INTENT', {
            amount_minor: '1000',
            currency: 'USD',
            merchant_reference: String(body.merchant_reference),
          }),
          randomUUID(),
        ],
      );

      const sameRequest = await expectNothingChanged(() =>
        createIntent(api, admin, key, body),
      );
      const otherRequest = await expectNothingChanged(() =>
        createIntent(api, admin, key, { ...body, amount_minor: '1001' }),
      );

      expectError(sameRequest, 'OPERATION_IN_PROGRESS');
      expect(sameRequest.headers['retry-after']).toBe('1');
      expectError(otherRequest, 'IDEMPOTENCY_KEY_REUSED');
    });
  });

  describe('a reused key', () => {
    it.each([
      ['another amount', { amount_minor: '1001' }],
      ['another reference', { merchant_reference: 'order-changed' }],
    ])(
      'with %s is 409 IDEMPOTENCY_KEY_REUSED and changes nothing',
      async (_label, change) => {
        const key = newKey();
        const body = intentBody();
        const first = await createIntent(api, admin, key, body);

        const reused = await expectNothingChanged(() =>
          createIntent(api, admin, key, { ...body, ...change }),
        );

        expect(first.status).toBe(201);
        expectError(reused, 'IDEMPOTENCY_KEY_REUSED');
        expect(reused.headers['retry-after']).toBeUndefined();
      },
    );
  });

  describe('a duplicate merchant_reference', () => {
    it('is 409 DUPLICATE_MERCHANT_REFERENCE under a new key and stores nothing', async () => {
      const body = intentBody();
      const first = await createIntent(api, admin, newKey(), body);
      const secondKey = newKey();

      const duplicate = await expectNothingChanged(() =>
        createIntent(api, admin, secondKey, { ...body, amount_minor: '999' }),
      );

      expect(first.status).toBe(201);
      expectError(duplicate, 'DUPLICATE_MERCHANT_REFERENCE');
      expect(await recordOf(api, merchantId, secondKey)).toBeUndefined();

      // The key was not stored, so it can still create another intent.
      const reused = await createIntent(api, admin, secondKey, intentBody());
      expect(reused.status).toBe(201);
    });

    it('stays a duplicate when the same request is sent again', async () => {
      const body = intentBody();
      await createIntent(api, admin, newKey(), body);
      const key = newKey();

      const once = await createIntent(api, admin, key, body);
      const twice = await createIntent(api, admin, key, body);

      expectError(once, 'DUPLICATE_MERCHANT_REFERENCE');
      expectError(twice, 'DUPLICATE_MERCHANT_REFERENCE');
    });

    it('compares references exactly, so case makes a different order', async () => {
      const lower = await createIntent(
        api,
        admin,
        newKey(),
        intentBody({ merchant_reference: 'case-order-a' }),
      );
      const upper = await createIntent(
        api,
        admin,
        newKey(),
        intentBody({ merchant_reference: 'CASE-ORDER-A' }),
      );

      expect(lower.status).toBe(201);
      expect(upper.status).toBe(201);
    });
  });

  describe('the Idempotency-Key header', () => {
    it('is required: a request without it is 400 IDEMPOTENCY_KEY_MISSING', async () => {
      const response = await expectNothingChanged(() =>
        createIntent(api, admin, undefined, intentBody()),
      );

      expectError(response, 'IDEMPOTENCY_KEY_MISSING');
    });

    it('is checked before the body', async () => {
      const response = await expectNothingChanged(() =>
        createIntent(api, admin, undefined, { amount_minor: 5 }),
      );

      expectError(response, 'IDEMPOTENCY_KEY_MISSING');
    });

    it.each([
      ['empty', ''],
      ['with a space', 'key with-space'],
      ['with a tab', 'key\twith-tab'],
      ['outside ASCII', 'clé-de-paiement'],
      ['256 characters long', 'k'.repeat(256)],
    ])(
      'is 400 IDEMPOTENCY_KEY_INVALID when %s and never echoed',
      async (_label, value) => {
        const response = await expectNothingChanged(() =>
          createIntent(api, admin, value, intentBody()),
        );

        expectError(response, 'IDEMPOTENCY_KEY_INVALID');
        if (value.length > 0) expect(response.text).not.toContain(value);
      },
    );

    it('is invalid when sent twice', async () => {
      // supertest sets each header once, so the request is written by hand
      // with two Idempotency-Key lines.
      if (!api.server.listening) {
        await new Promise<void>((resolve) => {
          api.server.listen(0, '127.0.0.1', resolve);
        });
      }
      const { port } = api.server.address() as AddressInfo;
      const payload = JSON.stringify(intentBody());
      const before = await snapshotDatabase(api);

      const answer = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const call = httpRequest(
            {
              host: '127.0.0.1',
              port,
              method: 'POST',
              path: '/api/v1/payment-intents',
              headers: [
                // A raw header list gets no automatic Host header.
                ['Host', `127.0.0.1:${port}`],
                ['Authorization', `Bearer ${admin}`],
                ['Content-Type', 'application/json'],
                ['Idempotency-Key', 'twice-key-1'],
                ['Idempotency-Key', 'twice-key-2'],
              ].flat(),
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => chunks.push(chunk));
              response.on('end', () => {
                resolve({
                  status: response.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf8'),
                });
              });
            },
          );
          call.on('error', reject);
          call.end(payload);
        },
      );

      expect(answer.status).toBe(400);
      expect(
        errorResponseSchema.parse(JSON.parse(answer.body)).error.code,
      ).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(answer.body).not.toContain('twice-key');
      expect(await snapshotDatabase(api)).toEqual(before);
    });

    it('accepts 255 visible ASCII characters', async () => {
      const key = `${'!~'.repeat(127)}k`;
      const response = await createIntent(api, admin, key, intentBody());

      expect(key).toHaveLength(255);
      expect(response.status).toBe(201);
      expect((await recordOf(api, merchantId, key))?.status).toBe('COMPLETED');
    });
  });

  describe('the merchant status', () => {
    it.each(['DRAFT', 'SUSPENDED'] as const)(
      'refuses a %s merchant with 403 MERCHANT_NOT_ACTIVE and stores nothing',
      async (status) => {
        const tenant = await merchantWithKeys(api, status);

        const response = await expectNothingChanged(() =>
          createIntent(api, tenant.admin.key, newKey(), intentBody()),
        );

        expectError(response, 'MERCHANT_NOT_ACTIVE');
        expect(await recordRows(api, tenant.merchant.id)).toEqual([]);
      },
    );

    it('lets the same request succeed under the same key once the merchant is active again', async () => {
      const tenant = await merchantWithKeys(api, 'SUSPENDED');
      const key = newKey();
      const body = intentBody();

      const refused = await createIntent(api, tenant.admin.key, key, body);
      await setStatus(api, tenant.merchant.id, 'ACTIVE');
      const accepted = await createIntent(api, tenant.admin.key, key, body);

      expectError(refused, 'MERCHANT_NOT_ACTIVE');
      expect(accepted.status).toBe(201);
      expect(await intentRows(api, tenant.merchant.id)).toHaveLength(1);
    });
  });

  describe('roles', () => {
    it('refuses MERCHANT_READ_ONLY with 403 INSUFFICIENT_ROLE', async () => {
      const tenant = await merchantWithKeys(api);

      const response = await expectNothingChanged(() =>
        createIntent(api, tenant.readOnly.key, newKey(), intentBody()),
      );

      expectError(response, 'INSUFFICIENT_ROLE');
    });

    it('refuses PLATFORM_ADMIN with 403 INSUFFICIENT_ROLE', async () => {
      const response = await expectNothingChanged(() =>
        createIntent(api, api.platform.key, newKey(), intentBody()),
      );

      expectError(response, 'INSUFFICIENT_ROLE');
    });

    it('refuses a request without an API key with 401', async () => {
      const response = await expectNothingChanged(() =>
        createIntent(api, undefined, newKey(), intentBody()),
      );

      expectError(response, 'UNAUTHENTICATED');
    });
  });

  describe('the currency', () => {
    it("refuses a currency other than the merchant's with 422 MERCHANT_CURRENCY_MISMATCH", async () => {
      const tenant = await merchantWithKeys(api);
      // Merchant creation accepts USD only, so a merchant with another default
      // currency (synthetic data from before that rule) is written directly.
      await api.postgres.client.query(
        `update merchants set default_currency = 'EUR' where id = $1`,
        [tenant.merchant.id],
      );

      const response = await expectNothingChanged(() =>
        createIntent(api, tenant.admin.key, newKey(), intentBody()),
      );

      expectError(response, 'MERCHANT_CURRENCY_MISMATCH');
      expect(await recordRows(api, tenant.merchant.id)).toEqual([]);
    });

    it.each(['EUR', 'usd', 'ZZZ', '', 840, null])(
      'refuses the unsupported currency %j with 400 and the path',
      async (currency) => {
        const response = await expectNothingChanged(() =>
          createIntent(api, admin, newKey(), intentBody({ currency })),
        );

        expectError(response, 'VALIDATION_FAILED', [
          { path: ['currency'], code: 'invalid_value' },
        ]);
      },
    );
  });

  describe('the amount', () => {
    it.each([
      ['a JSON number', 1000, 'invalid_type'],
      ['null', null, 'invalid_type'],
      ['an empty string', '', 'empty'],
      ['zero', '0', 'not_positive'],
      ['a negative amount', '-1', 'invalid_format'],
      ['negative zero', '-0', 'invalid_format'],
      ['a plus sign', '+1', 'invalid_format'],
      ['a decimal point', '10.00', 'invalid_format'],
      ['an exponent', '1e3', 'invalid_format'],
      ['a hexadecimal prefix', '0x10', 'invalid_format'],
      ['a leading space', ' 100', 'invalid_format'],
      ['a trailing newline', '100\n', 'invalid_format'],
      ['a fullwidth digit', '１００', 'invalid_format'],
      ['a leading zero', '0100', 'leading_zero'],
      ['the BIGINT maximum plus one', '9223372036854775808', 'out_of_range'],
      ['a thousand digits', '9'.repeat(1000), 'out_of_range'],
    ])(
      'refuses %s with the issue %s and stores nothing',
      async (_label, amount, code) => {
        const response = await expectNothingChanged(() =>
          createIntent(
            api,
            admin,
            newKey(),
            intentBody({ amount_minor: amount }),
          ),
        );

        expectError(response, 'VALIDATION_FAILED', [
          { path: ['amount_minor'], code },
        ]);
      },
    );

    it.each([ABOVE_MAX_SAFE_INTEGER, BIGINT_MAX])(
      'refuses %s sent as a JSON number, which is never converted',
      async (digits) => {
        const response = await expectNothingChanged(() =>
          createIntent(
            api,
            admin,
            newKey(),
            `{"amount_minor":${digits},"currency":"USD","merchant_reference":"order-${newKey()}"}`,
          ),
        );

        expectError(response, 'VALIDATION_FAILED', [
          { path: ['amount_minor'], code: 'invalid_type' },
        ]);
      },
    );

    it.each([
      ['the BIGINT maximum', BIGINT_MAX, 9223372036854775807n],
      [
        'a value above Number.MAX_SAFE_INTEGER',
        ABOVE_MAX_SAFE_INTEGER,
        9007199254740993n,
      ],
    ])(
      'stores %s exactly and returns it exactly',
      async (_label, amount, expected) => {
        const key = newKey();
        const response = await createIntent(
          api,
          admin,
          key,
          intentBody({ amount_minor: amount }),
        );

        expect(response.status).toBe(201);
        const intent = response.body as ApiPaymentIntent;
        expect(intent.amount_minor).toBe(amount);
        expect(response.text).toContain(`"amount_minor":"${amount}"`);

        // The text form PostgreSQL stored, and the bigint the pool parses.
        const [row] = (await intentRows(api, merchantId)).filter(
          (candidate) => candidate.id === intent.id,
        );
        expect(row?.amount_minor).toBe(amount);
        const parsed = await api.postgres.db
          .selectFrom('payment_intents')
          .select('amount_minor')
          .where('merchant_id', '=', merchantId)
          .where('id', '=', intent.id)
          .executeTakeFirstOrThrow();
        expect(parsed.amount_minor).toBe(expected);
        expect(typeof parsed.amount_minor).toBe('bigint');

        // The stored response and the audit event carry the same digits.
        expect((await recordOf(api, merchantId, key))?.response_body).toBe(
          response.text,
        );
        const [event] = (await creationEvents(api, merchantId)).filter(
          (candidate) => candidate.target_id === intent.id,
        );
        expect(event?.metadata['amount_minor']).toBe(amount);

        const replay = await createIntent(
          api,
          admin,
          key,
          intentBody({
            amount_minor: amount,
            merchant_reference: intent.merchant_reference,
          }),
        );
        expect(replay.text).toBe(response.text);
      },
    );
  });

  describe('the merchant_reference', () => {
    it.each([
      ['empty', ''],
      ['129 characters long', 'r'.repeat(129)],
      ['with a space', 'order 1'],
      ['with a trailing space', 'order-1 '],
      ['outside ASCII', 'pedido-ñ'],
      ['a number', 1001],
    ])(
      'refuses a reference %s with 400 and the path',
      async (_label, reference) => {
        const response = await expectNothingChanged(() =>
          createIntent(
            api,
            admin,
            newKey(),
            intentBody({ merchant_reference: reference }),
          ),
        );

        expectError(response, 'VALIDATION_FAILED', [
          {
            path: ['merchant_reference'],
            code:
              typeof reference === 'number' ? 'invalid_type' : 'invalid_format',
          },
        ]);
      },
    );

    it('accepts 128 visible ASCII characters', async () => {
      const reference = `${'#'.repeat(64)}${'Z'.repeat(64)}`;
      const response = await createIntent(
        api,
        admin,
        newKey(),
        intentBody({ merchant_reference: reference }),
      );

      expect(response.status).toBe(201);
      expect((response.body as ApiPaymentIntent).merchant_reference).toBe(
        reference,
      );
    });
  });

  describe('what is stored under the key', () => {
    /** The record of `key` after one request, or undefined. */
    async function storedAfter(
      merchant: string,
      key: string,
      send: () => Promise<request.Response>,
    ) {
      const response = await send();
      return { response, record: await recordOf(api, merchant, key) };
    }

    it('stores a created intent and nothing for every refusal', async () => {
      const suspended = await merchantWithKeys(api, 'SUSPENDED');
      const otherCurrency = await merchantWithKeys(api);
      await api.postgres.client.query(
        `update merchants set default_currency = 'EUR' where id = $1`,
        [otherCurrency.merchant.id],
      );
      const taken = intentBody();
      await createIntent(api, admin, newKey(), taken);

      const cases = [
        {
          outcome: 'created',
          merchant: merchantId,
          adminKey: admin,
          body: intentBody(),
          status: 201,
          stored: true,
        },
        {
          outcome: 'duplicate merchant_reference',
          merchant: merchantId,
          adminKey: admin,
          body: { ...taken, amount_minor: '7' },
          status: 409,
          stored: false,
        },
        {
          outcome: 'validation failure',
          merchant: merchantId,
          adminKey: admin,
          body: intentBody({ amount_minor: '0' }),
          status: 400,
          stored: false,
        },
        {
          outcome: 'merchant not active',
          merchant: suspended.merchant.id,
          adminKey: suspended.admin.key,
          body: intentBody(),
          status: 403,
          stored: false,
        },
        {
          outcome: 'currency mismatch',
          merchant: otherCurrency.merchant.id,
          adminKey: otherCurrency.admin.key,
          body: intentBody(),
          status: 422,
          stored: false,
        },
      ];
      for (const entry of cases) {
        const key = newKey();
        const { response, record } = await storedAfter(
          entry.merchant,
          key,
          () => createIntent(api, entry.adminKey, key, entry.body),
        );
        expect(response.status, entry.outcome).toBe(entry.status);
        if (entry.stored) {
          expect(record, entry.outcome).toMatchObject({
            status: 'COMPLETED',
            response_status_code: entry.status,
            response_body: response.text,
          });
        } else {
          expect(record, entry.outcome).toBeUndefined();
        }
      }
    });

    it('leaves the stored record alone for a reused key', async () => {
      const key = newKey();
      const body = intentBody();
      await createIntent(api, admin, key, body);
      const before = await recordOf(api, merchantId, key);

      await createIntent(api, admin, key, { ...body, amount_minor: '2' });

      expect(await recordOf(api, merchantId, key)).toEqual(before);
    });
  });

  describe('another merchant', () => {
    it('uses the same key and merchant_reference independently', async () => {
      const first = await merchantWithKeys(api);
      const second = await merchantWithKeys(api);
      const key = newKey();
      const body = intentBody();

      const fromFirst = await createIntent(api, first.admin.key, key, body);
      const fromSecond = await createIntent(api, second.admin.key, key, body);
      const replayFirst = await createIntent(api, first.admin.key, key, body);

      expect(fromFirst.status).toBe(201);
      expect(fromSecond.status).toBe(201);
      const a = fromFirst.body as ApiPaymentIntent;
      const b = fromSecond.body as ApiPaymentIntent;
      expect(a.id).not.toBe(b.id);
      expect(a.merchant_id).toBe(first.merchant.id);
      expect(b.merchant_id).toBe(second.merchant.id);
      expect(replayFirst.text).toBe(fromFirst.text);
      expect(
        (await intentRows(api, first.merchant.id)).map((row) => row.id),
      ).toEqual([a.id]);
      expect(
        (await intentRows(api, second.merchant.id)).map((row) => row.id),
      ).toEqual([b.id]);
      expect(
        (await recordRows(api, first.merchant.id)).map(
          (row) => row.operation_id,
        ),
      ).toEqual([a.id]);
      expect(
        (await recordRows(api, second.merchant.id)).map(
          (row) => row.operation_id,
        ),
      ).toEqual([b.id]);
    });
  });

  describe('an audit failure', () => {
    it('rolls back the intent and the idempotency claim', async () => {
      await api.postgres.client.query(`
        create function test_reject_intent_audit() returns trigger
        language plpgsql as $$
        begin
          raise exception 'audit insert refused by the test';
        end;
        $$;
        create trigger test_reject_intent_audit
        before insert on audit_events
        for each row when (new.action = 'PAYMENT_INTENT_CREATED')
        execute function test_reject_intent_audit();
      `);
      const key = newKey();
      const body = intentBody();
      const failed = await expectNothingChanged(() =>
        createIntent(api, admin, key, body),
      ).finally(() =>
        api.postgres.client.query(`
          drop trigger test_reject_intent_audit on audit_events;
          drop function test_reject_intent_audit();
        `),
      );

      expectError(failed, 'INTERNAL_ERROR');
      expect(await recordOf(api, merchantId, key)).toBeUndefined();
      const unhandled = api
        .lines()
        .filter((line) => line.msg === 'Unhandled exception');
      expect(unhandled.length).toBeGreaterThan(0);

      // Nothing of the failed request remains, so it can be sent again.
      const retried = await createIntent(api, admin, key, body);
      expect(retried.status).toBe(201);
    });
  });
});
