import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';
import { ApiException } from '../../errors/api/api-exception.js';
import { AuthenticateApiKeyService } from '../application/authenticate-api-key.service.js';
import { AuthenticateSessionService } from '../application/authenticate-session.service.js';
import type { Principal } from '../application/principal.js';
import { isSessionToken } from '../application/session-token.js';
import { setRequestPrincipal } from './request-principal.js';
import { Public, Roles } from './route-access.js';

/** Request shape the guard reads; the HTTP adapter's type is not needed. */
interface HeaderCarrier {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

const BEARER_SCHEME = 'bearer';

/**
 * Returns the token of an `Authorization: Bearer <token>` header, or
 * `undefined` for a missing header, another scheme, or a header that is not
 * exactly a scheme, one space, and a token. The scheme is case-insensitive
 * (RFC 9110). The token is not trimmed or interpreted here.
 */
export function readBearerToken(
  header: string | string[] | undefined,
): string | undefined {
  if (typeof header !== 'string') return undefined;
  const separator = header.indexOf(' ');
  if (separator === -1) return undefined;
  if (header.slice(0, separator).toLowerCase() !== BEARER_SCHEME) {
    return undefined;
  }
  const token = header.slice(separator + 1);
  return token.length === 0 ? undefined : token;
}

/**
 * Registered globally, so every route is denied unless it says otherwise:
 *
 * - `@Public()` skips authentication.
 * - `@Roles(...)` requires a valid key whose role is listed.
 * - A route with neither requires a valid key and is then denied with 403,
 *   whatever the role, and the mistake is logged. An anonymous caller still
 *   sees only the 401 every unauthenticated request gets.
 *
 * The bearer token is either an API key (`mfk_`) or a user session token
 * (`mfs_`), told apart by its prefix; both yield the same kind of principal.
 * Authentication failures all raise the same `UNAUTHENTICATED` exception,
 * whichever kind the token claimed to be. The decision depends only on the
 * stored key or session and its user, never on a merchant ID in the request.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticate: AuthenticateApiKeyService,
    private readonly authenticateSession: AuthenticateSessionService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ApiKeyAuthGuard.name);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride(Public, targets) === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<HeaderCarrier>();
    const token = readBearerToken(request.headers['authorization']);
    if (token === undefined) {
      throw new ApiException('UNAUTHENTICATED');
    }
    const result = isSessionToken(token)
      ? await this.authenticateSession.execute(token)
      : await this.authenticate.execute(token);
    if (!result.ok) {
      throw new ApiException(result.code);
    }
    const { principal } = result;

    this.logger.assign(describeForLog(principal));
    setRequestPrincipal(request, principal);

    const roles = this.reflector.getAllAndOverride(Roles, targets);
    if (roles === undefined) {
      this.logger.error(
        {
          controller: context.getClass().name,
          handler: context.getHandler().name,
        },
        'route declares neither roles nor public access and was denied',
      );
      throw new ApiException('INSUFFICIENT_ROLE');
    }
    if (!roles.includes(principal.role)) {
      throw new ApiException('INSUFFICIENT_ROLE');
    }
    return true;
  }
}

/**
 * The identifiers that go on every log line of an authenticated request: the
 * key row's id or the user's id, the role, and the merchant of a merchant
 * principal. A key, a token, and their lookup ids are never logged.
 */
function describeForLog(principal: Principal): Record<string, string> {
  const credential =
    principal.source === 'API_KEY'
      ? { apiKeyId: principal.apiKeyId }
      : { userId: principal.userId };
  switch (principal.kind) {
    case 'PLATFORM':
      return { ...credential, role: principal.role };
    case 'MERCHANT':
      return {
        ...credential,
        role: principal.role,
        merchantId: principal.merchantId,
      };
  }
}
