import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ClockModule } from '../clock/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { ProcessorsModule } from '../processors/processors.module.js';
import { MerchantApiKeysController } from './api/merchant-api-keys.controller.js';
import { MerchantProcessorAccountsController } from './api/merchant-processor-accounts.controller.js';
import { MerchantUsersController } from './api/merchant-users.controller.js';
import { MerchantsController } from './api/merchants.controller.js';
import { ChangeMerchantStatusService } from './application/change-merchant-status.service.js';
import { CreateMerchantUserService } from './application/create-merchant-user.service.js';
import { ConnectProcessorAccountService } from './application/connect-processor-account.service.js';
import { CreateMerchantService } from './application/create-merchant.service.js';
import { DisableProcessorAccountService } from './application/disable-processor-account.service.js';
import { DisableMerchantUserService } from './application/disable-merchant-user.service.js';
import { GetMerchantService } from './application/get-merchant.service.js';
import { IssueMerchantApiKeyService } from './application/issue-merchant-api-key.service.js';
import { ListMerchantApiKeysService } from './application/list-merchant-api-keys.service.js';
import { ListMerchantUsersService } from './application/list-merchant-users.service.js';
import { ListMerchantsService } from './application/list-merchants.service.js';
import { ListProcessorAccountsService } from './application/list-processor-accounts.service.js';
import { LockMerchantForPaymentService } from './application/lock-merchant-for-payment.service.js';
import { ProcessorAccountsForPaymentsService } from './application/processor-accounts-for-payments.service.js';
import { RevokeMerchantApiKeyService } from './application/revoke-merchant-api-key.service.js';
import { SetDefaultProcessorAccountService } from './application/set-default-processor-account.service.js';
import { UpdateMerchantProfileService } from './application/update-merchant-profile.service.js';
import { secretCipherProvider } from './infrastructure/secret-cipher.provider.js';

/**
 * Owns merchants and their endpoints, including the endpoints of a merchant's
 * users, API keys, and processor accounts; the users and keys themselves stay
 * with the auth module, and the processor accounts and their encrypted secrets
 * belong here. Other modules read a merchant only through the exported
 * services.
 */
@Module({
  imports: [DatabaseModule, ClockModule, AuthModule, ProcessorsModule],
  controllers: [
    MerchantsController,
    MerchantApiKeysController,
    MerchantUsersController,
    MerchantProcessorAccountsController,
  ],
  providers: [
    CreateMerchantService,
    ListMerchantsService,
    GetMerchantService,
    UpdateMerchantProfileService,
    ChangeMerchantStatusService,
    IssueMerchantApiKeyService,
    RevokeMerchantApiKeyService,
    ListMerchantApiKeysService,
    CreateMerchantUserService,
    ListMerchantUsersService,
    DisableMerchantUserService,
    LockMerchantForPaymentService,
    ConnectProcessorAccountService,
    ListProcessorAccountsService,
    DisableProcessorAccountService,
    SetDefaultProcessorAccountService,
    ProcessorAccountsForPaymentsService,
    secretCipherProvider,
  ],
  exports: [LockMerchantForPaymentService, ProcessorAccountsForPaymentsService],
})
export class MerchantsModule {}
