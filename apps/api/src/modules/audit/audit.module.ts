import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ReadAuditEventsService } from './application/read-audit-events.service.js';

/**
 * Owns the append-only audit trail. Other modules write their events with
 * `appendAuditEvent` inside their own transaction, and read them only through
 * the exported `ReadAuditEventsService` (P-09).
 */
@Module({
  imports: [DatabaseModule],
  providers: [ReadAuditEventsService],
  exports: [ReadAuditEventsService],
})
export class AuditModule {}
