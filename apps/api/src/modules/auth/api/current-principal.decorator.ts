import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Principal } from '../application/principal.js';
import { getRequestPrincipal } from './request-principal.js';

/**
 * Gives a handler the authenticated principal. It is for routes that declare
 * `Roles`; on a public route there is no principal, and asking for one is a
 * programming error, reported as a 500 instead of an anonymous caller.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const principal = getRequestPrincipal(
      context.switchToHttp().getRequest<object>(),
    );
    if (principal === undefined) {
      throw new Error('CurrentPrincipal used on a route without a principal');
    }
    return principal;
  },
);
