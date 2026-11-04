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
import { paymentIntentIdParamSchema } from '../../payments/api/payment-intent.schemas.js';
import { GetPaymentTimelineService } from '../application/get-payment-timeline.service.js';
import { toPaymentTimelineResponse } from './operations.presenter.js';
import {
  paymentTimelineResponseSchema,
  type PaymentTimelineResponse,
} from './operations.schemas.js';

@ApiTags('Payment intents')
@ApiBearerAuth('bearer')
@Controller('payment-intents')
export class PaymentTimelineController {
  constructor(private readonly getPaymentTimeline: GetPaymentTimelineService) {}

  // The path names an intent and no merchant, so listing the merchant roles
  // here reveals nothing (AD-52): another merchant's intent is answered by the
  // use case as 404. A platform key is refused by the guard for every id.
  @Get(':id/timeline')
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @ApiOperation({
    summary: 'Read the timeline of a payment intent',
    description:
      "Roles: MERCHANT_ADMIN and MERCHANT_READ_ONLY of the intent's merchant. Combines, oldest first, the intent's creation, its attempts, its capture or void, its refunds, its journal entries, and the audit events about it (each 3D Secure step, authorization, capture, void, refund, Stripe webhook resolution, and reversal), each with its stored time, a short summary, the amount as an integer string with its currency where one applies, and the actor of audit events. Items of the same instant are ordered by kind, then by source_id. An intent of another merchant is 404, indistinguishable from one that does not exist. PLATFORM_ADMIN is 403 for every id. A read writes no audit event.",
  })
  @ApiResponse({
    status: 200,
    description: 'The timeline.',
    standardSchema: paymentTimelineResponseSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'VALIDATION_FAILED: the id is not a UUID. The answer does not depend on any merchant.',
    },
    {
      status: 401,
      description:
        'UNAUTHENTICATED: the API key or session token is missing, malformed, unknown, wrong, revoked, or expired, or the user is disabled.',
    },
    {
      status: 403,
      description:
        'INSUFFICIENT_ROLE: a platform key or user cannot read payment intents, whether or not the intent exists.',
    },
    {
      status: 404,
      description:
        'NOT_FOUND: the intent does not exist or belongs to another merchant. The two cannot be told apart.',
    },
    {
      status: 500,
      description:
        'INTERNAL_ERROR: unexpected failure, including a stored row that this version cannot represent.',
    },
  )
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: paymentIntentIdParamSchema }) id: string,
  ): Promise<PaymentTimelineResponse> {
    const result = await this.getPaymentTimeline.execute({
      principal,
      paymentIntentId: id,
    });
    if (!result.ok) {
      switch (result.code) {
        case 'FORBIDDEN':
          throw new ApiException('INSUFFICIENT_ROLE');
        case 'NOT_FOUND':
          throw new ApiException('NOT_FOUND');
      }
    }
    return toPaymentTimelineResponse(result.timeline);
  }
}
