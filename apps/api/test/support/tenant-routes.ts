import { randomUUID } from 'node:crypto';
import { API, type MerchantRole } from './merchant-api.js';

/**
 * The identifiers one tenant owns, which a route can name. Later increments add
 * a field per resource type (for example `paymentId`) and fill it in
 * `createTenants`; the routes that use it then address it through `request`.
 */
export interface TenantResources {
  readonly merchantId: string;
  /** Identifier of a key row that belongs to the merchant. */
  readonly apiKeyId: string;
  /** Identifier of a payment intent that belongs to the merchant. */
  readonly paymentIntentId: string;
  /** Identifier of a user that belongs to the merchant. */
  readonly userId: string;
  /** Identifier of a processor account that belongs to the merchant. */
  readonly processorAccountId: string;
}

/**
 * A live-mode Stripe secret key that exists nowhere. The adapter refuses it
 * from its prefix, so the connect route never calls Stripe in the suite. It is
 * built from parts so that secret scanners do not take the fixture for a key.
 */
const FAKE_LIVE_SECRET_KEY = ['sk', 'live', 'tenant0isolation0fixture'].join(
  '_',
);

/** A request a route entry builds for a set of resources. */
export interface BuiltRequest {
  /** Path below the API prefix, with its query string if any. */
  readonly path: string;
  readonly body?: Record<string, unknown>;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * A route a merchant key can reach, so another merchant's resource must answer
 * 404. This is the one list of such routes: a later increment extends the
 * isolation suite by adding entries here and not by writing a test file.
 */
export interface ResourceRoute {
  readonly kind: 'resource';
  /** `METHOD /path` with Nest's `:param` names, as route discovery reports it. */
  readonly route: string;
  /** A request that is valid for a caller allowed to make it. */
  readonly request: (resources: TenantResources) => BuiltRequest;
  /**
   * The route addresses a child resource below the merchant. The suite also
   * sends the parent of one tenant with the child of the other.
   */
  readonly nested?: true;
  /** What the platform key gets for a valid request about an existing merchant. */
  readonly platformExisting: number;
  /** What the platform key gets when the merchant does not exist. */
  readonly platformMissing: number;
}

/**
 * A route that lists resources. It answers 200 for every caller and must show
 * only the caller's own, so there is no 404 to compare.
 */
export interface CollectionRoute {
  readonly kind: 'collection';
  readonly route: string;
  readonly request: (resources: TenantResources) => BuiltRequest;
}

/**
 * A route that creates a resource for the merchant of the key and names no
 * merchant in its path, so the tenant comes only from the principal. There is
 * no 404 to compare: the suite checks that naming the other tenant elsewhere in
 * the request never creates, changes, or reveals anything of it, that roles
 * without the permission change nothing, and that the same request from two
 * tenants creates two independent resources.
 */
export interface CommandRoute {
  readonly kind: 'command';
  readonly route: string;
  /**
   * A valid request. Each call returns a new one (for example with a new
   * idempotency key and a new order reference), so two calls never collide.
   */
  readonly request: (resources: TenantResources) => BuiltRequest;
  /** The merchant roles that may run the command; the others get 403. */
  readonly allowedRoles: readonly MerchantRole[];
  /** What a valid request from an allowed role answers. */
  readonly created: number;
}

/**
 * A route that acts only on the credential of the request and names no
 * merchant or resource, such as signing out. There is no 404 to compare: the
 * suite checks that a merchant key gets the declared answer whatever the
 * request names, and that nothing changes.
 */
export interface SelfRoute {
  readonly kind: 'self';
  readonly route: string;
  readonly request: (resources: TenantResources) => BuiltRequest;
  /** What a merchant key gets for a valid request. */
  readonly merchantKey: number;
}

export type TenantRoute =
  ResourceRoute | CollectionRoute | CommandRoute | SelfRoute;

export const TENANT_ROUTES: readonly TenantRoute[] = [
  {
    kind: 'collection',
    route: 'GET /merchants',
    request: () => ({ path: '/merchants' }),
  },
  {
    kind: 'resource',
    route: 'GET /merchants/:id',
    request: (r) => ({ path: `/merchants/${r.merchantId}` }),
    platformExisting: 200,
    platformMissing: 404,
  },
  {
    kind: 'resource',
    route: 'PATCH /merchants/:id',
    request: (r) => ({
      path: `/merchants/${r.merchantId}`,
      body: { display_name: 'Takeover' },
    }),
    platformExisting: 200,
    platformMissing: 404,
  },
  {
    kind: 'resource',
    route: 'PATCH /merchants/:id',
    request: (r) => ({
      path: `/merchants/${r.merchantId}`,
      body: { legal_name: 'Takeover Ltd' },
    }),
    platformExisting: 200,
    platformMissing: 404,
  },
  {
    // A platform key that names the status here is refused as invalid input
    // before the merchant is looked up.
    kind: 'resource',
    route: 'PATCH /merchants/:id',
    request: (r) => ({
      path: `/merchants/${r.merchantId}`,
      body: { status: 'SUSPENDED' },
    }),
    platformExisting: 400,
    platformMissing: 400,
  },
  {
    kind: 'resource',
    route: 'POST /merchants/:id/status',
    request: (r) => ({
      path: `/merchants/${r.merchantId}/status`,
      body: { status: 'SUSPENDED' },
    }),
    platformExisting: 200,
    platformMissing: 404,
  },
  {
    kind: 'resource',
    route: 'POST /merchants/:id/api-keys',
    request: (r) => ({
      path: `/merchants/${r.merchantId}/api-keys`,
      body: { role: 'MERCHANT_ADMIN' },
    }),
    platformExisting: 201,
    platformMissing: 404,
  },
  {
    kind: 'resource',
    route: 'POST /merchants/:id/api-keys/:apiKeyId/revoke',
    request: (r) => ({
      path: `/merchants/${r.merchantId}/api-keys/${r.apiKeyId}/revoke`,
    }),
    nested: true,
    platformExisting: 200,
    platformMissing: 404,
  },
  {
    kind: 'resource',
    route: 'GET /merchants/:id/api-keys',
    request: (r) => ({ path: `/merchants/${r.merchantId}/api-keys` }),
    platformExisting: 200,
    platformMissing: 404,
  },
  {
    kind: 'resource',
    route: 'POST /merchants/:id/users',
    request: (r) => ({
      path: `/merchants/${r.merchantId}/users`,
      body: {
        email: `tenant-user-${randomUUID()}@example.test`,
        display_name: 'Tenant User',
      },
    }),
    platformExisting: 201,
    platformMissing: 404,
  },
  {
    kind: 'resource',
    route: 'GET /merchants/:id/users',
    request: (r) => ({ path: `/merchants/${r.merchantId}/users` }),
    platformExisting: 200,
    platformMissing: 404,
  },
  {
    kind: 'resource',
    route: 'POST /merchants/:id/users/:userId/disable',
    request: (r) => ({
      path: `/merchants/${r.merchantId}/users/${r.userId}/disable`,
    }),
    nested: true,
    platformExisting: 200,
    platformMissing: 404,
  },
  {
    // A live key is refused before any call to Stripe, after the merchant is
    // found, so a platform key gets 422 for an existing merchant.
    kind: 'resource',
    route: 'POST /merchants/:id/processor-accounts',
    request: (r) => ({
      path: `/merchants/${r.merchantId}/processor-accounts`,
      body: {
        provider: 'stripe',
        display_name: 'Tenant Stripe',
        credentials: {
          secret_key: FAKE_LIVE_SECRET_KEY,
          publishable_key: 'pk_test_tenantisolationfixture',
        },
      },
    }),
    platformExisting: 422,
    platformMissing: 404,
  },
  {
    kind: 'resource',
    route: 'GET /merchants/:id/processor-accounts',
    request: (r) => ({ path: `/merchants/${r.merchantId}/processor-accounts` }),
    platformExisting: 200,
    platformMissing: 404,
  },
  {
    kind: 'resource',
    route: 'POST /merchants/:id/processor-accounts/:processorAccountId/disable',
    request: (r) => ({
      path: `/merchants/${r.merchantId}/processor-accounts/${r.processorAccountId}/disable`,
    }),
    nested: true,
    platformExisting: 200,
    platformMissing: 404,
  },
  {
    kind: 'resource',
    route: 'POST /merchants/:id/processor-accounts/:processorAccountId/default',
    request: (r) => ({
      path: `/merchants/${r.merchantId}/processor-accounts/${r.processorAccountId}/default`,
    }),
    nested: true,
    platformExisting: 200,
    platformMissing: 404,
  },
  {
    // The caller describes itself; an API key's description holds its own
    // merchant and nothing of another.
    kind: 'collection',
    route: 'GET /auth/me',
    request: () => ({ path: '/auth/me' }),
  },
  {
    // Signing out ends the session of the request; an API key is refused
    // and stays valid.
    kind: 'self',
    route: 'POST /auth/logout',
    request: () => ({ path: '/auth/logout' }),
    merchantKey: 403,
  },
  {
    kind: 'command',
    route: 'POST /payment-intents',
    request: () => ({
      path: '/payment-intents',
      body: {
        amount_minor: '1000',
        currency: 'USD',
        merchant_reference: `tenant-order-${randomUUID()}`,
      },
      headers: { 'Idempotency-Key': `tenant-${randomUUID()}` },
    }),
    allowedRoles: ['MERCHANT_ADMIN'],
    created: 201,
  },
  {
    // The list names no merchant; each merchant role lists only the intents
    // of its own merchant, and the platform key is refused.
    kind: 'collection',
    route: 'GET /payment-intents',
    request: () => ({ path: '/payment-intents' }),
  },
  {
    // The path names an intent and no merchant, and the platform key is
    // refused for every id, so it gets 403 whether or not the intent exists.
    kind: 'resource',
    route: 'GET /payment-intents/:id',
    request: (r) => ({ path: `/payment-intents/${r.paymentIntentId}` }),
    platformExisting: 403,
    platformMissing: 403,
  },
];

/** The method and path of an entry, split. */
export function splitRoute(route: string): { method: string; path: string } {
  const [method = '', path = ''] = route.split(' ');
  return { method, path };
}

/** Full URL path of a built request. */
export function urlOf(built: BuiltRequest): string {
  return `${API}${built.path}`;
}
