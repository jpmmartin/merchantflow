import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal } from '../../auth/api/current-principal.decorator.js';
import { Roles } from '../../auth/api/route-access.js';
import type { Principal } from '../../auth/application/principal.js';
import { ApiErrorResponses } from '../../errors/api/api-error-responses.decorator.js';
import { CorrelationId } from '../../logging/correlation-id.decorator.js';
import { IssueMerchantApiKeyService } from '../application/issue-merchant-api-key.service.js';
import { RevokeMerchantApiKeyService } from '../application/revoke-merchant-api-key.service.js';
import {
  INSUFFICIENT_ROLE_DOC,
  NOT_FOUND_DOC,
  UNAUTHENTICATED_DOC,
  VALIDATION_FAILED_DOC,
} from './merchant-error-docs.js';
import { toApiException } from './merchant-failures.js';
import {
  toIssuedApiKeyResponse,
  toRevokedApiKeyResponse,
} from './merchant.presenter.js';
import {
  apiKeyIdParamSchema,
  issuedApiKeyResponseSchema,
  issueApiKeySchema,
  merchantIdParamSchema,
  revokedApiKeyResponseSchema,
  type IssueApiKeyBody,
  type IssuedApiKeyResponse,
  type RevokedApiKeyResponse,
} from './merchant.schemas.js';

/** See `ANY_ROLE` in the merchants controller: the use case answers 404 first. */
const ANY_ROLE = [
  'PLATFORM_ADMIN',
  'MERCHANT_ADMIN',
  'MERCHANT_READ_ONLY',
] as const;

@ApiTags('Merchant API keys')
@ApiBearerAuth('bearer')
@Controller('merchants/:id/api-keys')
export class MerchantApiKeysController {
  constructor(
    private readonly issueApiKey: IssueMerchantApiKeyService,
    private readonly revokeApiKey: RevokeMerchantApiKeyService,
  ) {}

  @Post()
  @Roles(ANY_ROLE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Issue an API key for a merchant',
    description:
      'Roles: PLATFORM_ADMIN only. The response holds the key once; it is stored only as a hash and cannot be retrieved again. The response is not cacheable (Cache-Control: no-store). A merchant key gets 404 for another merchant and 403 for its own.',
  })
  @ApiResponse({
    status: 201,
    description:
      'The key was issued. This is the only time its secret is shown.',
    standardSchema: issuedApiKeyResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    INSUFFICIENT_ROLE_DOC,
    NOT_FOUND_DOC,
  )
  async issue(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
    @Body({ schema: issueApiKeySchema }) body: IssueApiKeyBody,
  ): Promise<IssuedApiKeyResponse> {
    const result = await this.issueApiKey.execute({
      principal,
      correlationId,
      merchantId,
      role: body.role,
    });
    if (!result.ok) throw toApiException(result.code);
    return toIssuedApiKeyResponse(result.apiKey, result.key);
  }

  @Post(':apiKeyId/revoke')
  @HttpCode(200)
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: 'Revoke an API key of a merchant',
    description:
      'Roles: PLATFORM_ADMIN only. The key stops authenticating at its next request. Revoking a revoked key succeeds and changes nothing. A key of another merchant, a platform key, and an unknown id are 404. A merchant key gets 404 for another merchant and 403 for its own.',
  })
  @ApiResponse({
    status: 200,
    description: 'The key is revoked.',
    standardSchema: revokedApiKeyResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    INSUFFICIENT_ROLE_DOC,
    NOT_FOUND_DOC,
  )
  async revoke(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
    @Param('apiKeyId', { schema: apiKeyIdParamSchema }) apiKeyId: string,
  ): Promise<RevokedApiKeyResponse> {
    const result = await this.revokeApiKey.execute({
      principal,
      correlationId,
      merchantId,
      apiKeyId,
    });
    if (!result.ok) throw toApiException(result.code);
    return toRevokedApiKeyResponse(result.apiKey);
  }
}
