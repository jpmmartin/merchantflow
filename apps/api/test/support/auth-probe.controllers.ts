import { Controller, Get, Param } from '@nestjs/common';
import { CurrentPrincipal } from '../../src/modules/auth/api/current-principal.decorator.js';
import { Public, Roles } from '../../src/modules/auth/api/route-access.js';
import type { Principal } from '../../src/modules/auth/application/principal.js';

/** What a probe route reports about the caller. */
function summarize(principal: Principal) {
  return {
    kind: principal.kind,
    role: principal.role,
    apiKeyId: principal.apiKeyId,
    merchantId: principal.kind === 'MERCHANT' ? principal.merchantId : null,
  };
}

/**
 * Routes that exist only in tests, to exercise the authentication guard
 * without adding a business endpoint to the production code.
 */
@Controller('auth-probe')
export class AuthProbeController {
  @Get('public')
  @Public()
  open() {
    return { access: 'public' };
  }

  @Get('platform')
  @Roles(['PLATFORM_ADMIN'])
  platform(@CurrentPrincipal() principal: Principal) {
    return summarize(principal);
  }

  @Get('merchant-admin')
  @Roles(['MERCHANT_ADMIN'])
  merchantAdmin(@CurrentPrincipal() principal: Principal) {
    return summarize(principal);
  }

  @Get('merchant')
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  merchant(@CurrentPrincipal() principal: Principal) {
    return summarize(principal);
  }

  /** The merchant in the path is data; the principal's merchant is the key's. */
  @Get('merchants/:merchantId/whoami')
  @Roles(['PLATFORM_ADMIN', 'MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  whoami(
    @Param('merchantId') requested: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return { requestedMerchantId: requested, principal: summarize(principal) };
  }

  /** Declares neither `Roles` nor `Public`, so the guard must deny it. */
  @Get('undeclared')
  undeclared() {
    return { reached: true };
  }
}

/** Roles declared on the class apply to every handler without its own. */
@Roles(['MERCHANT_READ_ONLY', 'MERCHANT_ADMIN'])
@Controller('auth-class-probe')
export class ClassRolesProbeController {
  @Get('inherited')
  inherited(@CurrentPrincipal() principal: Principal) {
    return summarize(principal);
  }

  /** A handler's declaration replaces the class's. */
  @Get('overridden')
  @Roles(['PLATFORM_ADMIN'])
  overridden(@CurrentPrincipal() principal: Principal) {
    return summarize(principal);
  }
}

/** A public class: its handlers need no key. */
@Public()
@Controller('auth-public-class-probe')
export class PublicClassProbeController {
  @Get()
  open() {
    return { access: 'public' };
  }
}

/** A controller with no metadata at all. */
@Controller('auth-bare-probe')
export class BareProbeController {
  @Get()
  bare() {
    return { reached: true };
  }
}
