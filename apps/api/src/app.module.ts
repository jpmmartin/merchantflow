import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module.js';
import { AppConfigModule } from './modules/config/config.module.js';
import { DatabaseModule } from './modules/database/database.module.js';
import { ErrorsModule } from './modules/errors/errors.module.js';
import { LoggingModule } from './modules/logging/logging.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { MerchantsModule } from './modules/merchants/merchants.module.js';
import { OperationsModule } from './modules/operations/operations.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { WebhooksModule } from './modules/webhooks/webhooks.module.js';

@Module({
  imports: [
    AppConfigModule,
    LoggingModule,
    ErrorsModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
    MerchantsModule,
    LedgerModule,
    PaymentsModule,
    WebhooksModule,
    OperationsModule,
  ],
})
export class AppModule {}
