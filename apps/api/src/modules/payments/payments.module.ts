import { Module } from '@nestjs/common';
import { ClockModule } from '../clock/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { MerchantsModule } from '../merchants/merchants.module.js';
import { PaymentIntentsController } from './api/payment-intents.controller.js';
import { CreatePaymentIntentService } from './application/create-payment-intent.service.js';
import { GetPaymentIntentService } from './application/get-payment-intent.service.js';

/**
 * Owns payment intents and their endpoints. Creation claims idempotency keys
 * through the idempotency module and reads the merchant through the merchants
 * module, both inside its own transaction; retrieval reads only its own table.
 */
@Module({
  imports: [DatabaseModule, ClockModule, IdempotencyModule, MerchantsModule],
  controllers: [PaymentIntentsController],
  providers: [CreatePaymentIntentService, GetPaymentIntentService],
})
export class PaymentsModule {}
