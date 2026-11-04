import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { AuditEventsController } from './api/audit-events.controller.js';
import { PaymentTimelineController } from './api/payment-timeline.controller.js';
import { GetPaymentTimelineService } from './application/get-payment-timeline.service.js';
import { ListAuditLogService } from './application/list-audit-log.service.js';

/**
 * The operations panel (P-09): the audit log and the payment timeline. It owns
 * no table: it reads the audit trail, users and API keys (as actors), payment
 * rows, and journal entries only through the services those modules export,
 * and no module depends on it.
 */
@Module({
  imports: [AuditModule, AuthModule, LedgerModule, PaymentsModule],
  controllers: [AuditEventsController, PaymentTimelineController],
  providers: [ListAuditLogService, GetPaymentTimelineService],
})
export class OperationsModule {}
