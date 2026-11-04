import {
  Body,
  Controller,
  Get,
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
import { ConfigureProcessorAccountWebhookService } from '../application/configure-processor-account-webhook.service.js';
import { GetProcessorAccountWebhookService } from '../application/get-processor-account-webhook.service.js';
import { RemoveProcessorAccountWebhookService } from '../application/remove-processor-account-webhook.service.js';
import {
  INSUFFICIENT_ROLE_DOC,
  NOT_FOUND_DOC,
  UNAUTHENTICATED_DOC,
  VALIDATION_FAILED_DOC,
} from './merchant-error-docs.js';
import { toApiException, toWebhookApiException } from './merchant-failures.js';
import { toProcessorAccountWebhookResponse } from './merchant.presenter.js';
import {
  configureProcessorAccountWebhookResponseSchema,
  configureProcessorAccountWebhookSchema,
  merchantIdParamSchema,
  processorAccountIdParamSchema,
  processorAccountWebhookResponseSchema,
  type ConfigureProcessorAccountWebhookBody,
  type ConfigureProcessorAccountWebhookResponse,
  type ProcessorAccountWebhookResponse,
} from './merchant.schemas.js';

/** See `ANY_ROLE` in the merchants controller: the use case answers 404 first. */
const ANY_ROLE = [
  'PLATFORM_ADMIN',
  'MERCHANT_ADMIN',
  'MERCHANT_READ_ONLY',
] as const;

const OPERATION_TIMEOUT_DOC = {
  status: 503,
  description:
    'OPERATION_TIMEOUT: another change of the same merchant held its lock for too long. Nothing was changed; the request can be sent again.',
} as const;

/** The webhook configuration of one processor account. */
@ApiTags('Processor accounts')
@ApiBearerAuth('bearer')
@Controller('merchants/:id/processor-accounts/:processorAccountId/webhook')
export class MerchantProcessorAccountWebhookController {
  constructor(
    private readonly getWebhook: GetProcessorAccountWebhookService,
    private readonly configureWebhook: ConfigureProcessorAccountWebhookService,
    private readonly removeWebhook: RemoveProcessorAccountWebhookService,
  ) {}

  @Get()
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: "Read a processor account's webhook configuration",
    description:
      'Roles: PLATFORM_ADMIN for any merchant; MERCHANT_ADMIN and MERCHANT_READ_ONLY for their own. Shows the URL the provider must deliver the account’s events to (null without a public base URL), whether a signing secret is stored, how it was configured, its last four characters, the endpoint the platform created, and when. The signing secret is never returned. Another merchant, or an account that is not the merchant’s, is 404.',
  })
  @ApiResponse({
    status: 200,
    description: 'The webhook configuration of the account.',
    standardSchema: processorAccountWebhookResponseSchema,
  })
  @ApiErrorResponses(VALIDATION_FAILED_DOC, UNAUTHENTICATED_DOC, NOT_FOUND_DOC)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
    @Param('processorAccountId', { schema: processorAccountIdParamSchema })
    processorAccountId: string,
  ): Promise<ProcessorAccountWebhookResponse> {
    const result = await this.getWebhook.execute({
      principal,
      merchantId,
      processorAccountId,
    });
    if (!result.ok) throw toApiException(result.code);
    return toProcessorAccountWebhookResponse(result.view);
  }

  @Post()
  @HttpCode(200)
  @Roles(ANY_ROLE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: "Configure a processor account's webhook",
    description:
      'Roles: PLATFORM_ADMIN for any merchant; MERCHANT_ADMIN for its own; the account must be enabled. AUTOMATIC creates a webhook endpoint in the merchant’s own Stripe account with its secret key, for <PUBLIC_API_BASE_URL>/api/v1/webhooks/stripe/<account id>, the events payment_intent.succeeded, payment_intent.payment_failed, refund.updated, and refund.failed, and the API version of the pinned SDK, and stores the signing secret Stripe returns. MANUAL stores a whsec_ signing secret of an endpoint the merchant created in the Stripe Dashboard. Either replaces the previous configuration; an endpoint the platform had created is then deleted at Stripe, and previous_endpoint tells whether that worked. The secret is stored encrypted and never returned. No transaction is open during the Stripe calls. A merchant role gets 404 for another merchant, and MERCHANT_READ_ONLY gets 403 for its own.',
  })
  @ApiResponse({
    status: 200,
    description: 'The configuration was stored.',
    standardSchema: configureProcessorAccountWebhookResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    INSUFFICIENT_ROLE_DOC,
    NOT_FOUND_DOC,
    {
      status: 409,
      description:
        'PROCESSOR_ACCOUNT_DISABLED: the account is disabled. WEBHOOK_CONFIGURATION_CHANGED: another change of the configuration was stored first. Nothing was stored.',
    },
    {
      status: 422,
      description:
        'PROCESSOR_CREDENTIALS_INVALID: Stripe refused the account’s secret key. WEBHOOK_ENDPOINT_REJECTED: Stripe refused the endpoint, such as its URL. PROCESSOR_PROVIDER_UNSUPPORTED: no adapter with webhooks for the provider. Nothing was stored.',
    },
    {
      status: 503,
      description:
        'PUBLIC_BASE_URL_NOT_CONFIGURED: AUTOMATIC needs PUBLIC_API_BASE_URL. WEBHOOK_PROVIDER_UNAVAILABLE: Stripe gave no usable answer. CREDENTIALS_KEY_NOT_CONFIGURED: no master key. OPERATION_TIMEOUT: another change held the merchant’s lock. Nothing was stored.',
    },
  )
  async configure(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
    @Param('processorAccountId', { schema: processorAccountIdParamSchema })
    processorAccountId: string,
    @Body({ schema: configureProcessorAccountWebhookSchema })
    body: ConfigureProcessorAccountWebhookBody,
  ): Promise<ConfigureProcessorAccountWebhookResponse> {
    const result = await this.configureWebhook.execute({
      principal,
      correlationId,
      merchantId,
      processorAccountId,
      request:
        body.mode === 'AUTOMATIC'
          ? { mode: 'AUTOMATIC' }
          : { mode: 'MANUAL', signingSecret: body.signing_secret },
    });
    if (!result.ok) throw toWebhookApiException(result.code);
    return {
      ...toProcessorAccountWebhookResponse(result.view),
      previous_endpoint: result.previousEndpoint,
    };
  }

  @Post('remove')
  @HttpCode(200)
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: "Remove a processor account's webhook configuration",
    description:
      'Roles: PLATFORM_ADMIN for any merchant; MERCHANT_ADMIN for its own. An endpoint the platform created is deleted at Stripe first (one that no longer exists counts as deleted); then the signing secret is cleared, and every later delivery for the account is refused. Removing an account without a configuration succeeds and changes nothing. A merchant role gets 404 for another merchant, and MERCHANT_READ_ONLY gets 403 for its own.',
  })
  @ApiResponse({
    status: 200,
    description: 'The account has no webhook configuration.',
    standardSchema: processorAccountWebhookResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    INSUFFICIENT_ROLE_DOC,
    NOT_FOUND_DOC,
    {
      status: 409,
      description:
        'WEBHOOK_CONFIGURATION_CHANGED: another change of the configuration was stored first. Nothing was changed.',
    },
    {
      status: 503,
      description:
        'WEBHOOK_PROVIDER_UNAVAILABLE: Stripe did not confirm the deletion of the endpoint. CREDENTIALS_KEY_NOT_CONFIGURED: no master key. Nothing was changed.',
    },
    OPERATION_TIMEOUT_DOC,
  )
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
    @Param('processorAccountId', { schema: processorAccountIdParamSchema })
    processorAccountId: string,
  ): Promise<ProcessorAccountWebhookResponse> {
    const result = await this.removeWebhook.execute({
      principal,
      correlationId,
      merchantId,
      processorAccountId,
    });
    if (!result.ok) throw toWebhookApiException(result.code);
    return toProcessorAccountWebhookResponse(result.view);
  }
}
