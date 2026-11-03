import { Reflector } from '@nestjs/core';
import type { ApiKeyRole } from '../application/api-key-scope.js';

/**
 * Declares the roles that may call a route. A caller with any other role gets
 * 403 `INSUFFICIENT_ROLE`. It applies to a handler or to a whole controller,
 * and a handler's declaration replaces its controller's.
 *
 * Every route must carry either this or `Public`; a route with neither is
 * denied (see `ApiKeyAuthGuard`). Merchant roles still act only within their
 * own merchant, which the use case enforces from the principal.
 */
export const Roles =
  Reflector.createDecorator<readonly [ApiKeyRole, ...ApiKeyRole[]]>();

/**
 * Declares that a route needs no API key. Use it only for routes that expose
 * nothing private, such as the health probes. It must be written out on each
 * route or controller, because a route without it requires a key.
 */
export const Public = Reflector.createDecorator<void, true>({
  transform: () => true,
});
