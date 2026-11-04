import { Module } from '@nestjs/common';
import { ClockModule } from '../clock/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MerchantsModule } from '../merchants/merchants.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { ProcessorsModule } from '../processors/processors.module.js';
import { ProcessorEventsController } from './api/processor-events.controller.js';
import { StripeWebhookController } from './api/stripe-webhook.controller.js';
import { ListProcessorEventsService } from './application/list-processor-events.service.js';
import { ReceiveProviderEventService } from './application/receive-provider-event.service.js';

/**
 * Owns the webhook inbox (`processor_events`) and the public webhook
 * receiver. It reads an account and its signing secret through the merchants
 * module, verifies signatures through the processor adapters, and applies
 * what a provider reports through the payments module's resolution services;
 * it changes no table of another module itself.
 */
@Module({
  imports: [
    DatabaseModule,
    ClockModule,
    MerchantsModule,
    PaymentsModule,
    ProcessorsModule,
  ],
  controllers: [StripeWebhookController, ProcessorEventsController],
  providers: [ReceiveProviderEventService, ListProcessorEventsService],
})
export class WebhooksModule {}
