import { Module } from '@nestjs/common';
import { ClockModule } from '../clock/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { MerchantsModule } from '../merchants/merchants.module.js';
import { ProcessorsModule } from '../processors/processors.module.js';
import { PaymentIntentsController } from './api/payment-intents.controller.js';
import { PaymentRefundsController } from './api/payment-refunds.controller.js';
import { ApplyAttemptResolutionService } from './application/apply-attempt-resolution.service.js';
import { CompletePaymentActionService } from './application/complete-payment-action.service.js';
import { ConfirmPaymentIntentService } from './application/confirm-payment-intent.service.js';
import { CreatePaymentIntentService } from './application/create-payment-intent.service.js';
import { GetPaymentIntentService } from './application/get-payment-intent.service.js';
import { ListPaymentAttemptsService } from './application/list-payment-attempts.service.js';
import { ListPaymentIntentsService } from './application/list-payment-intents.service.js';
import { ListRefundsService } from './application/list-refunds.service.js';
import { RefundPaymentIntentService } from './application/refund-payment-intent.service.js';

/**
 * Owns payment intents, payment attempts, refunds, and their endpoints. Commands claim
 * idempotency keys through the idempotency module, and read the merchant and
 * its processor accounts (with the secret decrypted for one provider call)
 * through the merchants module; providers are reached only through the
 * adapters of the processors module. A successful payment posts its sale,
 * and a successful refund its refund entry, through the ledger module's
 * posting service, in the Apply transaction.
 * Reads touch only the module's own tables.
 */
@Module({
  imports: [
    DatabaseModule,
    ClockModule,
    IdempotencyModule,
    LedgerModule,
    MerchantsModule,
    ProcessorsModule,
  ],
  controllers: [PaymentIntentsController, PaymentRefundsController],
  providers: [
    CreatePaymentIntentService,
    GetPaymentIntentService,
    ListPaymentIntentsService,
    ConfirmPaymentIntentService,
    CompletePaymentActionService,
    ListPaymentAttemptsService,
    ApplyAttemptResolutionService,
    RefundPaymentIntentService,
    ListRefundsService,
  ],
})
export class PaymentsModule {}
