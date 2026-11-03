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
}

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

export type TenantRoute = ResourceRoute | CollectionRoute | CommandRoute;

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
