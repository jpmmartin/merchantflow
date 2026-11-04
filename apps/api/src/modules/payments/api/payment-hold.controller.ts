import type { ServerResponse } from 'node:http';
import {
  Controller,
  Get,
  Header,
  HttpCode,
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
import { ActOnAuthorizationService } from '../application/act-on-authorization.service.js';
import type { AuthorizationActionKind } from '../application/authorization-action.js';
import { ListAuthorizationActionsService } from '../application/list-authorization-actions.service.js';
import { RefreshAuthorizationActionService } from '../application/refresh-authorization-action.service.js';
import {
  toAuthorizationActionListResponse,
  toAuthorizationActionRefreshResponse,
  toAuthorizationActionResult,
} from './authorization-action.presenter.js';
import {
  authorizationActionIdParamSchema,
  authorizationActionListResponseSchema,
  authorizationActionRefreshResponseSchema,
  authorizationActionResultResponseSchema,
  type AuthorizationActionListResponse,
  type AuthorizationActionRefreshResponse,
} from './authorization-action.schemas.js';
import {
  toAuthorizationActionApiException,
  toListAuthorizationActionsApiException,
  toRefreshAuthorizationActionApiException,
} from './payment-intent-failures.js';
import { paymentIntentIdParamSchema } from './payment-intent.schemas.js';

const RETRY_AFTER = {
  'Retry-After': {
    description: 'Seconds to wait before sending the same request again.',
    type: 'integer',
  },
} as const;

const IDEMPOTENCY_KEY_DOCUMENTATION = {
  name: IDEMPOTENCY_KEY_HEADER,
  required: true,
  description:
    'Identifies the request for safe retries, per merchant: 1 to 255 visible ASCII characters (no spaces). Capture and void share one scope: a key used to capture an intent is refused for its void, and the other way round. Use a new key for each request, and send the same key again after a network error.',
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 255,
    pattern: '^[!-~]{1,255}$',
  },
} as const;

/** The error answers that a capture and a void share. */
function commandErrors(action: AuthorizationActionKind) {
  const refusal =
    action === 'CAPTURE'
      ? 'PAYMENT_INTENT_NOT_CAPTURABLE: the intent is not REQUIRES_CAPTURE (an AUTOMATIC payment, a payment not authorized yet, or one already captured or voided).'
      : 'PAYMENT_INTENT_NOT_VOIDABLE: the intent is not REQUIRES_CAPTURE (an AUTOMATIC payment, a payment not authorized yet, or one already captured or voided; refund a captured payment instead).';
  return ApiErrorResponses(
    {
      status: 400,
      description:
        'IDEMPOTENCY_KEY_MISSING or IDEMPOTENCY_KEY_INVALID: the header is absent or outside its format. VALIDATION_FAILED: the id is not a UUID. The answer does not depend on any merchant.',
    },
    {
      status: 401,
      description:
        'UNAUTHENTICATED: the API key or session token is missing, malformed, unknown, wrong, revoked, or expired.',
    },
    {
      status: 403,
      description:
        action === 'CAPTURE'
          ? 'INSUFFICIENT_ROLE: only MERCHANT_ADMIN may capture; a platform key is refused for every id. MERCHANT_NOT_ACTIVE: the merchant is DRAFT or SUSPENDED. Nothing was stored.'
          : 'INSUFFICIENT_ROLE: only MERCHANT_ADMIN may void; a platform key is refused for every id. Nothing was stored.',
    },
    {
      status: 404,
      description:
        'NOT_FOUND: the intent does not exist or belongs to another merchant. The two cannot be told apart.',
    },
    {
      status: 409,
      description: `IDEMPOTENCY_KEY_REUSED: the key was used for a different request, including the other action of the same intent. OPERATION_IN_PROGRESS: the same request under the key has no conclusive answer yet (executing or unknown); retry after Retry-After seconds. AUTHORIZATION_ACTION_IN_PROGRESS: another capture or void of the intent is executing. AUTHORIZATION_ACTION_OUTCOME_UNKNOWN: an earlier capture or void of the intent has an unknown outcome; do not capture or void again until it is resolved. ${refusal} Nothing was stored.`,
      headers: RETRY_AFTER,
    },
    {
      status: 422,
      description:
        "PROCESSOR_PROVIDER_UNSUPPORTED: the account's provider cannot do this. Nothing was stored.",
    },
    {
      status: 500,
      description:
        'INTERNAL_ERROR: unexpected failure. If it happened after the provider was called, the action stays EXECUTING and the same key answers OPERATION_IN_PROGRESS.',
    },
    {
      status: 503,
      description:
        'OPERATION_TIMEOUT: the request waited too long for another request that holds the same key or intent. SERVICE_BUSY: no database connection became free in time. CREDENTIALS_KEY_NOT_CONFIGURED: the master key that decrypts processor secrets is not configured. Nothing was stored; send the same request with the same key again.',
      headers: RETRY_AFTER,
    },
  );
}

/**
 * Capture and void of the authorized hold of a `MANUAL` payment intent, and
 * their history and check, below `/payment-intents/:id`.
 */
@ApiTags('Payment intents')
@ApiBearerAuth('bearer')
@Controller('payment-intents')
export class PaymentHoldController {
  constructor(
    private readonly actOnAuthorization: ActOnAuthorizationService,
    private readonly listActions: ListAuthorizationActionsService,
    private readonly refreshAction: RefreshAuthorizationActionService,
  ) {}

  // The path names an intent and no merchant, so listing both merchant roles
  // here reveals nothing (AD-52): another merchant's intent is 404 from the
  // use case, and MERCHANT_READ_ONLY gets 403 for its own. A platform key is
  // refused by the guard for every id.
  @Post(':id/capture')
  @HttpCode(200)
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Capture an authorized payment intent',
    description:
      "Roles: MERCHANT_ADMIN of an ACTIVE merchant. Captures the whole held amount of a MANUAL payment intent in REQUIRES_CAPTURE, through the processor account that authorized it, even if that account is no longer the default or is disabled. The provider is called with no database transaction open, with the capture's operation ID as its idempotency key. 200 answers SUCCEEDED (the intent becomes SUCCEEDED and its sale is posted to the ledger, once) or FAILED (the provider refused, for example because the authorization expired; the intent stays REQUIRES_CAPTURE). 202 answers UNKNOWN: the funds may have been captured, and no new capture or void of the intent is accepted until the outcome is resolved by the account's webhook or by the action check. A capture and a void of one intent exclude each other, also under concurrent requests. The Idempotency-Key header is required: a 200 answer is stored and replayed for the same key and request; while the capture is EXECUTING or UNKNOWN the same key gets 409 OPERATION_IN_PROGRESS. A refused request stores nothing. The response is not cacheable (Cache-Control: no-store).",
  })
  @ApiHeader(IDEMPOTENCY_KEY_DOCUMENTATION)
  @ApiResponse({
    status: 200,
    description:
      'The provider answered: the capture SUCCEEDED or FAILED; or this is the stored answer of the same request under the same key.',
    standardSchema: authorizationActionResultResponseSchema,
  })
  @ApiResponse({
    status: 202,
    description:
      'The outcome is UNKNOWN (for example a timeout after the request may have reached the provider). Do not capture or void again until it is resolved.',
    standardSchema: authorizationActionResultResponseSchema,
  })
  @commandErrors('CAPTURE')
  async capture(
    @IdempotencyKey() idempotencyKey: string,
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: paymentIntentIdParamSchema }) id: string,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<IdempotencyJsonObject> {
    return this.act('CAPTURE', {
      idempotencyKey,
      principal,
      correlationId,
      id,
      response,
    });
  }

  // As for capture.
  @Post(':id/void')
  @HttpCode(200)
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Void an authorized payment intent',
    description:
      "Roles: MERCHANT_ADMIN. Releases the hold of a MANUAL payment intent in REQUIRES_CAPTURE with nothing captured, through the processor account that authorized it. The merchant's status is not checked: a void moves no money. The provider is called with no database transaction open, with the void's operation ID as its idempotency key. 200 answers SUCCEEDED (the intent becomes CANCELED, which is final, and nothing is posted to the ledger) or FAILED (the provider refused; the intent stays REQUIRES_CAPTURE). 202 answers UNKNOWN: the hold may have been released, and no new capture or void of the intent is accepted until the outcome is resolved by the account's webhook or by the action check. A capture and a void of one intent exclude each other, also under concurrent requests. The Idempotency-Key header is required and behaves as for capture. The response is not cacheable (Cache-Control: no-store).",
  })
  @ApiHeader(IDEMPOTENCY_KEY_DOCUMENTATION)
  @ApiResponse({
    status: 200,
    description:
      'The provider answered: the void SUCCEEDED or FAILED; or this is the stored answer of the same request under the same key.',
    standardSchema: authorizationActionResultResponseSchema,
  })
  @ApiResponse({
    status: 202,
    description:
      'The outcome is UNKNOWN. Do not capture or void again until it is resolved.',
    standardSchema: authorizationActionResultResponseSchema,
  })
  @commandErrors('VOID')
  async void(
    @IdempotencyKey() idempotencyKey: string,
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: paymentIntentIdParamSchema }) id: string,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<IdempotencyJsonObject> {
    return this.act('VOID', {
      idempotencyKey,
      principal,
      correlationId,
      id,
      response,
    });
  }

  private async act(
    action: AuthorizationActionKind,
    request: {
      readonly idempotencyKey: string;
      readonly principal: Principal;
      readonly correlationId: string;
      readonly id: string;
      readonly response: ServerResponse;
    },
  ): Promise<IdempotencyJsonObject> {
    const result = await this.actOnAuthorization.execute({
      principal: request.principal,
      correlationId: request.correlationId,
      idempotencyKey: request.idempotencyKey,
      paymentIntentId: request.id,
      action,
      present: toAuthorizationActionResult,
    });
    if (!result.ok) throw toAuthorizationActionApiException(result.code);
    // The stored status and body of the request that made the action,
    // returned as they are for that request and for every replay.
    request.response.statusCode = result.response.statusCode;
    return result.response.body;
  }

  // As for a single read (AD-65): both merchant roles pass the guard so that
  // another merchant's intent is 404 from the use case; a platform key is 403.
  @Get(':id/hold-actions')
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @ApiOperation({
    summary: "List a payment intent's captures and voids",
    description:
      'Roles: MERCHANT_ADMIN and MERCHANT_READ_ONLY read the captures and voids of the intents of their own merchant, whatever its status, oldest first. An intent of another merchant is 404, indistinguishable from one that does not exist. PLATFORM_ADMIN is 403 for every id. A read writes no audit event.',
  })
  @ApiResponse({
    status: 200,
    description:
      "The intent's captures and voids, oldest first; empty for an AUTOMATIC payment or before the first one.",
    standardSchema: authorizationActionListResponseSchema,
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
        'INSUFFICIENT_ROLE: a platform key or user cannot read captures and voids, whether or not the intent exists.',
    },
    {
      status: 404,
      description:
        'NOT_FOUND: the intent does not exist or belongs to another merchant. The two cannot be told apart.',
    },
    {
      status: 500,
      description:
        'INTERNAL_ERROR: unexpected failure, including stored actions that this version cannot represent.',
    },
  )
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: paymentIntentIdParamSchema }) id: string,
  ): Promise<AuthorizationActionListResponse> {
    const result = await this.listActions.execute({
      principal,
      paymentIntentId: id,
    });
    if (!result.ok) throw toListAuthorizationActionsApiException(result.code);
    return toAuthorizationActionListResponse(result.intent, result.actions);
  }

  // As for the list: both merchant roles pass the guard so that another
  // merchant's intent is 404 from the use case; MERCHANT_READ_ONLY gets 403
  // for its own, and a platform key is 403 for every id.
  @Post(':id/hold-actions/:actionId/refresh')
  @HttpCode(200)
  @Roles(['MERCHANT_ADMIN', 'MERCHANT_READ_ONLY'])
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Check a capture or void with the processor',
    description:
      "Roles: MERCHANT_ADMIN of the intent's merchant. For a capture or void whose outcome is UNKNOWN, reads the payment from Stripe with no database transaction open and applies what its state proves, with the same rules as the webhook: the state the action leads to (captured for a capture, canceled for a void) makes it SUCCEEDED, and the intent SUCCEEDED (its sale posted) or CANCELED; a payment that still holds its funds makes it FAILED (not_executed), so a new capture or void may be requested; a payment that reached the other final state makes it FAILED (payment_already_final). Any other state changes nothing. It needs no Idempotency-Key and is safe to repeat: an action whose outcome is known changes nothing (change null). The merchant's status is not checked: recording an outcome moves no new money.",
  })
  @ApiResponse({
    status: 200,
    description:
      'The action, its intent, and its attempt after the check, and what changed.',
    standardSchema: authorizationActionRefreshResponseSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'VALIDATION_FAILED: an id is not a UUID. The answer does not depend on any merchant.',
    },
    {
      status: 401,
      description:
        'UNAUTHENTICATED: the API key or session token is missing, malformed, unknown, wrong, revoked, or expired.',
    },
    {
      status: 403,
      description:
        'INSUFFICIENT_ROLE: only MERCHANT_ADMIN may check a capture or void; a platform key is refused for every id.',
    },
    {
      status: 404,
      description:
        'NOT_FOUND: the intent does not exist or belongs to another merchant, or the action is not one of its actions. The cases cannot be told apart.',
    },
    {
      status: 409,
      description:
        'AUTHORIZATION_ACTION_NOT_REFRESHABLE: the action is still EXECUTING.',
    },
    {
      status: 503,
      description:
        'PROCESSOR_LOOKUP_UNAVAILABLE: Stripe gave no usable answer. OPERATION_TIMEOUT: another change of the intent held its lock too long. CREDENTIALS_KEY_NOT_CONFIGURED: no master key. Nothing was changed; the request can be sent again.',
    },
  )
  async refresh(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: paymentIntentIdParamSchema }) id: string,
    @Param('actionId', { schema: authorizationActionIdParamSchema })
    actionId: string,
  ): Promise<AuthorizationActionRefreshResponse> {
    const result = await this.refreshAction.execute({
      principal,
      correlationId,
      paymentIntentId: id,
      actionId,
      present: toAuthorizationActionResult,
    });
    if (!result.ok) throw toRefreshAuthorizationActionApiException(result.code);
    return toAuthorizationActionRefreshResponse(result.view, result.change);
  }
}
