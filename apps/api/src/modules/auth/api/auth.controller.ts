import { Body, Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../errors/api/api-error-responses.decorator.js';
import { ApiException } from '../../errors/api/api-exception.js';
import { CorrelationId } from '../../logging/correlation-id.decorator.js';
import { GetCurrentPrincipalService } from '../application/get-current-principal.service.js';
import { LogInService } from '../application/log-in.service.js';
import { LogOutService } from '../application/log-out.service.js';
import type { Principal } from '../application/principal.js';
import { CurrentPrincipal } from './current-principal.decorator.js';
import {
  toCurrentPrincipalResponse,
  toLoginResponse,
} from './auth.presenter.js';
import {
  currentPrincipalResponseSchema,
  loginResponseSchema,
  loginSchema,
  type CurrentPrincipalResponse,
  type LoginBody,
  type LoginResponse,
} from './auth.schemas.js';
import { Public, Roles } from './route-access.js';

const UNAUTHENTICATED_DOC = {
  status: 401,
  description:
    'UNAUTHENTICATED: the API key or session token is missing, malformed, unknown, wrong, revoked, or expired, or the user is disabled.',
} as const;

/**
 * Every role may describe itself and sign out. Neither route names a merchant:
 * each acts only on the credential of the request, and both are listed in the
 * tenant isolation catalogue.
 */
const SESSION_ROLES = [
  'PLATFORM_ADMIN',
  'MERCHANT_ADMIN',
  'MERCHANT_READ_ONLY',
] as const;

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly logIn: LogInService,
    private readonly logOut: LogOutService,
    private readonly getCurrentPrincipal: GetCurrentPrincipalService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Sign in with an email and a password',
    description:
      'Public. Opens a session that lasts 8 hours and returns its token once; the token is stored only as a hash. Every failed sign-in gets the same 401 INVALID_CREDENTIALS. The response is not cacheable (Cache-Control: no-store).',
  })
  @ApiResponse({
    status: 200,
    description: 'Signed in. This is the only time the token is shown.',
    standardSchema: loginResponseSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'VALIDATION_FAILED or MALFORMED_JSON: the body is not { email, password } with non-empty strings.',
    },
    {
      status: 401,
      description:
        'INVALID_CREDENTIALS: the email is unknown, the password is wrong, or the user is disabled. The cases are not told apart.',
    },
  )
  async login(
    @CorrelationId() correlationId: string,
    @Body({ schema: loginSchema }) body: LoginBody,
  ): Promise<LoginResponse> {
    const result = await this.logIn.execute({
      email: body.email,
      password: body.password,
      correlationId,
    });
    if (!result.ok) throw new ApiException(result.code);
    return toLoginResponse(result.token, result.expiresAt, result.user);
  }

  @Post('logout')
  @HttpCode(204)
  @Roles(SESSION_ROLES)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Sign out the current session',
    description:
      'Roles: PLATFORM_ADMIN, MERCHANT_ADMIN, MERCHANT_READ_ONLY. Revokes the session whose token authenticated the request; the token gets 401 afterwards. It applies only to session tokens: an API key gets 403 SESSION_REQUIRED and stays valid.',
  })
  @ApiResponse({ status: 204, description: 'The session is signed out.' })
  @ApiErrorResponses(UNAUTHENTICATED_DOC, {
    status: 403,
    description: 'SESSION_REQUIRED: the request was made with an API key.',
  })
  async logout(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
  ): Promise<void> {
    const result = await this.logOut.execute({ principal, correlationId });
    if (!result.ok) throw new ApiException(result.code);
  }

  @Get('me')
  @Roles(SESSION_ROLES)
  @ApiBearerAuth('bearer')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Describe the caller',
    description:
      'Roles: PLATFORM_ADMIN, MERCHANT_ADMIN, MERCHANT_READ_ONLY. Returns the principal of the request: the signed-in user with its display name, or the API key, with the role and the merchant.',
  })
  @ApiResponse({
    status: 200,
    description: 'The principal of the request.',
    standardSchema: currentPrincipalResponseSchema,
  })
  @ApiErrorResponses(UNAUTHENTICATED_DOC)
  async me(
    @CurrentPrincipal() principal: Principal,
  ): Promise<CurrentPrincipalResponse> {
    return toCurrentPrincipalResponse(
      await this.getCurrentPrincipal.execute(principal),
    );
  }
}
