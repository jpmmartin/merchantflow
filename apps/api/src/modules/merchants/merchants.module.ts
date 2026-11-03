import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ClockModule } from '../clock/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MerchantApiKeysController } from './api/merchant-api-keys.controller.js';
import { MerchantsController } from './api/merchants.controller.js';
import { ChangeMerchantStatusService } from './application/change-merchant-status.service.js';
import { CreateMerchantService } from './application/create-merchant.service.js';
import { GetMerchantService } from './application/get-merchant.service.js';
import { IssueMerchantApiKeyService } from './application/issue-merchant-api-key.service.js';
import { ListMerchantsService } from './application/list-merchants.service.js';
import { RevokeMerchantApiKeyService } from './application/revoke-merchant-api-key.service.js';
import { UpdateMerchantProfileService } from './application/update-merchant-profile.service.js';

/** Owns merchants and their endpoints; API keys stay with the auth module. */
@Module({
  imports: [DatabaseModule, ClockModule, AuthModule],
  controllers: [MerchantsController, MerchantApiKeysController],
  providers: [
    CreateMerchantService,
    ListMerchantsService,
    GetMerchantService,
    UpdateMerchantProfileService,
    ChangeMerchantStatusService,
    IssueMerchantApiKeyService,
    RevokeMerchantApiKeyService,
  ],
})
export class MerchantsModule {}
