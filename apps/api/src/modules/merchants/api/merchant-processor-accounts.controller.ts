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
import { ConnectProcessorAccountService } from '../application/connect-processor-account.service.js';
import { DisableProcessorAccountService } from '../application/disable-processor-account.service.js';
import { ListProcessorAccountsService } from '../application/list-processor-accounts.service.js';
import { SetDefaultProcessorAccountService } from '../application/set-default-processor-account.service.js';
import {
  INSUFFICIENT_ROLE_DOC,
  NOT_FOUND_DOC,
  UNAUTHENTICATED_DOC,
  VALIDATION_FAILED_DOC,
} from './merchant-error-docs.js';
import { toApiException } from './merchant-failures.js';
import {
  toProcessorAccountListResponse,
  toProcessorAccountResponse,
} from './merchant.presenter.js';
import {
  connectProcessorAccountSchema,
  merchantIdParamSchema,
  processorAccountIdParamSchema,
  processorAccountListResponseSchema,
  processorAccountResponseSchema,
  type ConnectProcessorAccountBody,
  type ProcessorAccountListResponse,
  type ProcessorAccountResponse,
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

@ApiTags('Processor accounts')
@ApiBearerAuth('bearer')
@Controller('merchants/:id/processor-accounts')
export class MerchantProcessorAccountsController {
  constructor(
    private readonly connectAccount: ConnectProcessorAccountService,
    private readonly listAccounts: ListProcessorAccountsService,
    private readonly disableAccount: DisableProcessorAccountService,
    private readonly setDefaultAccount: SetDefaultProcessorAccountService,
  ) {}

  @Post()
  @Roles(ANY_ROLE)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Connect a processor account to a merchant',
    description:
      'Roles: PLATFORM_ADMIN for any merchant; MERCHANT_ADMIN for its own. Only Stripe test-mode keys are accepted. The keys are first checked for format and mode, then validated with two reads at Stripe (the account, which gives its acct_ ID, and the balance, whose livemode must be false); no transaction is open during those calls. The secret key is stored encrypted with AES-256-GCM and is never returned: responses carry only its last four characters. The first account of a merchant, or any account connected while the merchant has no default, becomes the default. The publishable key is not checked against the account, because Stripe offers no read for it. A merchant role gets 404 for another merchant, and MERCHANT_READ_ONLY gets 403 for its own.',
  })
  @ApiResponse({
    status: 201,
    description: 'The account was connected.',
    standardSchema: processorAccountResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    INSUFFICIENT_ROLE_DOC,
    NOT_FOUND_DOC,
    {
      status: 409,
      description:
        'PROCESSOR_ACCOUNT_ALREADY_CONNECTED: the merchant already has this provider account connected and enabled. Nothing was stored.',
    },
    {
      status: 422,
      description:
        'PROCESSOR_PROVIDER_UNSUPPORTED: no adapter for the provider. PROCESSOR_LIVE_CREDENTIALS_REJECTED: a key is a live-mode key, or Stripe reported livemode true. PROCESSOR_CREDENTIALS_INVALID: a key has the wrong format, or Stripe refused the secret key. Nothing was stored, and the answer never repeats a key or a provider message.',
    },
    {
      status: 503,
      description:
        'PROCESSOR_UNAVAILABLE: Stripe could not be reached or gave no usable answer. CREDENTIALS_KEY_NOT_CONFIGURED: the API has no credentials master key. OPERATION_TIMEOUT: another change of the merchant held its lock too long. Nothing was stored.',
    },
  )
  async connect(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
    @Body({ schema: connectProcessorAccountSchema })
    body: ConnectProcessorAccountBody,
  ): Promise<ProcessorAccountResponse> {
    const result = await this.connectAccount.execute({
      principal,
      correlationId,
      merchantId,
      provider: body.provider,
      displayName: body.display_name,
      secretKey: body.credentials.secret_key,
      publishableKey: body.credentials.publishable_key,
    });
    if (!result.ok) throw toApiException(result.code);
    return toProcessorAccountResponse(result.account);
  }

  @Get()
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: 'List the processor accounts of a merchant',
    description:
      'Roles: PLATFORM_ADMIN for any merchant; MERCHANT_ADMIN and MERCHANT_READ_ONLY for their own. Lists every account, disabled ones included, oldest first, with the hint of the secret key and never the key. Another merchant is 404.',
  })
  @ApiResponse({
    status: 200,
    description: 'The processor accounts of the merchant.',
    standardSchema: processorAccountListResponseSchema,
  })
  @ApiErrorResponses(VALIDATION_FAILED_DOC, UNAUTHENTICATED_DOC, NOT_FOUND_DOC)
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
  ): Promise<ProcessorAccountListResponse> {
    const result = await this.listAccounts.execute({ principal, merchantId });
    if (!result.ok) throw toApiException(result.code);
    return toProcessorAccountListResponse(result.accounts);
  }

  @Post(':processorAccountId/disable')
  @HttpCode(200)
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: 'Disable a processor account of a merchant',
    description:
      'Roles: PLATFORM_ADMIN for any merchant; MERCHANT_ADMIN for its own. A disabled account is never the default: disabling the default leaves the merchant with no default until one is set, and no other account is chosen for it. There is no re-enable; the account can be connected again. Disabling a disabled account succeeds and changes nothing. An account of another merchant and an unknown id are 404. A merchant role gets 404 for another merchant, and MERCHANT_READ_ONLY gets 403 for its own.',
  })
  @ApiResponse({
    status: 200,
    description: 'The account is disabled.',
    standardSchema: processorAccountResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    INSUFFICIENT_ROLE_DOC,
    NOT_FOUND_DOC,
    OPERATION_TIMEOUT_DOC,
  )
  async disable(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
    @Param('processorAccountId', { schema: processorAccountIdParamSchema })
    processorAccountId: string,
  ): Promise<ProcessorAccountResponse> {
    const result = await this.disableAccount.execute({
      principal,
      correlationId,
      merchantId,
      processorAccountId,
    });
    if (!result.ok) throw toApiException(result.code);
    return toProcessorAccountResponse(result.account);
  }

  @Post(':processorAccountId/default')
  @HttpCode(200)
  @Roles(ANY_ROLE)
  @ApiOperation({
    summary: 'Make a processor account the default of its merchant',
    description:
      'Roles: PLATFORM_ADMIN for any merchant; MERCHANT_ADMIN for its own. The previous default stops being the default in the same transaction. Naming the current default succeeds and changes nothing. A disabled account is 409 PROCESSOR_ACCOUNT_DISABLED. An account of another merchant and an unknown id are 404. A merchant role gets 404 for another merchant, and MERCHANT_READ_ONLY gets 403 for its own.',
  })
  @ApiResponse({
    status: 200,
    description: 'The account is the default.',
    standardSchema: processorAccountResponseSchema,
  })
  @ApiErrorResponses(
    VALIDATION_FAILED_DOC,
    UNAUTHENTICATED_DOC,
    INSUFFICIENT_ROLE_DOC,
    NOT_FOUND_DOC,
    {
      status: 409,
      description:
        'PROCESSOR_ACCOUNT_DISABLED: the account is disabled and cannot become the default. Nothing was changed.',
    },
    OPERATION_TIMEOUT_DOC,
  )
  async setDefault(
    @CurrentPrincipal() principal: Principal,
    @CorrelationId() correlationId: string,
    @Param('id', { schema: merchantIdParamSchema }) merchantId: string,
    @Param('processorAccountId', { schema: processorAccountIdParamSchema })
    processorAccountId: string,
  ): Promise<ProcessorAccountResponse> {
    const result = await this.setDefaultAccount.execute({
      principal,
      correlationId,
      merchantId,
      processorAccountId,
    });
    if (!result.ok) throw toApiException(result.code);
    return toProcessorAccountResponse(result.account);
  }
}
