import type { ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Res,
} from '@nestjs/common';
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
import { ListRefundsService } from '../application/list-refunds.service.js';
import { RefundPaymentIntentService } from '../application/refund-payment-intent.service.js';
import {
  refundAmountMinorOf,
  toListRefundsApiException,
  toRefundApiException,
} from './payment-intent-failures.js';
import { paymentIntentIdParamSchema } from './payment-intent.schemas.js';
import {
  toRefundCreationResponse,
  toRefundListResponse,
} from './refund.presenter.js';
import {
  createRefundSchema,
  refundCreationResponseSchema,
  refundListResponseSchema,
  type CreateRefundBody,
  type RefundListResponse,
} from './refund.schemas.js';

const RETRY_AFTER = {
  'Retry-After': {
    description: 'Seconds to wait before sending the same request again.',
    type: 'integer',
  },
} as const;

/** Refunds of payment intents, below `/payment-intents/:id/refunds`. */
@ApiTags('Payment intents')
@ApiBearerAuth('bearer')
@Controller('payment-intents')
export class PaymentRefundsController {
  constructor(
    private readonly refundPaymentIntent: RefundPaymentIntentService,
    private readonly listRefunds: ListRefundsService,
  ) {}

  // The path names an intent and no merchant, so listing both merchant roles
  // here reveals nothing (AD-52): another merchant's intent is 404 from the
  // use case, and MERCHANT_READ_ONLY gets 403 for its own. A platform key is
  // refused by the guard for every id.
  @Post(':id/refunds')
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Refund a payment intent',
    description:
      "Roles: MERCHANT_ADMIN of an ACTIVE merchant. Refunds part or all of a captured payment intent (SUCCEEDED or PARTIALLY_REFUNDED) through the processor account of its successful attempt, even if that account is no longer the default or is disabled. The amount is in minor units of the intent's currency and must be at most the refundable amount: the captured amount minus every refund that succeeded or is still executing, pending, or unknown; a larger amount is refused before the provider is called. The provider is called with no database transaction open, with the refund's operation ID as its idempotency key. 201 answers SUCCEEDED (the intent becomes PARTIALLY_REFUNDED or REFUNDED and the refund is posted to the ledger), PENDING (the provider has not finished; the intent and the ledger do not change and the amount stays reserved), or FAILED (no money was returned; the amount is released). 202 answers UNKNOWN: money may have been returned, the amount stays reserved, and no new refund of the intent is accepted until the outcome is resolved, which needs recovery that does not exist yet. The Idempotency-Key header is required: a 201 answer is stored and replayed for the same key and request, also after the merchant changed status; while the refund is EXECUTING or UNKNOWN the same key gets 409 OPERATION_IN_PROGRESS. A refused request stores nothing. The response is not cacheable (Cache-Control: no-store).",
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'Identifies the request for safe retries, per merchant: 1 to 255 visible ASCII characters (no spaces). Use a new key for each refund, and send the same key again after a network error.',
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
      'The provider answered: the refund is SUCCEEDED, PENDING, or FAILED; or this is the stored answer of the same request under the same key. payment_intent carries the refunded and refundable amounts at the time of the answer.',
    standardSchema: refundCreationResponseSchema,
  })
  @ApiResponse({
    status: 202,
    description:
      'The outcome is UNKNOWN (for example a timeout after the request may have reached the provider). Do not refund again: no new refund of the intent is accepted until the outcome is resolved.',
    standardSchema: refundCreationResponseSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'IDEMPOTENCY_KEY_MISSING or IDEMPOTENCY_KEY_INVALID: the header is absent or outside its format. VALIDATION_FAILED or MALFORMED_JSON: the id is not a UUID or the body does not match the schema; a rejected amount_minor is reported with the issue code invalid_type (not a string), empty, invalid_format, leading_zero, out_of_range, or not_positive. The answer does not depend on any merchant.',
    },
    {
      status: 401,
      description:
        'UNAUTHENTICATED: the API key or session token is missing, malformed, unknown, wrong, revoked, or expired.',
    },
    {
      status: 403,
      description:
        'INSUFFICIENT_ROLE: only MERCHANT_ADMIN may refund; a platform key is refused for every id. MERCHANT_NOT_ACTIVE: the merchant is DRAFT or SUSPENDED. Nothing was stored.',
    },
    {
      status: 404,
      description:
        'NOT_FOUND: the intent does not exist or belongs to another merchant. The two cannot be told apart.',
    },
    {
      status: 409,
      description:
        'IDEMPOTENCY_KEY_REUSED: the key was used for a different request. OPERATION_IN_PROGRESS: the same request under the key has no conclusive answer yet (executing or unknown); retry after Retry-After seconds. PAYMENT_INTENT_NOT_REFUNDABLE: the intent is not SUCCEEDED or PARTIALLY_REFUNDED. REFUND_AMOUNT_EXCEEDS_REFUNDABLE: the amount is above the refundable amount; the provider was not called. REFUND_OUTCOME_UNKNOWN: an earlier refund of the intent has an unknown outcome; do not refund again. Nothing was stored.',
      headers: RETRY_AFTER,
    },
    {
      status: 422,
      description:
        "PROCESSOR_PROVIDER_UNSUPPORTED: the account's provider cannot make this refund. Nothing was stored.",
    },
    {
      status: 500,
      description:
        'INTERNAL_ERROR: unexpected failure. If it happened after the provider was called, the refund stays EXECUTING, its amount reserved, and the same key answers OPERATION_IN_PROGRESS.',
    },
    {
      status: 503,
      description:
        'OPERATION_TIMEOUT: the request waited too long for another request that holds the same key or intent. SERVICE_BUSY: no database connection became free in time. CREDENTIALS_KEY_NOT_CONFIGURED: the master key that decrypts processor secrets is not configured. Nothing was stored; send the same request with the same key again.',
      headers: RETRY_AFTER,
    },
  )
  async refund(
    // First, so that a missing key is reported before the body is validated.
    @IdempotencyKey() idempotencyKey: string,
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: paymentIntentIdParamSchema }) id: string,
    @Body({ schema: createRefundSchema }) body: CreateRefundBody,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<IdempotencyJsonObject> {
    const result = await this.refundPaymentIntent.execute({
      principal,
      correlationId,
      idempotencyKey,
      paymentIntentId: id,
      amountMinor: refundAmountMinorOf(body),
      present: toRefundCreationResponse,
    });
    if (!result.ok) throw toRefundApiException(result.code);
    // The stored status and body of the request that made the refund,
    // returned as they are for that request and for every replay.
    response.statusCode = result.response.statusCode;
    return result.response.body;
  }

  // As for a single read (AD-65): both merchant roles pass the guard so that
  // another merchant's intent is 404 from the use case; a platform key is 403.
  @Get(':id/refunds')
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @ApiOperation({
    summary: "List a payment intent's refunds",
    description:
      "Roles: MERCHANT_ADMIN and MERCHANT_READ_ONLY read the refunds of the intents of their own merchant, whatever its status, oldest first, with the intent's captured, refunded, pending, and refundable amounts as integer strings. An intent of another merchant is 404, indistinguishable from one that does not exist. PLATFORM_ADMIN is 403 for every id. A read writes no audit event.",
  })
  @ApiResponse({
    status: 200,
    description:
      "The intent's refunds, oldest first, and its refund amounts; empty before the first refund.",
    standardSchema: refundListResponseSchema,
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
        'UNAUTHENTICATED: the API key or session token is missing, malformed, unknown, wrong, revoked, or expired.',
    },
    {
      status: 403,
      description:
        'INSUFFICIENT_ROLE: a platform key or user cannot read refunds, whether or not the intent exists.',
    },
    {
      status: 404,
      description:
        'NOT_FOUND: the intent does not exist or belongs to another merchant. The two cannot be told apart.',
    },
    {
      status: 500,
      description:
        'INTERNAL_ERROR: unexpected failure, including stored refunds that this version cannot represent.',
    },
  )
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: paymentIntentIdParamSchema }) id: string,
  ): Promise<RefundListResponse> {
    const result = await this.listRefunds.execute({
      principal,
      paymentIntentId: id,
    });
    if (!result.ok) throw toListRefundsApiException(result.code);
    return toRefundListResponse(result.intent, result.refunds, result.summary);
  }
}
