import { Module } from '@nestjs/common';
import { ClockModule } from '../clock/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { MerchantsModule } from '../merchants/merchants.module.js';
import { ProcessorsModule } from '../processors/processors.module.js';
import { PaymentHoldController } from './api/payment-hold.controller.js';
import { PaymentIntentsController } from './api/payment-intents.controller.js';
import { PaymentRefundsController } from './api/payment-refunds.controller.js';
import { ActOnAuthorizationService } from './application/act-on-authorization.service.js';
import { ApplyAttemptResolutionService } from './application/apply-attempt-resolution.service.js';
import { ApplyAuthorizationActionService } from './application/apply-authorization-action.service.js';
import { CompletePaymentActionService } from './application/complete-payment-action.service.js';
import { ConfirmPaymentIntentService } from './application/confirm-payment-intent.service.js';
import { CreatePaymentIntentService } from './application/create-payment-intent.service.js';
import { GetPaymentIntentService } from './application/get-payment-intent.service.js';
import { ListAuthorizationActionsService } from './application/list-authorization-actions.service.js';
import { ListPaymentAttemptsService } from './application/list-payment-attempts.service.js';
import { ListPaymentIntentsService } from './application/list-payment-intents.service.js';
import { ListRefundsService } from './application/list-refunds.service.js';
import { RefreshAuthorizationActionService } from './application/refresh-authorization-action.service.js';
import { RefreshRefundService } from './application/refresh-refund.service.js';
import { RefundPaymentIntentService } from './application/refund-payment-intent.service.js';
import { ResolveAuthorizationActionService } from './application/resolve-authorization-action.service.js';
import { ResolvePaymentAttemptService } from './application/resolve-payment-attempt.service.js';
import { ResolveRefundService } from './application/resolve-refund.service.js';

/**
 * Owns payment intents, payment attempts, refunds, captures and voids of
 * authorized holds (P-08), and their endpoints. Commands claim
 * idempotency keys through the idempotency module, and read the merchant and
 * its processor accounts (with the secret decrypted for one provider call)
 * through the merchants module; providers are reached only through the
 * adapters of the processors module. A successful payment posts its sale,
 * and a successful refund its refund entry, through the ledger module's
 * posting service, in the Apply transaction; a manual-capture payment posts
 * its sale when it is captured, never when it is authorized.
 * Reads touch only the module's own tables. The webhooks module resolves
 * attempts, refunds, and captures and voids from provider events through the
 * exported resolution services, with the same conditional updates.
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
  controllers: [
    PaymentIntentsController,
    PaymentRefundsController,
    PaymentHoldController,
  ],
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
    ResolveRefundService,
    RefreshRefundService,
    ResolvePaymentAttemptService,
    ApplyAuthorizationActionService,
    ActOnAuthorizationService,
    ListAuthorizationActionsService,
    ResolveAuthorizationActionService,
    RefreshAuthorizationActionService,
  ],
  exports: [
    ResolveRefundService,
    ResolvePaymentAttemptService,
    ResolveAuthorizationActionService,
  ],
})
export class PaymentsModule {}
