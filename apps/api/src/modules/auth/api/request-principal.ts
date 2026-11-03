import type { Principal } from '../application/principal.js';

/**
 * The principal of each request, keyed by the request object. The guard sets
 * it once, and nothing else can: the request carries no field a caller could
 * fill in, so a header or body can never impersonate a principal.
 */
const principals = new WeakMap<object, Principal>();

export function setRequestPrincipal(request: object, principal: Principal) {
  principals.set(request, principal);
}

export function getRequestPrincipal(request: object): Principal | undefined {
  return principals.get(request);
}
