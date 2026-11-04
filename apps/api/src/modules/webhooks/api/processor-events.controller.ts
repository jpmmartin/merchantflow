import { Controller, Get, Param } from '@nestjs/common';
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
import { ListProcessorEventsService } from '../application/list-processor-events.service.js';
import {
  idParamSchema,
  processorEventListResponseSchema,
  toProcessorEventResponse,
  type ProcessorEventListResponse,
} from './processor-events.schemas.js';

/**
 * The webhook inbox of one processor account, for its webhook panel. The
 * path names the merchant, so all three roles pass the guard and the use case
 * answers another merchant 404 (AD-52).
 */
@ApiTags('Processor accounts')
@ApiBearerAuth('bearer')
@Controller(
  'merchants/:id/processor-accounts/:processorAccountId/webhook/events',
)
export class ProcessorEventsController {
  constructor(private readonly listEvents: ListProcessorEventsService) {}

  @Get()
  @Roles(['PLATFORM_ADMIN', 'MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @ApiOperation({
    summary: "List a processor account's latest webhook events",
    description:
      'Roles: PLATFORM_ADMIN for any merchant; MERCHANT_ADMIN and MERCHANT_READ_ONLY for their own. The latest 20 events received on the account’s webhook, newest first, with type, object, reception time, outcome, and what processing did. No payload, signature, or secret is stored or returned. Another merchant, or an account that is not the merchant’s, is 404.',
  })
  @ApiResponse({
    status: 200,
    description: 'The latest events of the account.',
    standardSchema: processorEventListResponseSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description: 'VALIDATION_FAILED: an id is not a UUID.',
    },
    {
      status: 401,
      description:
        'UNAUTHENTICATED: the API key or session token is missing, malformed, unknown, wrong, revoked, or expired.',
    },
    {
      status: 404,
      description:
        'NOT_FOUND: the merchant or the account does not exist or belongs to another merchant. The cases cannot be told apart.',
    },
  )
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: idParamSchema }) merchantId: string,
    @Param('processorAccountId', { schema: idParamSchema })
    processorAccountId: string,
  ): Promise<ProcessorEventListResponse> {
    const result = await this.listEvents.execute({
      principal,
      merchantId,
      processorAccountId,
    });
    if (!result.ok) throw new ApiException('NOT_FOUND');
    return {
      processor_account_id: processorAccountId,
      merchant_id: merchantId,
      data: result.events.map(toProcessorEventResponse),
    };
  }
}
