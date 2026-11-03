import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Patch,
  Query,
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
import { ApiException } from '../../errors/api/api-exception.js';
import { CorrelationId } from '../../logging/correlation-id.decorator.js';
import { ChangeMerchantStatusService } from '../application/change-merchant-status.service.js';
import { CreateMerchantService } from '../application/create-merchant.service.js';
import { GetMerchantService } from '../application/get-merchant.service.js';
import { ListMerchantsService } from '../application/list-merchants.service.js';
import type { MerchantProfileChanges } from '../application/merchant-changes.js';
import {
  MERCHANT_FIXED_FIELDS,
  type MerchantFixedField,
} from '../application/merchant-changes.js';
import { UpdateMerchantProfileService } from '../application/update-merchant-profile.service.js';
import {
  INSUFFICIENT_ROLE_DOC,
  NOT_FOUND_DOC,
  UNAUTHENTICATED_DOC,
  VALIDATION_FAILED_DOC,
} from './merchant-error-docs.js';
import { toApiException } from './merchant-failures.js';
import {
  toMerchantListResponse,
  toMerchantResponse,
} from './merchant.presenter.js';
import {
  changeMerchantStatusSchema,
  createMerchantSchema,
  listMerchantsQuerySchema,
  merchantIdParamSchema,
  merchantListResponseSchema,
  merchantResponseSchema,
  updateMerchantSchema,
  type ChangeMerchantStatusBody,
  type CreateMerchantBody,
  type ListMerchantsQuery,
  type MerchantListResponse,
  type MerchantResponse,
  type UpdateMerchantBody,
} from './merchant.schemas.js';

/**
 * Routes with a merchant in the path accept every role at the guard on purpose:
 * the use case decides, and it answers 404 for another merchant before it
 * looks at the role, so a role check at the guard would turn that 404 into a
 * 403 and reveal that the merchant exists.
 */
const ANY_ROLE = [
  'PLATFORM_ADMIN',
  'MERCHANT_ADMIN',
  'MERCHANT_READ_ONLY',
] as const;

@ApiTags('Merchants')
@ApiBearerAuth('bearer')
@Controller('merchants')
export class MerchantsController {
  constructor(
    private readonly createMerchant: CreateMerchantService,
    private readonly listMerchants: ListMerchantsService,
    private readonly getMerchant: GetMerchantService,
    private readonly updateMerchantProfile: UpdateMerchantProfileService,
    private readonly changeMerchantStatus: ChangeMerchantStatusService,
  ) {}

  @Post()
  @Roles(['PLATFORM_ADMIN'])
  @ApiOperation({
    summary: 'Register a merchant',
    description:
      'Roles: PLATFORM_ADMIN. The merchant starts in DRAFT. No API key is issued; use POST /merchants/{id}/api-keys.',
  })
  @ApiResponse({
    status: 201,
    description: 'The merchant was created.',
    standardSchema: merchantResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    INSUFFICIENT_ROLE_DOC,
  )
  async create(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Body({ schema: createMerchantSchema }) body: CreateMerchantBody,
  ): Promise<MerchantResponse> {
    const result = await this.createMerchant.execute({
      principal,
      correlationId,
      merchant: {
        legalName: body.legal_name,
        displayName: body.display_name,
        businessType: body.business_type,
        industry: body.industry,
        countryCode: body.country_code,
        defaultCurrency: body.default_currency,
      },
    });
    if (!result.ok) throw toApiException(result.code);
    return toMerchantResponse(result.merchant);
  }

  @Get()
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: 'List merchants',
    description:
      'Roles: PLATFORM_ADMIN lists every merchant; MERCHANT_ADMIN and MERCHANT_READ_ONLY list only their own. Pages are ordered by creation time and then id, and continue with next_cursor.',
  })
  @ApiResponse({
    status: 200,
    description: 'One page of merchants.',
    standardSchema: merchantListResponseSchema,
  })
  @ApiErrorResponses(VALIDATION_FAILED_DOC, UNAUTHENTICATED_DOC)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: listMerchantsQuerySchema }) query: ListMerchantsQuery,
  ): Promise<MerchantListResponse> {
    const page = await this.listMerchants.execute({
      principal,
      limit: query.limit,
      after: query.cursor,
    });
    return toMerchantListResponse(page);
  }

  @Get(':id')
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: 'Read a merchant',
    description:
      'Roles: PLATFORM_ADMIN reads any merchant; MERCHANT_ADMIN and MERCHANT_READ_ONLY read only their own. Another merchant is 404.',
  })
  @ApiResponse({
    status: 200,
    description: 'The merchant.',
    standardSchema: merchantResponseSchema,
  })
  @ApiErrorResponses(VALIDATION_FAILED_DOC, UNAUTHENTICATED_DOC, NOT_FOUND_DOC)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: merchantIdParamSchema }) id: string,
  ): Promise<MerchantResponse> {
    const result = await this.getMerchant.execute({
      principal,
      merchantId: id,
    });
    if (!result.ok) throw toApiException(result.code);
    return toMerchantResponse(result.merchant);
  }

  @Patch(':id')
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: 'Update a merchant profile',
    description:
      'Roles: PLATFORM_ADMIN updates legal_name, display_name, business_type, industry, and country_code of any merchant. MERCHANT_ADMIN updates only display_name and industry of its own merchant, also while it is suspended. MERCHANT_READ_ONLY updates nothing. Naming status or default_currency is refused: use POST /merchants/{id}/status, and the currency is fixed at creation. At least one field is required. A request that changes no value writes nothing.',
  })
  @ApiResponse({
    status: 200,
    description: 'The merchant after the update.',
    standardSchema: merchantResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    INSUFFICIENT_ROLE_DOC,
    NOT_FOUND_DOC,
  )
  async update(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: merchantIdParamSchema }) id: string,
    @Body({ schema: updateMerchantSchema }) body: UpdateMerchantBody,
  ): Promise<MerchantResponse> {
    const result = await this.updateMerchantProfile.execute({
      principal,
      correlationId,
      merchantId: id,
      changes: toProfileChanges(body),
      fixedFieldsRequested: fixedFieldsIn(body),
    });
    if (result.ok) return toMerchantResponse(result.merchant);
    if (result.code === 'FIXED_FIELD') {
      throw new ApiException(
        'VALIDATION_FAILED',
        result.fields.map((field) => ({
          path: [field],
          code: 'not_updatable',
        })),
      );
    }
    throw toApiException(result.code);
  }

  @Post(':id/status')
  @HttpCode(200)
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: 'Change a merchant status',
    description:
      'Roles: PLATFORM_ADMIN only. Activates (DRAFT to ACTIVE), suspends (ACTIVE to SUSPENDED), or reactivates (SUSPENDED to ACTIVE). A merchant key gets 404 for another merchant and 403 for its own, and nothing changes.',
  })
  @ApiResponse({
    status: 200,
    description: 'The merchant with its new status.',
    standardSchema: merchantResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    INSUFFICIENT_ROLE_DOC,
    NOT_FOUND_DOC,
    {
      status: 409,
      description:
        'MERCHANT_TRANSITION_NOT_ALLOWED: the policy does not allow the move, including to the current status. MERCHANT_STATUS_CONFLICT: another request changed the status first; nothing was changed.',
    },
  )
  async changeStatus(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: merchantIdParamSchema }) id: string,
    @Body({ schema: changeMerchantStatusSchema })
    body: ChangeMerchantStatusBody,
  ): Promise<MerchantResponse> {
    const result = await this.changeMerchantStatus.execute({
      principal,
      correlationId,
      merchantId: id,
      target: body.status,
    });
    if (!result.ok) throw toApiException(result.code);
    return toMerchantResponse(result.merchant);
  }
}

/** The profile fields the request names, without the ones it leaves out. */
function toProfileChanges(body: UpdateMerchantBody): MerchantProfileChanges {
  return {
    ...(body.legal_name === undefined ? {} : { legalName: body.legal_name }),
    ...(body.display_name === undefined
      ? {}
      : { displayName: body.display_name }),
    ...(body.business_type === undefined
      ? {}
      : { businessType: body.business_type }),
    ...(body.industry === undefined ? {} : { industry: body.industry }),
    ...(body.country_code === undefined
      ? {}
      : { countryCode: body.country_code }),
  };
}

/** The fields nobody can change through a profile update that the body names. */
function fixedFieldsIn(body: UpdateMerchantBody): MerchantFixedField[] {
  return MERCHANT_FIXED_FIELDS.filter((field) => body[field] !== undefined);
}
