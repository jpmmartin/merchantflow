import type { ServerResponse } from 'node:http';
import { Body, Controller, Post, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal } from '../../auth/api/current-principal.decorator.js';
import { Roles } from '../../auth/api/route-access.js';
import type { Principal } from '../../auth/application/principal.js';
import { ApiErrorResponses } from '../../errors/api/api-error-responses.decorator.js';
import {
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKey,
} from '../../idempotency/api/idempotency-key.decorator.js';
import type { IdempotencyJsonObject } from '../../idempotency/application/idempotency-record.js';
import { CorrelationId } from '../../logging/correlation-id.decorator.js';
import { CreatePaymentIntentService } from '../application/create-payment-intent.service.js';
import { amountOf, toApiException } from './payment-intent-failures.js';
import { toCreatedPaymentIntentResponse } from './payment-intent.presenter.js';
import {
  createPaymentIntentSchema,
  paymentIntentResponseSchema,
  type CreatePaymentIntentBody,
} from './payment-intent.schemas.js';

const RETRY_AFTER = {
  'Retry-After': {
    description: 'Seconds to wait before sending the same request again.',
    type: 'integer',
  },
} as const;

@ApiTags('Payment intents')
@ApiBearerAuth('bearer')
@Controller('payment-intents')
export class PaymentIntentsController {
  constructor(
    private readonly createPaymentIntent: CreatePaymentIntentService,
  ) {}

  @Post()
  @Roles(['MERCHANT_ADMIN'])
  @ApiOperation({
    summary: 'Create a payment intent',
    description:
      'Roles: MERCHANT_ADMIN of an ACTIVE merchant. Creates an intent in CREATED for the merchant of the key; nothing is charged. The Idempotency-Key header is required: the same key with the same request returns the stored 201 response unchanged, also after the merchant changed status, and the same key with a different request is refused. Only a created intent is stored under the key: a refused request stores nothing, so the same request can be sent again once the cause is gone.',
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'Identifies the request for safe retries, per merchant: 1 to 255 visible ASCII characters (no spaces). Use a new key for each new intent.',
    schema: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      pattern: '^[!-~]{1,255}$',
    },
  })
  @ApiResponse({
    status: 201,
    description:
      'The intent was created, or this is the stored response of the request that created it under the same key.',
    standardSchema: paymentIntentResponseSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'IDEMPOTENCY_KEY_MISSING or IDEMPOTENCY_KEY_INVALID: the header is absent or outside its format. VALIDATION_FAILED or MALFORMED_JSON: the body does not match the schema; a rejected amount_minor is reported with the issue code invalid_type (not a string), empty, invalid_format, leading_zero, out_of_range, or not_positive.',
    },
    {
      status: 401,
      description:
        'UNAUTHENTICATED: the API key is missing, malformed, unknown, wrong, or revoked.',
    },
    {
      status: 403,
      description:
        'INSUFFICIENT_ROLE: only MERCHANT_ADMIN may create intents. MERCHANT_NOT_ACTIVE: the merchant is DRAFT or SUSPENDED. Nothing was stored.',
    },
    {
      status: 409,
      description:
        'IDEMPOTENCY_KEY_REUSED: the key was used for a different request. OPERATION_IN_PROGRESS: the same request under the key has not finished; retry after Retry-After seconds. DUPLICATE_MERCHANT_REFERENCE: another key already created an intent with this merchant_reference. Nothing was stored.',
      headers: RETRY_AFTER,
    },
    {
      status: 422,
      description:
        "MERCHANT_CURRENCY_MISMATCH: the currency is not the merchant's default currency. Nothing was stored.",
    },
    {
      status: 503,
      description:
        'OPERATION_TIMEOUT: the request waited too long for another request that holds the same key, the same merchant_reference, or the merchant. Nothing was stored; send the same request with the same key again.',
      headers: RETRY_AFTER,
    },
  )
  async create(
    // First, so that a missing key is reported before the body is validated.
    @IdempotencyKey() idempotencyKey: string,
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Body({ schema: createPaymentIntentSchema }) body: CreatePaymentIntentBody,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<IdempotencyJsonObject> {
    const result = await this.createPaymentIntent.execute({
      principal,
      correlationId,
      idempotencyKey,
      amount: amountOf(body),
      merchantReference: body.merchant_reference,
      present: toCreatedPaymentIntentResponse,
    });
    if (!result.ok) throw toApiException(result.code);
    // The stored status and body of the request that created the intent,
    // returned as they are for that request and for every replay.
    response.statusCode = result.response.statusCode;
    return result.response.body;
  }
}
