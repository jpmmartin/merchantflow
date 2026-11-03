import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  errorResponseSchema,
  type ErrorResponse,
} from '../src/modules/errors/api/error-response.js';
import { startMerchantApi, type MerchantApi } from './support/merchant-api.js';
import {
  classifyRoute,
  discoverRoutes,
  type DiscoveredRoute,
} from './support/route-discovery.js';
import {
  TENANT_ROUTES,
  splitRoute,
  urlOf,
  type BuiltRequest,
  type CollectionRoute,
  type CommandRoute,
  type ResourceRoute,
  type TenantResources,
  type TenantRoute,
} from './support/tenant-routes.js';
import {
  SCHEMA_TABLES,
  createTenants,
  rowsMentioning,
  snapshotDatabase,
  type DatabaseSnapshot,
  type Tenant,
  type Tenants,
} from './support/tenants.js';

/*
 * Cross-tenant isolation, driven by TENANT_ROUTES (support/tenant-routes.ts).
 * A later increment adds its routes there; this file changes only when a route
 * needs a new kind of entry.
 */

type MerchantRole = 'MERCHANT_ADMIN' | 'MERCHANT_READ_ONLY';
type TenantName = 'a' | 'b';

const MERCHANT_ROLES: readonly MerchantRole[] = [
  'MERCHANT_ADMIN',
  'MERCHANT_READ_ONLY',
];

/** Every ordered pair of tenants: the caller, then the tenant it addresses. */
const DIRECTIONS: readonly (readonly [TenantName, TenantName])[] = [
  ['a', 'b'],
  ['b', 'a'],
];

const RESOURCE_ROUTES = TENANT_ROUTES.filter(
  (entry): entry is ResourceRoute => entry.kind === 'resource',
);
const COLLECTION_ROUTES = TENANT_ROUTES.filter(
  (entry): entry is CollectionRoute => entry.kind === 'collection',
);
const COMMAND_ROUTES = TENANT_ROUTES.filter(
  (entry): entry is CommandRoute => entry.kind === 'command',
);

/** A name for an entry; routes that repeat are told apart by their body. */
function labelOf(entry: TenantRoute): string {
  const body = entry.request({
    merchantId: 'x',
    apiKeyId: 'y',
    paymentIntentId: 'z',
  }).body;
  return body === undefined
    ? entry.route
    : `${entry.route} {${Object.keys(body).join(', ')}}`;
}

/** A way for a request to name a tenant other than through its path. */
interface Selector {
  readonly name: string;
  readonly value: 'own' | 'target';
  /** The selector travels in the body, so it does not apply to a `GET`. */
  readonly bodyOnly?: true;
  /** Returns undefined when the selector does not apply to the method. */
  readonly apply: (
    method: string,
    built: BuiltRequest,
    id: string,
  ) => { built: BuiltRequest; headers: Record<string, string> } | undefined;
}

function withQuery(built: BuiltRequest, name: string, id: string) {
  const separator = built.path.includes('?') ? '&' : '?';
  return { ...built, path: `${built.path}${separator}${name}=${id}` };
}

const ALL_SELECTORS: readonly Selector[] = [
  {
    name: 'X-Merchant-Id header with its own merchant',
    value: 'own',
    apply: (_method, built, id) => ({
      built,
      headers: { 'X-Merchant-Id': id },
    }),
  },
  {
    name: 'X-Merchant-Id header with the addressed merchant',
    value: 'target',
    apply: (_method, built, id) => ({
      built,
      headers: { 'X-Merchant-Id': id },
    }),
  },
  {
    name: 'merchant_id in the query string',
    value: 'own',
    apply: (_method, built, id) => ({
      built: withQuery(built, 'merchant_id', id),
      headers: {},
    }),
  },
  {
    name: 'merchantId in the query string',
    value: 'own',
    apply: (_method, built, id) => ({
      built: withQuery(built, 'merchantId', id),
      headers: {},
    }),
  },
  {
    name: 'merchant_id in the body',
    value: 'own',
    bodyOnly: true,
    apply: (method, built, id) =>
      method === 'GET'
        ? undefined
        : {
            built: { ...built, body: { ...built.body, merchant_id: id } },
            headers: {},
          },
  },
];

/** The selectors that apply to a route, by its method. */
function selectorsFor(route: string): readonly Selector[] {
  const { method } = splitRoute(route);
  return ALL_SELECTORS.filter(
    (selector) => !(selector.bodyOnly === true && method === 'GET'),
  );
}

function errorOf(response: request.Response): ErrorResponse['error'] {
  return errorResponseSchema.parse(response.body).error;
}

const COMPARED_HEADERS = [
  'content-type',
  'content-length',
  'cache-control',
  'www-authenticate',
] as const;

/**
 * What a caller can observe of a response, without the correlation ID, which
 * differs per request by design.
 */
function observable(response: request.Response) {
  return {
    status: response.status,
    headers: Object.fromEntries(
      COMPARED_HEADERS.map((name) => [name, response.headers[name]]),
    ),
    body:
      response.status >= 400
        ? { error: { ...errorOf(response), correlationId: '<correlation-id>' } }
        : (response.body as unknown),
  };
}

function expectUnchanged(
  before: DatabaseSnapshot,
  after: DatabaseSnapshot,
  context: string,
): void {
  expect(Object.keys(after), 'tables').toEqual(Object.keys(before));
  for (const table of Object.keys(before)) {
    expect(after[table], `${table} changed after ${context}`).toEqual(
      before[table],
    );
  }
}

describe('tenant isolation', () => {
  let api: MerchantApi;
  let tenants: Tenants;

  beforeAll(async () => {
    api = await startMerchantApi();
    tenants = await createTenants(api);
  }, 180_000);

  afterAll(async () => {
    await api.stop();
  });

  function keyOf(tenant: Tenant, role: MerchantRole): string {
    return role === 'MERCHANT_ADMIN' ? tenant.admin.key : tenant.readOnly.key;
  }

  function send(
    key: string | undefined,
    route: string,
    built: BuiltRequest,
    headers: Record<string, string> = {},
  ): request.Test {
    const { method } = splitRoute(route);
    const url = urlOf(built);
    let call: request.Test;
    switch (method) {
      case 'GET':
        call = api.get(key, url);
        break;
      case 'POST':
        call = api.post(key, url, built.body);
        break;
      case 'PATCH':
        call = api.patch(key, url, built.body ?? {});
        break;
      default:
        throw new Error(`Unsupported method in ${route}`);
    }
    for (const [name, value] of Object.entries({
      ...built.headers,
      ...headers,
    })) {
      call.set(name, value);
    }
    return call;
  }

  describe('the database snapshot', () => {
    it('reads every table of the schema', async () => {
      const snapshot = await snapshotDatabase(api);
      for (const table of SCHEMA_TABLES) {
        expect(Object.keys(snapshot)).toContain(table);
      }
      expect(snapshot['merchants']?.length).toBeGreaterThanOrEqual(2);
      expect(snapshot['api_keys']?.length).toBeGreaterThanOrEqual(7);
      expect(snapshot['audit_events']?.length).toBeGreaterThan(0);
    });

    it('detects a change in any table', async () => {
      const before = await snapshotDatabase(api);
      await api.postgres.client.query(
        `update merchants set display_name = display_name || '.' where id = $1`,
        [tenants.b.merchant.id],
      );
      const after = await snapshotDatabase(api);
      await api.postgres.client.query(
        `update merchants set display_name = left(display_name, -1) where id = $1`,
        [tenants.b.merchant.id],
      );
      expect(after['merchants']).not.toEqual(before['merchants']);
      expect(after['api_keys']).toEqual(before['api_keys']);
    });
  });

  describe('routes that the valid requests reach', () => {
    it.each(RESOURCE_ROUTES.map((entry) => [labelOf(entry), entry] as const))(
      'gives the platform key the declared answers for %s with an existing and a missing target',
      async (_label, entry) => {
        // Fresh tenants: the request may change what it addresses.
        const fresh = await createTenants(api);
        const existing = await send(
          fresh.platform.key,
          entry.route,
          entry.request(fresh.a.resources),
        );
        expect(existing.status).toBe(entry.platformExisting);

        const before = await snapshotDatabase(api);
        const missing = await send(
          fresh.platform.key,
          entry.route,
          entry.request(fresh.missing),
        );
        expect(missing.status).toBe(entry.platformMissing);
        expectUnchanged(before, await snapshotDatabase(api), labelOf(entry));
      },
    );
  });

  describe.each(
    RESOURCE_ROUTES.map((entry) => [labelOf(entry), entry] as const),
  )('cross-tenant access: %s', (_label, entry) => {
    for (const [from, to] of DIRECTIONS) {
      for (const role of MERCHANT_ROLES) {
        it(`${role} of ${from.toUpperCase()} gets a 404 about ${to.toUpperCase()} identical to a missing resource`, async () => {
          const caller = tenants[from];
          const target = tenants[to];
          const key = keyOf(caller, role);
          const before = await snapshotDatabase(api);

          const response = await send(
            key,
            entry.route,
            entry.request(target.resources),
          );
          const missing = await send(
            key,
            entry.route,
            entry.request(tenants.missing),
          );

          expect(response.status).toBe(404);
          expect(errorOf(response).code).toBe('NOT_FOUND');
          expect(observable(response)).toEqual(observable(missing));
          expect(response.text).not.toContain(target.merchant.id);
          expect(response.text).not.toContain(target.resources.paymentIntentId);
          expectUnchanged(
            before,
            await snapshotDatabase(api),
            `${role} of ${from} on ${to}`,
          );
        });

        for (const selector of selectorsFor(entry.route)) {
          it(`${role} of ${from.toUpperCase()} about ${to.toUpperCase()} with ${selector.name} is refused like a missing resource`, async () => {
            const caller = tenants[from];
            const target = tenants[to];
            const key = keyOf(caller, role);
            const id =
              selector.value === 'own'
                ? caller.merchant.id
                : target.merchant.id;
            const { method } = splitRoute(entry.route);
            const aimed = selector.apply(
              method,
              entry.request(target.resources),
              id,
            );
            const blank = selector.apply(
              method,
              entry.request(tenants.missing),
              id,
            );
            if (aimed === undefined || blank === undefined) return;
            const before = await snapshotDatabase(api);

            const response = await send(
              key,
              entry.route,
              aimed.built,
              aimed.headers,
            );
            const missing = await send(
              key,
              entry.route,
              blank.built,
              blank.headers,
            );

            // A body that names a field is invalid input (400) for both,
            // which says nothing about either merchant.
            expect([400, 404]).toContain(response.status);
            expect(observable(response)).toEqual(observable(missing));
            expect(response.text).not.toContain(target.merchant.id);
            expectUnchanged(
              before,
              await snapshotDatabase(api),
              `${role} of ${from} on ${to} with ${selector.name}`,
            );
          });
        }
      }
    }
  });

  describe('a child resource addressed through the wrong parent', () => {
    const nested = RESOURCE_ROUTES.filter((entry) => entry.nested === true);

    it('has at least one nested route', () => {
      expect(nested.length).toBeGreaterThan(0);
    });

    describe.each(nested.map((entry) => [labelOf(entry), entry] as const))(
      '%s',
      (_label, entry) => {
        for (const [from, to] of DIRECTIONS) {
          /** The parent of `from` with the child of `to`. */
          const wrongParent = (): TenantResources => ({
            ...tenants[to].resources,
            merchantId: tenants[from].merchant.id,
          });
          /** The same parent with a child that exists nowhere. */
          const unknownChild = (): TenantResources => ({
            ...tenants.missing,
            merchantId: tenants[from].merchant.id,
          });

          it(`the platform key gets a 404 for the key of ${to.toUpperCase()} through ${from.toUpperCase()} and nothing changes`, async () => {
            const before = await snapshotDatabase(api);

            const response = await send(
              tenants.platform.key,
              entry.route,
              entry.request(wrongParent()),
            );
            const missing = await send(
              tenants.platform.key,
              entry.route,
              entry.request(unknownChild()),
            );

            expect(response.status).toBe(entry.platformMissing);
            expect(errorOf(response).code).toBe('NOT_FOUND');
            expect(observable(response)).toEqual(observable(missing));
            expectUnchanged(
              before,
              await snapshotDatabase(api),
              'wrong parent',
            );
            const stillWorks = await api.get(
              tenants[to].spare.key,
              `/api/v1/merchants/${tenants[to].merchant.id}`,
            );
            expect(stillWorks.status).toBe(200);
          });

          for (const role of MERCHANT_ROLES) {
            it(`${role} of ${from.toUpperCase()} cannot reach the key of ${to.toUpperCase()} through its own path`, async () => {
              const key = keyOf(tenants[from], role);
              const before = await snapshotDatabase(api);

              const response = await send(
                key,
                entry.route,
                entry.request(wrongParent()),
              );
              const missing = await send(
                key,
                entry.route,
                entry.request(unknownChild()),
              );

              // The role check answers before any key is looked up, so the
              // answer is the same for a key that exists and one that does not.
              expect([403, 404]).toContain(response.status);
              expect(observable(response)).toEqual(observable(missing));
              expectUnchanged(
                before,
                await snapshotDatabase(api),
                'wrong parent',
              );
            });

            it(`${role} of ${from.toUpperCase()} gets a 404 for the key of ${to.toUpperCase()} through the path of ${to.toUpperCase()}`, async () => {
              const key = keyOf(tenants[from], role);
              const before = await snapshotDatabase(api);

              const response = await send(
                key,
                entry.route,
                entry.request(tenants[to].resources),
              );

              expect(response.status).toBe(404);
              expectUnchanged(before, await snapshotDatabase(api), 'wrong key');
            });
          }
        }

        it('does not let the platform key reach a platform key through a merchant path', async () => {
          const before = await snapshotDatabase(api);

          const response = await send(
            tenants.platform.key,
            entry.route,
            entry.request({
              ...tenants.a.resources,
              apiKeyId: tenants.platform.id,
            }),
          );

          expect(response.status).toBe(404);
          expectUnchanged(before, await snapshotDatabase(api), 'platform key');
          const stillWorks = await api.get(
            tenants.platform.key,
            '/api/v1/merchants',
          );
          expect(stillWorks.status).toBe(200);
        });
      },
    );
  });

  describe.each(
    COLLECTION_ROUTES.map((entry) => [labelOf(entry), entry] as const),
  )('collections: %s', (_label, entry) => {
    for (const [from, to] of DIRECTIONS) {
      for (const role of MERCHANT_ROLES) {
        it(`${role} of ${from.toUpperCase()} sees only its own resources`, async () => {
          const caller = tenants[from];
          const target = tenants[to];

          const response = await send(
            keyOf(caller, role),
            entry.route,
            entry.request(caller.resources),
          );

          expect(response.status).toBe(200);
          expect(response.text).toContain(caller.merchant.id);
          expect(response.text).not.toContain(target.merchant.id);
          expect(response.text).not.toContain(target.spare.id);
        });

        for (const selector of selectorsFor(entry.route)) {
          it(`${role} of ${from.toUpperCase()} with ${selector.name} sees nothing of ${to.toUpperCase()}`, async () => {
            const caller = tenants[from];
            const target = tenants[to];
            const id =
              selector.value === 'own'
                ? caller.merchant.id
                : target.merchant.id;
            const aimed = selector.apply(
              splitRoute(entry.route).method,
              entry.request(caller.resources),
              id,
            );
            if (aimed === undefined) return;
            const before = await snapshotDatabase(api);

            const response = await send(
              keyOf(caller, role),
              entry.route,
              aimed.built,
              aimed.headers,
            );

            // A parameter the route does not define is invalid input (400);
            // one it ignores gives the caller's own data. Never the other's.
            expect([200, 400]).toContain(response.status);
            expect(response.text).not.toContain(target.merchant.id);
            expect(response.text).not.toContain(target.spare.id);
            expectUnchanged(before, await snapshotDatabase(api), 'a list');
          });
        }
      }
    }
  });

  describe.each(
    COMMAND_ROUTES.map((entry) => [labelOf(entry), entry] as const),
  )('commands: %s', (_label, entry) => {
    const deniedRoles = MERCHANT_ROLES.filter(
      (role) => !entry.allowedRoles.includes(role),
    );

    it('has a merchant role that may run it', () => {
      expect(entry.allowedRoles.length).toBeGreaterThan(0);
    });

    for (const [from, to] of DIRECTIONS) {
      for (const role of entry.allowedRoles) {
        it(`${role} of ${from.toUpperCase()} acts only on its own merchant`, async () => {
          const caller = tenants[from];
          const target = tenants[to];
          const before = await snapshotDatabase(api);

          const response = await send(
            keyOf(caller, role),
            entry.route,
            entry.request(caller.resources),
          );

          expect(response.status).toBe(entry.created);
          expect(response.text).toContain(caller.merchant.id);
          expect(response.text).not.toContain(target.merchant.id);
          expect(
            rowsMentioning(await snapshotDatabase(api), target.merchant.id),
          ).toEqual(rowsMentioning(before, target.merchant.id));
        });

        for (const selector of ALL_SELECTORS) {
          it(`${role} of ${from.toUpperCase()} naming ${to.toUpperCase()} through ${selector.name} creates nothing for ${to.toUpperCase()}`, async () => {
            const caller = tenants[from];
            const target = tenants[to];
            // Always the other tenant: naming the caller's own merchant is
            // not an attempt to reach anyone else.
            const aimed = selector.apply(
              splitRoute(entry.route).method,
              entry.request(caller.resources),
              target.merchant.id,
            );
            if (aimed === undefined) return;
            const before = await snapshotDatabase(api);

            const response = await send(
              keyOf(caller, role),
              entry.route,
              aimed.built,
              aimed.headers,
            );

            // A field the strict body does not define is invalid input
            // (400); a header or query parameter the route ignores leaves a
            // request that acts on the caller's own merchant.
            expect([entry.created, 400]).toContain(response.status);
            if (response.status === entry.created) {
              expect(response.text).toContain(caller.merchant.id);
            } else {
              expectUnchanged(
                before,
                await snapshotDatabase(api),
                selector.name,
              );
            }
            expect(response.text).not.toContain(target.merchant.id);
            expect(
              rowsMentioning(await snapshotDatabase(api), target.merchant.id),
            ).toEqual(rowsMentioning(before, target.merchant.id));
          });
        }
      }

      for (const role of deniedRoles) {
        it(`${role} of ${from.toUpperCase()} gets 403 and nothing changes`, async () => {
          const before = await snapshotDatabase(api);

          const response = await send(
            keyOf(tenants[from], role),
            entry.route,
            entry.request(tenants[from].resources),
          );

          expect(response.status).toBe(403);
          expect(errorOf(response).code).toBe('INSUFFICIENT_ROLE');
          expectUnchanged(before, await snapshotDatabase(api), role);
        });
      }
    }

    it('gives the platform key 403 and changes nothing', async () => {
      const before = await snapshotDatabase(api);

      const response = await send(
        tenants.platform.key,
        entry.route,
        entry.request(tenants.a.resources),
      );

      expect(response.status).toBe(403);
      expect(errorOf(response).code).toBe('INSUFFICIENT_ROLE');
      expectUnchanged(before, await snapshotDatabase(api), 'platform key');
    });

    it('creates two independent resources for the same request from each tenant', async () => {
      const [role] = entry.allowedRoles;
      if (role === undefined) throw new Error('No allowed role');
      // One request, headers included, sent by both tenants.
      const built = entry.request(tenants.a.resources);

      const fromA = await send(keyOf(tenants.a, role), entry.route, built);
      const fromB = await send(keyOf(tenants.b, role), entry.route, built);
      const againFromA = await send(keyOf(tenants.a, role), entry.route, built);

      expect(fromA.status).toBe(entry.created);
      expect(fromB.status).toBe(entry.created);
      expect(fromA.text).toContain(tenants.a.merchant.id);
      expect(fromA.text).not.toContain(tenants.b.merchant.id);
      expect(fromB.text).toContain(tenants.b.merchant.id);
      expect(fromB.text).not.toContain(tenants.a.merchant.id);
      // The second request of A is a replay of its own first one.
      expect(againFromA.status).toBe(fromA.status);
      expect(againFromA.text).toBe(fromA.text);
    });
  });

  describe('reads of an own resource that name another tenant', () => {
    const reads = RESOURCE_ROUTES.filter(
      (entry) => splitRoute(entry.route).method === 'GET',
    );

    for (const entry of reads) {
      for (const [from, to] of DIRECTIONS) {
        for (const role of MERCHANT_ROLES) {
          for (const selector of selectorsFor(entry.route)) {
            it(`${labelOf(entry)}: ${role} of ${from.toUpperCase()} with ${selector.name} still reads only its own`, async () => {
              const caller = tenants[from];
              const target = tenants[to];
              const id =
                selector.value === 'own'
                  ? caller.merchant.id
                  : target.merchant.id;
              const aimed = selector.apply(
                'GET',
                entry.request(caller.resources),
                id,
              );
              if (aimed === undefined) return;
              const before = await snapshotDatabase(api);

              const response = await send(
                keyOf(caller, role),
                entry.route,
                aimed.built,
                aimed.headers,
              );

              expect(response.status).toBe(200);
              expect(response.text).toContain(caller.merchant.id);
              expect(response.text).not.toContain(target.merchant.id);
              expect(
                rowsMentioning(await snapshotDatabase(api), target.merchant.id),
              ).toEqual(rowsMentioning(before, target.merchant.id));
            });
          }
        }
      }
    }
  });

  describe('route coverage', () => {
    const tenantRoutes = new Set(TENANT_ROUTES.map((entry) => entry.route));

    it('finds the routes the application serves', () => {
      const routes = discoverRoutes(api.app).map((route) => route.route);
      expect(routes).toEqual(
        expect.arrayContaining([
          'GET /health/live',
          'GET /health/ready',
          'POST /merchants',
          'GET /merchants/:id',
          'POST /merchants/:id/api-keys/:apiKeyId/revoke',
          'POST /payment-intents',
          'GET /payment-intents/:id',
        ]),
      );
    });

    it('classifies every route as public, platform-only, or tenant-scoped', () => {
      const unclassified = discoverRoutes(api.app)
        .filter(
          (route) => classifyRoute(route, tenantRoutes) === 'unclassified',
        )
        .map(
          (route) => `${route.route} (${route.controller}.${route.handler})`,
        );

      // Fix: list the route in TENANT_ROUTES, or restrict it to PLATFORM_ADMIN
      // or mark it public if it really is one.
      expect(unclassified).toEqual([]);
    });

    it('lists only routes that exist and that a merchant key can reach', () => {
      const discovered = new Map<string, DiscoveredRoute>(
        discoverRoutes(api.app).map((route) => [route.route, route]),
      );
      for (const entry of TENANT_ROUTES) {
        const route = discovered.get(entry.route);
        expect(route, `${entry.route} is not a route`).toBeDefined();
        expect(route?.isPublic, `${entry.route} is public`).toBe(false);
        expect(
          route?.roles?.some((role) => role.startsWith('MERCHANT_')),
          `${entry.route} is closed to merchant keys`,
        ).toBe(true);
      }
    });

    it('does not take a route outside the list for tenant-scoped', () => {
      const stray: DiscoveredRoute = {
        route: 'GET /payments/:id',
        controller: 'PaymentsController',
        handler: 'get',
        isPublic: false,
        roles: ['PLATFORM_ADMIN', 'MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'],
      };
      expect(classifyRoute(stray, tenantRoutes)).toBe('unclassified');
      expect(
        classifyRoute({ ...stray, roles: ['PLATFORM_ADMIN'] }, tenantRoutes),
      ).toBe('platform-only');
      expect(classifyRoute({ ...stray, roles: undefined }, tenantRoutes)).toBe(
        'unclassified',
      );
      expect(classifyRoute({ ...stray, isPublic: true }, tenantRoutes)).toBe(
        'public',
      );
    });
  });
});
