import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { MERCHANT_STATUSES, type Merchant } from '@merchantflow/domain';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiKeyScope } from '../src/modules/auth/application/api-key-scope.js';
import { parseApiKey } from '../src/modules/auth/application/api-key-secret.js';
import { IssueApiKeyService } from '../src/modules/auth/application/issue-api-key.service.js';
import { RevokeApiKeyService } from '../src/modules/auth/application/revoke-api-key.service.js';
import type { Clock } from '../src/modules/clock/clock.js';
import {
  errorResponseSchema,
  type ErrorResponse,
} from '../src/modules/errors/api/error-response.js';
import { insertMerchant } from '../src/modules/merchants/infrastructure/merchant-queries.js';
import {
  AuthProbeController,
  BareProbeController,
  ClassRolesProbeController,
  PublicClassProbeController,
} from './support/auth-probe.controllers.js';
import {
  startMigratedPostgres,
  type MigratedPostgres,
} from './support/migrated-postgres.js';
import { startApp, type LogLine } from './support/start-app.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
const ACTOR = { actorType: 'SYSTEM', actorId: 'authentication-test' } as const;

interface IssuedKey {
  readonly key: string;
  readonly secret: string;
  readonly lookupId: string;
  readonly apiKeyId: string;
}

function merchant(
  displayName: string,
  status: Merchant['status'] = 'ACTIVE',
): Merchant {
  return {
    id: randomUUID(),
    legalName: `${displayName} Ltd`,
    displayName,
    businessType: 'LLC',
    industry: 'Retail',
    countryCode: 'US',
    defaultCurrency: 'USD',
    status,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** The response without the one field that legitimately differs per request. */
function withoutCorrelationId(body: ErrorResponse) {
  return { error: { ...body.error, correlationId: '<correlation-id>' } };
}

describe('API key authentication and roles', () => {
  let postgres: MigratedPostgres;
  let app: INestApplication;
  let server: Server;
  let lines: () => LogLine[];
  let output: string[];
  let issue: IssueApiKeyService;
  let revoke: RevokeApiKeyService;
  const clock: Clock = { now: () => NOW };

  let acme: Merchant;
  let globex: Merchant;
  let suspended: Merchant;
  let platformKey: IssuedKey;
  let acmeAdminKey: IssuedKey;
  let acmeReadOnlyKey: IssuedKey;
  let globexAdminKey: IssuedKey;
  let suspendedAdminKey: IssuedKey;
  let revokedKey: IssuedKey;
  /** Every key and secret presented or issued, to search the logs for them. */
  const everyIssued: IssuedKey[] = [];
  const everyPresented: string[] = [];

  async function issueKey(scope: ApiKeyScope): Promise<IssuedKey> {
    const result = await issue.execute({
      actor: ACTOR,
      scope,
      correlationId: randomUUID(),
    });
    if (!result.ok) throw new Error('Expected the key to be issued');
    const parsed = parseApiKey(result.key);
    if (parsed === undefined) throw new Error('Expected a well-formed key');
    const issued = {
      key: result.key,
      secret: parsed.secret,
      lookupId: parsed.lookupId,
      apiKeyId: result.apiKey.id,
    };
    everyIssued.push(issued);
    return issued;
  }

  function merchantKey(
    owner: Merchant,
    role: 'MERCHANT_ADMIN' | 'MERCHANT_READ_ONLY',
  ) {
    return issueKey({ kind: 'MERCHANT', merchantId: owner.id, role });
  }

  /** GET with a bearer key; every presented value is remembered for the log search. */
  function get(path: string, authorization?: string) {
    const call = request(server).get(path);
    if (authorization !== undefined) {
      everyPresented.push(authorization);
      call.set('Authorization', authorization);
    }
    return call;
  }

  const bearer = (issued: IssuedKey) => `Bearer ${issued.key}`;

  beforeAll(async () => {
    postgres = await startMigratedPostgres();
    const started = await startApp(postgres.connectionString, {
      clock,
      controllers: [
        AuthProbeController,
        ClassRolesProbeController,
        PublicClassProbeController,
        BareProbeController,
      ],
    });
    app = started.app;
    server = started.server;
    lines = started.lines;
    output = started.output;
    issue = app.get(IssueApiKeyService);
    revoke = app.get(RevokeApiKeyService);

    acme = merchant('Acme');
    globex = merchant('Globex');
    suspended = merchant('Initech', 'SUSPENDED');
    for (const row of [acme, globex, suspended]) {
      await insertMerchant(postgres.db, row);
    }
    platformKey = await issueKey({ kind: 'PLATFORM', role: 'PLATFORM_ADMIN' });
    acmeAdminKey = await merchantKey(acme, 'MERCHANT_ADMIN');
    acmeReadOnlyKey = await merchantKey(acme, 'MERCHANT_READ_ONLY');
    globexAdminKey = await merchantKey(globex, 'MERCHANT_ADMIN');
    suspendedAdminKey = await merchantKey(suspended, 'MERCHANT_ADMIN');
    revokedKey = await merchantKey(acme, 'MERCHANT_ADMIN');
    const revoked = await revoke.execute({
      actor: ACTOR,
      apiKeyId: revokedKey.apiKeyId,
      correlationId: randomUUID(),
    });
    expect(revoked).toMatchObject({ ok: true, outcome: 'REVOKED' });
  });

  afterAll(async () => {
    await app.close();
    await postgres.stop();
  });

  describe('rejected credentials', () => {
    const wellFormed = (lookupId: string, secret: string) =>
      `mfk_${lookupId}_${secret}`;

    // Each case is a different reason to refuse, and the caller must not be
    // able to tell them apart.
    const cases: ReadonlyArray<{
      name: string;
      authorization: () => string | undefined;
    }> = [
      { name: 'a missing header', authorization: () => undefined },
      {
        name: 'a non-Bearer scheme',
        authorization: () =>
          `Basic ${Buffer.from('user:pass').toString('base64')}`,
      },
      {
        name: 'a non-Bearer scheme carrying a real key',
        authorization: () => `Token ${platformKey.key}`,
      },
      { name: 'a scheme without a token', authorization: () => 'Bearer' },
      { name: 'a scheme with an empty token', authorization: () => 'Bearer ' },
      {
        name: 'a malformed key',
        authorization: () => 'Bearer not-an-api-key',
      },
      {
        name: 'a real key with trailing text',
        authorization: () => `Bearer ${platformKey.key} extra`,
      },
      {
        name: 'a real key in upper case',
        authorization: () => `Bearer ${platformKey.key.toUpperCase()}`,
      },
      {
        name: 'a well-formed key with an unknown lookup id',
        authorization: () =>
          `Bearer ${wellFormed('a'.repeat(16), 'b'.repeat(64))}`,
      },
      {
        name: 'a real lookup id with the wrong secret',
        authorization: () =>
          `Bearer ${wellFormed(platformKey.lookupId, '0'.repeat(64))}`,
      },
      {
        name: "another key's secret under a real lookup id",
        authorization: () =>
          `Bearer ${wellFormed(platformKey.lookupId, acmeAdminKey.secret)}`,
      },
      { name: 'a revoked key', authorization: () => bearer(revokedKey) },
    ];

    it.each(cases)(
      'answers $name with 401 and a Bearer challenge',
      async (c) => {
        const response = await get(
          '/api/v1/auth-probe/platform',
          c.authorization(),
        );

        expect(response.status).toBe(401);
        expect(response.headers['www-authenticate']).toBe('Bearer');
        const parsed = errorResponseSchema.parse(response.body);
        expect(parsed.error.code).toBe('UNAUTHENTICATED');
        expect(parsed.error.correlationId).toBe(
          response.headers['x-correlation-id'],
        );
      },
    );

    it('answers every case with the same body and challenge, apart from the correlation ID', async () => {
      const responses = [];
      for (const c of cases) {
        responses.push(
          await get('/api/v1/auth-probe/platform', c.authorization()),
        );
      }

      const reference = responses[0];
      expect(reference).toBeDefined();
      const expected = withoutCorrelationId(
        errorResponseSchema.parse(reference?.body),
      );
      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(
          withoutCorrelationId(errorResponseSchema.parse(response.body)),
        ).toEqual(expected);
        expect(response.headers['www-authenticate']).toBe('Bearer');
        expect(response.headers['content-type']).toBe(
          reference?.headers['content-type'],
        );
        expect(response.headers['content-length']).toBe(
          reference?.headers['content-length'],
        );
      }
    });

    it('rejects the same way on a route that only checks the role', async () => {
      const response = await get(
        '/api/v1/auth-probe/merchant',
        bearer(revokedKey),
      );

      expect(response.status).toBe(401);
      expect(errorResponseSchema.parse(response.body).error.code).toBe(
        'UNAUTHENTICATED',
      );
    });

    it('writes no principal fields on the access line of a rejected request', async () => {
      const response = await get(
        '/api/v1/auth-probe/platform',
        bearer(revokedKey),
      );

      const line = lines().find(
        (entry) =>
          entry.msg === 'request completed' &&
          entry.correlationId === response.headers['x-correlation-id'],
      );
      expect(line).toBeDefined();
      expect(line).not.toHaveProperty('apiKeyId');
      expect(line).not.toHaveProperty('merchantId');
      expect(line).not.toHaveProperty('role');
    });
  });

  describe('accepted credentials', () => {
    it('lets a platform key reach a platform route', async () => {
      const response = await get(
        '/api/v1/auth-probe/platform',
        bearer(platformKey),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        kind: 'PLATFORM',
        role: 'PLATFORM_ADMIN',
        apiKeyId: platformKey.apiKeyId,
        merchantId: null,
      });
    });

    it('lets a merchant admin key reach a merchant route with its own merchant', async () => {
      const response = await get(
        '/api/v1/auth-probe/merchant-admin',
        bearer(acmeAdminKey),
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        kind: 'MERCHANT',
        role: 'MERCHANT_ADMIN',
        apiKeyId: acmeAdminKey.apiKeyId,
        merchantId: acme.id,
      });
    });

    it('lets a read-only merchant key reach a route that lists its role', async () => {
      const response = await get(
        '/api/v1/auth-probe/merchant',
        bearer(acmeReadOnlyKey),
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        kind: 'MERCHANT',
        role: 'MERCHANT_READ_ONLY',
        merchantId: acme.id,
      });
    });

    it('accepts the scheme in any letter case', async () => {
      const response = await get(
        '/api/v1/auth-probe/platform',
        `bEaReR ${platformKey.key}`,
      );

      expect(response.status).toBe(200);
    });

    it('takes the merchant from the key, never from the path or a header', async () => {
      const response = await get(
        `/api/v1/auth-probe/merchants/${globex.id}/whoami`,
        bearer(acmeAdminKey),
      ).set('X-Merchant-Id', globex.id);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        requestedMerchantId: globex.id,
        principal: { kind: 'MERCHANT', merchantId: acme.id },
      });
    });

    it('gives two merchants their own principals at the same time', async () => {
      const [first, second] = await Promise.all([
        get('/api/v1/auth-probe/merchant', bearer(acmeAdminKey)),
        get('/api/v1/auth-probe/merchant', bearer(globexAdminKey)),
      ]);

      expect(first.body).toMatchObject({ merchantId: acme.id });
      expect(second.body).toMatchObject({ merchantId: globex.id });
    });

    it('authenticates the key of a suspended merchant, leaving status rules to the use cases', async () => {
      const response = await get(
        '/api/v1/auth-probe/merchant-admin',
        bearer(suspendedAdminKey),
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ merchantId: suspended.id });
    });

    it('authenticates a key of a merchant in every status', async () => {
      for (const status of MERCHANT_STATUSES) {
        const owner = merchant(`Status ${status}`, status);
        await insertMerchant(postgres.db, owner);
        const key = await merchantKey(owner, 'MERCHANT_ADMIN');

        const response = await get('/api/v1/auth-probe/merchant', bearer(key));

        expect(response.status).toBe(200);
      }
    });
  });

  describe('roles', () => {
    it.each([
      ['a merchant admin on a platform route', '/platform', () => acmeAdminKey],
      [
        'a read-only key on a platform route',
        '/platform',
        () => acmeReadOnlyKey,
      ],
      [
        'a read-only key on an admin-only route',
        '/merchant-admin',
        () => acmeReadOnlyKey,
      ],
      ['a platform key on a merchant route', '/merchant', () => platformKey],
    ])('answers %s with 403', async (_name, path, key) => {
      const response = await get(`/api/v1/auth-probe${path}`, bearer(key()));

      expect(response.status).toBe(403);
      expect(response.headers['www-authenticate']).toBeUndefined();
      const parsed = errorResponseSchema.parse(response.body);
      expect(parsed.error.code).toBe('INSUFFICIENT_ROLE');
      expect(parsed.error.correlationId).toBe(
        response.headers['x-correlation-id'],
      );
    });

    it('applies the roles of a controller to its handlers', async () => {
      const allowed = await Promise.all(
        [acmeAdminKey, acmeReadOnlyKey].map((key) =>
          get('/api/v1/auth-class-probe/inherited', bearer(key)),
        ),
      );
      const denied = await get(
        '/api/v1/auth-class-probe/inherited',
        bearer(platformKey),
      );

      expect(allowed.map((response) => response.status)).toEqual([200, 200]);
      expect(denied.status).toBe(403);
    });

    it("replaces a controller's roles with the handler's own", async () => {
      const platform = await get(
        '/api/v1/auth-class-probe/overridden',
        bearer(platformKey),
      );
      const merchantAdmin = await get(
        '/api/v1/auth-class-probe/overridden',
        bearer(acmeAdminKey),
      );

      expect(platform.status).toBe(200);
      expect(merchantAdmin.status).toBe(403);
    });
  });

  describe('deny by default', () => {
    it.each([
      ['a handler', '/api/v1/auth-probe/undeclared'],
      ['a controller', '/api/v1/auth-bare-probe'],
    ])(
      'denies a route with no metadata on %s, whatever the role',
      async (_n, path) => {
        for (const key of [platformKey, acmeAdminKey, acmeReadOnlyKey]) {
          const response = await get(path, bearer(key));

          expect(response.status).toBe(403);
          expect(errorResponseSchema.parse(response.body).error.code).toBe(
            'INSUFFICIENT_ROLE',
          );
          expect(response.body).not.toHaveProperty('reached');
        }
      },
    );

    it('shows an anonymous caller of such a route the same 401 as any other route', async () => {
      const bare = await get('/api/v1/auth-probe/undeclared');
      const declared = await get('/api/v1/auth-probe/platform');

      expect(bare.status).toBe(401);
      expect(
        withoutCorrelationId(errorResponseSchema.parse(bare.body)),
      ).toEqual(withoutCorrelationId(errorResponseSchema.parse(declared.body)));
    });

    it('logs the misconfigured route once per request, naming the handler', async () => {
      const response = await get(
        '/api/v1/auth-probe/undeclared',
        bearer(platformKey),
      );

      const logged = lines().filter(
        (entry) =>
          entry.correlationId === response.headers['x-correlation-id'] &&
          entry.msg ===
            'route declares neither roles nor public access and was denied',
      );
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        controller: 'AuthProbeController',
        handler: 'undeclared',
      });
    });
  });

  describe('public routes', () => {
    it.each([
      ['a public handler', '/api/v1/auth-probe/public'],
      ['a public controller', '/api/v1/auth-public-class-probe'],
      ['the liveness probe', '/health/live'],
      ['the readiness probe', '/health/ready'],
    ])('serves %s without a key', async (_name, path) => {
      const response = await get(path);

      expect(response.status).toBe(200);
    });

    it('does not look at the key of a public route', async () => {
      const response = await get('/api/v1/auth-probe/public', 'Bearer garbage');

      expect(response.status).toBe(200);
    });

    it('serves the OpenAPI document and its UI without a key outside production', async () => {
      const document = await get('/docs/openapi.json');
      const ui = await get('/docs');

      expect(document.status).toBe(200);
      expect(document.body).toMatchObject({
        info: { title: 'MerchantFlow API' },
      });
      expect(ui.status).toBe(200);
    });

    it('answers an unknown path with 404 and no challenge, with or without a key', async () => {
      const anonymous = await get('/api/v1/nope');
      const keyed = await get('/api/v1/nope', bearer(platformKey));

      for (const response of [anonymous, keyed]) {
        expect(response.status).toBe(404);
        expect(errorResponseSchema.parse(response.body).error.code).toBe(
          'NOT_FOUND',
        );
      }
    });
  });

  describe('revocation', () => {
    it('stops a key at its next request, with no delay and no cache', async () => {
      const key = await merchantKey(acme, 'MERCHANT_ADMIN');
      const before = await get('/api/v1/auth-probe/merchant', bearer(key));
      const concurrent = await Promise.all(
        Array.from({ length: 5 }, () =>
          get('/api/v1/auth-probe/merchant', bearer(key)),
        ),
      );

      const revoked = await revoke.execute({
        actor: ACTOR,
        apiKeyId: key.apiKeyId,
        correlationId: randomUUID(),
      });
      const after = await get('/api/v1/auth-probe/merchant', bearer(key));

      expect(before.status).toBe(200);
      expect(concurrent.map((response) => response.status)).toEqual(
        Array(5).fill(200),
      );
      expect(revoked).toMatchObject({ ok: true, outcome: 'REVOKED' });
      expect(after.status).toBe(401);
      expect(errorResponseSchema.parse(after.body).error.code).toBe(
        'UNAUTHENTICATED',
      );
    });

    it('leaves the other keys of the same merchant working', async () => {
      const response = await get(
        '/api/v1/auth-probe/merchant',
        bearer(acmeReadOnlyKey),
      );

      expect(response.status).toBe(200);
    });
  });

  describe('logs', () => {
    it('adds the key row, role, and merchant to the access line of an authenticated request', async () => {
      const response = await get(
        '/api/v1/auth-probe/merchant-admin',
        bearer(acmeAdminKey),
      );

      const accessLines = lines().filter(
        (entry) =>
          entry.msg === 'request completed' &&
          entry.correlationId === response.headers['x-correlation-id'],
      );
      expect(accessLines).toHaveLength(1);
      expect(accessLines[0]).toMatchObject({
        apiKeyId: acmeAdminKey.apiKeyId,
        role: 'MERCHANT_ADMIN',
        merchantId: acme.id,
        res: { statusCode: 200 },
      });
    });

    it('omits the merchant for a platform key', async () => {
      const response = await get(
        '/api/v1/auth-probe/platform',
        bearer(platformKey),
      );

      const line = lines().find(
        (entry) =>
          entry.msg === 'request completed' &&
          entry.correlationId === response.headers['x-correlation-id'],
      );
      expect(line).toMatchObject({
        apiKeyId: platformKey.apiKeyId,
        role: 'PLATFORM_ADMIN',
      });
      expect(line).not.toHaveProperty('merchantId');
    });

    it('never contains a presented key or a secret, nor a lookup id outside issuance', () => {
      const text = output.join('');
      // The search is not vacuous: the requests above were logged.
      expect(
        lines().filter((entry) => entry.msg === 'request completed').length,
      ).toBeGreaterThan(40);
      expect(everyPresented.length).toBeGreaterThan(40);

      // The lookup id is public and the issuance service logs it by design
      // (AD-45), so it is searched for everywhere except in that line.
      const requestText = lines()
        .filter((entry) => entry['context'] !== 'IssueApiKeyService')
        .map((entry) => JSON.stringify(entry))
        .join('\n');
      for (const issued of everyIssued) {
        expect(text).not.toContain(issued.key);
        expect(text).not.toContain(issued.secret);
        expect(requestText).not.toContain(issued.lookupId);
      }
      for (const presented of everyPresented) {
        const token = presented.split(' ')[1];
        if (token !== undefined && token.length > 0) {
          expect(text).not.toContain(token);
        }
      }
      expect(text.toLowerCase()).not.toContain('authorization');
    });
  });
});
