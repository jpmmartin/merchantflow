import type { ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
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
import { CompletePaymentActionService } from '../application/complete-payment-action.service.js';
import { ConfirmPaymentIntentService } from '../application/confirm-payment-intent.service.js';
import { CreatePaymentIntentService } from '../application/create-payment-intent.service.js';
import { GetPaymentIntentService } from '../application/get-payment-intent.service.js';
import { ListPaymentAttemptsService } from '../application/list-payment-attempts.service.js';
import { ListPaymentIntentsService } from '../application/list-payment-intents.service.js';
import {
  toPaymentAttemptListResponse,
  toPaymentConfirmationResponse,
} from './payment-confirmation.presenter.js';
import {
  confirmPaymentIntentSchema,
  paymentAttemptListResponseSchema,
  paymentConfirmationResponseSchema,
  type ConfirmPaymentIntentBody,
  type PaymentAttemptListResponse,
} from './payment-confirmation.schemas.js';
import {
  amountOf,
  toApiException,
  toCompleteActionApiException,
  toConfirmApiException,
  toGetApiException,
  toListApiException,
  toListAttemptsApiException,
} from './payment-intent-failures.js';
import {
  toCreatedPaymentIntentResponse,
  toPaymentIntentListResponse,
  toPaymentIntentResponse,
} from './payment-intent.presenter.js';
import {
  createPaymentIntentSchema,
  listPaymentIntentsQuerySchema,
  paymentIntentIdParamSchema,
  paymentIntentListResponseSchema,
  paymentIntentResponseSchema,
  type CreatePaymentIntentBody,
  type ListPaymentIntentsQuery,
  type PaymentIntentListResponse,
  type PaymentIntentResponse,
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
    private readonly getPaymentIntent: GetPaymentIntentService,
    private readonly listPaymentIntents: ListPaymentIntentsService,
    private readonly confirmPaymentIntent: ConfirmPaymentIntentService,
    private readonly completePaymentAction: CompletePaymentActionService,
    private readonly listPaymentAttempts: ListPaymentAttemptsService,
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
        'OPERATION_TIMEOUT: the request waited too long for another request that holds the same key, the same merchant_reference, or the merchant. SERVICE_BUSY: no database connection became free in time. Nothing was stored; send the same request with the same key again.',
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

  // The request names no merchant, so listing the merchant roles here reveals
  // nothing (AD-52): each merchant role lists only its own merchant's intents.
  // A platform key is refused by the guard.
  @Get()
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @ApiOperation({
    summary: 'List payment intents',
    description:
      'Roles: MERCHANT_ADMIN and MERCHANT_READ_ONLY list the intents of their own merchant, whatever its status. Pages are ordered newest first, by creation time and then id, and continue with next_cursor. status keeps only the intents in that status. PLATFORM_ADMIN is 403. A list writes no audit event.',
  })
  @ApiResponse({
    status: 200,
    description:
      'One page of intents. Each item has the same body as a single read; amount_minor is an integer string.',
    standardSchema: paymentIntentListResponseSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'VALIDATION_FAILED: limit is not an integer from 1 to 100, cursor is not a next_cursor of this API, status is not a payment intent status, or the query names an unknown parameter. The answer does not depend on any merchant.',
    },
    {
      status: 401,
      description:
        'UNAUTHENTICATED: the API key or session token is missing, malformed, unknown, wrong, revoked, or expired, or the user is disabled.',
    },
    {
      status: 403,
      description:
        'INSUFFICIENT_ROLE: a platform key or user cannot list payment intents.',
    },
    {
      status: 500,
      description:
        'INTERNAL_ERROR: unexpected failure, including a stored intent on the page that this version cannot represent, such as one in an unsupported currency.',
    },
  )
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query({ schema: listPaymentIntentsQuerySchema })
    query: ListPaymentIntentsQuery,
  ): Promise<PaymentIntentListResponse> {
    const result = await this.listPaymentIntents.execute({
      principal,
      limit: query.limit,
      after: query.cursor,
      status: query.status,
    });
    if (!result.ok) throw toListApiException(result.code);
    return toPaymentIntentListResponse(result.page);
  }

  // The path names an intent and no merchant, so listing the merchant roles
  // here reveals nothing (AD-52): another merchant's intent is answered by the
  // use case as 404. A platform key is refused by the guard for every id.
  @Get(':id')
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @ApiOperation({
    summary: 'Read a payment intent',
    description:
      'Roles: MERCHANT_ADMIN and MERCHANT_READ_ONLY read the intents of their own merchant, whatever its status. An intent of another merchant is 404, indistinguishable from one that does not exist. PLATFORM_ADMIN is 403 for every id. A read writes no audit event.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The intent, with the same body as the create response. amount_minor is an integer string.',
    standardSchema: paymentIntentResponseSchema,
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
        'UNAUTHENTICATED: the API key is missing, malformed, unknown, wrong, or revoked.',
    },
    {
      status: 403,
      description:
        'INSUFFICIENT_ROLE: a platform key cannot read payment intents, whether or not the intent exists.',
    },
    {
      status: 404,
      description:
        'NOT_FOUND: the intent does not exist or belongs to another merchant. The two cannot be told apart.',
    },
    {
      status: 500,
      description:
        'INTERNAL_ERROR: unexpected failure, including a stored intent that this version cannot represent, such as one in an unsupported currency. It is never reported as 404.',
    },
  )
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: paymentIntentIdParamSchema }) id: string,
  ): Promise<PaymentIntentResponse> {
    const result = await this.getPaymentIntent.execute({
      principal,
      paymentIntentId: id,
    });
    if (!result.ok) throw toGetApiException(result.code);
    return toPaymentIntentResponse(result.intent);
  }

  // The path names an intent and no merchant, so listing both merchant roles
  // here reveals nothing (AD-52): another merchant's intent is 404 from the
  // use case, and MERCHANT_READ_ONLY gets 403 for its own. A platform key is
  // refused by the guard for every id.
  @Post(':id/confirm')
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Confirm (pay) a payment intent',
    description:
      "Roles: MERCHANT_ADMIN of an ACTIVE merchant. Charges the intent once through the merchant's default processor account, with a payment method token that the browser created with that account's publishable key; card data never reaches this API. The intent must be CREATED. The provider is called with no database transaction open, with the attempt's operation_id as its idempotency key. 200 answers SUCCEEDED, DECLINED or FAILED (the intent is back to CREATED, or FAILED at the third unsuccessful attempt), or REQUIRES_ACTION with next_action.client_secret for Stripe.js handleNextAction, followed by POST /payment-intents/{id}/complete-action. 202 answers an UNKNOWN outcome: the payment may have been charged, and the intent stays blocked until the outcome is resolved by the account's webhook (payment_intent.succeeded or payment_intent.payment_failed); automatic recovery without a webhook does not exist yet. The Idempotency-Key header is required: a conclusive answer (succeeded, declined, failed) is stored and replayed for the same key and request, also after the merchant changed status; while the attempt is REQUIRES_ACTION or UNKNOWN the same key gets 409 OPERATION_IN_PROGRESS. A refused request stores nothing. The response is not cacheable (Cache-Control: no-store).",
  })
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description:
      'Identifies the request for safe retries, per merchant: 1 to 255 visible ASCII characters (no spaces). Use one key per payment method, and send the same key again after a network error.',
    schema: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      pattern: '^[!-~]{1,255}$',
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'The provider answered: the attempt is SUCCEEDED, DECLINED, FAILED, or REQUIRES_ACTION; or this is the stored answer of the same request under the same key.',
    standardSchema: paymentConfirmationResponseSchema,
  })
  @ApiResponse({
    status: 202,
    description:
      'The outcome is UNKNOWN (for example a timeout after the request may have reached the provider). Do not pay again: no new attempt is accepted until the outcome is resolved.',
    standardSchema: paymentConfirmationResponseSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'IDEMPOTENCY_KEY_MISSING or IDEMPOTENCY_KEY_INVALID: the header is absent or outside its format. VALIDATION_FAILED or MALFORMED_JSON: the id is not a UUID or the body does not match the schema. The answer does not depend on any merchant.',
    },
    {
      status: 401,
      description:
        'UNAUTHENTICATED: the API key or session token is missing, malformed, unknown, wrong, revoked, or expired.',
    },
    {
      status: 403,
      description:
        'INSUFFICIENT_ROLE: only MERCHANT_ADMIN may confirm; a platform key is refused for every id. MERCHANT_NOT_ACTIVE: the merchant is DRAFT or SUSPENDED. Nothing was stored.',
    },
    {
      status: 404,
      description:
        'NOT_FOUND: the intent does not exist or belongs to another merchant. The two cannot be told apart.',
    },
    {
      status: 409,
      description:
        "IDEMPOTENCY_KEY_REUSED: the key was used for a different request. OPERATION_IN_PROGRESS: the same request under the key has no conclusive answer yet (executing, waiting for customer action, or unknown); retry after Retry-After seconds. PAYMENT_OUTCOME_UNKNOWN: an earlier attempt's outcome is unknown; do not pay again. PAYMENT_ATTEMPT_IN_PROGRESS: another attempt is executing or waits for customer action. PAYMENT_INTENT_NOT_CONFIRMABLE: the intent is SUCCEEDED or FAILED. PROCESSOR_ACCOUNT_DISABLED or PROCESSOR_ACCOUNT_NOT_DEFAULT: the account is not the merchant's enabled default. Nothing was stored.",
      headers: RETRY_AFTER,
    },
    {
      status: 422,
      description:
        "PROCESSOR_ACCOUNT_NOT_FOUND: the merchant has no processor account with this id. PROCESSOR_PROVIDER_UNSUPPORTED: the account's provider cannot make a sale. Nothing was stored.",
    },
    {
      status: 500,
      description:
        'INTERNAL_ERROR: unexpected failure. If it happened after the provider was called, the attempt stays EXECUTING and the same key answers OPERATION_IN_PROGRESS.',
    },
    {
      status: 503,
      description:
        'OPERATION_TIMEOUT: the request waited too long for another request that holds the same key or intent. SERVICE_BUSY: no database connection became free in time. CREDENTIALS_KEY_NOT_CONFIGURED: the master key that decrypts processor secrets is not configured. Nothing was stored; send the same request with the same key again.',
      headers: RETRY_AFTER,
    },
  )
  async confirm(
    // First, so that a missing key is reported before the body is validated.
    @IdempotencyKey() idempotencyKey: string,
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: paymentIntentIdParamSchema }) id: string,
    @Body({ schema: confirmPaymentIntentSchema })
    body: ConfirmPaymentIntentBody,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<IdempotencyJsonObject> {
    const result = await this.confirmPaymentIntent.execute({
      principal,
      correlationId,
      idempotencyKey,
      paymentIntentId: id,
      paymentMethod: body.payment_method,
      processorAccountId: body.processor_account_id,
      present: toPaymentConfirmationResponse,
    });
    if (!result.ok) throw toConfirmApiException(result.code);
    response.statusCode = result.response.statusCode;
    return result.response.body;
  }

  @Post(':id/complete-action')
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Complete a customer action of a payment intent',
    description:
      "Roles: MERCHANT_ADMIN. For an intent in REQUIRES_ACTION, after the browser ran the customer's step (Stripe.js handleNextAction), reads the payment from the provider and applies the result to the attempt and the intent: SUCCEEDED; DECLINED (back to CREATED, or FAILED at the third unsuccessful attempt) when authentication failed or the card was declined; or UNKNOWN (202) when the provider's state does not establish the outcome. A conclusive result is also stored as the answer of the confirmation's Idempotency-Key. Safe to call more than once: while the payment still requires action nothing changes and next_action.client_secret is returned again; once a result is applied, a further call is 409 PAYMENT_ACTION_NOT_PENDING. The merchant's status is not checked. The response is not cacheable (Cache-Control: no-store).",
  })
  @ApiResponse({
    status: 200,
    description:
      'The result was applied (SUCCEEDED, DECLINED, or FAILED), or the payment still requires action and nothing changed.',
    standardSchema: paymentConfirmationResponseSchema,
  })
  @ApiResponse({
    status: 202,
    description:
      'The provider state does not establish the outcome: the attempt and the intent are UNKNOWN. Do not pay again.',
    standardSchema: paymentConfirmationResponseSchema,
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
        'INSUFFICIENT_ROLE: only MERCHANT_ADMIN may complete an action; a platform key is refused for every id.',
    },
    {
      status: 404,
      description:
        'NOT_FOUND: the intent does not exist or belongs to another merchant. The two cannot be told apart.',
    },
    {
      status: 409,
      description:
        'PAYMENT_ACTION_NOT_PENDING: the intent is not waiting for customer action, for example because its result was already applied. Nothing changed.',
    },
    {
      status: 422,
      description:
        "PROCESSOR_PROVIDER_UNSUPPORTED: the attempt's provider cannot look a payment up. Nothing changed.",
    },
    {
      status: 503,
      description:
        'PROCESSOR_LOOKUP_UNAVAILABLE: the provider could not report the payment status. CREDENTIALS_KEY_NOT_CONFIGURED: the master key is not configured. SERVICE_BUSY: no database connection became free in time. Nothing changed; retry later.',
    },
  )
  async completeAction(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: paymentIntentIdParamSchema }) id: string,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<IdempotencyJsonObject> {
    const result = await this.completePaymentAction.execute({
      principal,
      correlationId,
      paymentIntentId: id,
      present: toPaymentConfirmationResponse,
    });
    if (!result.ok) throw toCompleteActionApiException(result.code);
    response.statusCode = result.response.statusCode;
    return result.response.body;
  }

  // As for a single read (AD-65): both merchant roles pass the guard so that
  // another merchant's intent is 404 from the use case; a platform key is 403.
  @Get(':id/attempts')
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @ApiOperation({
    summary: "List a payment intent's attempts",
    description:
      'Roles: MERCHANT_ADMIN and MERCHANT_READ_ONLY read the attempts of the intents of their own merchant, whatever its status, oldest first, with the processor account, status, provider transaction ID, decline code, error category, and timestamps of each. An intent of another merchant is 404, indistinguishable from one that does not exist. PLATFORM_ADMIN is 403 for every id. A read writes no audit event.',
  })
  @ApiResponse({
    status: 200,
    description:
      "The intent's attempts, oldest first; empty before the first confirmation.",
    standardSchema: paymentAttemptListResponseSchema,
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
        'INSUFFICIENT_ROLE: a platform key or user cannot read payment attempts, whether or not the intent exists.',
    },
    {
      status: 404,
      description:
        'NOT_FOUND: the intent does not exist or belongs to another merchant. The two cannot be told apart.',
    },
  )
  async attempts(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: paymentIntentIdParamSchema }) id: string,
  ): Promise<PaymentAttemptListResponse> {
    const result = await this.listPaymentAttempts.execute({
      principal,
      paymentIntentId: id,
    });
    if (!result.ok) throw toListAttemptsApiException(result.code);
    return toPaymentAttemptListResponse(result.intent, result.attempts);
  }
}
