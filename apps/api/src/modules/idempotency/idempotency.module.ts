import { Module } from '@nestjs/common';
import { ClockModule } from '../clock/clock.module.js';
import { ClaimIdempotencyKeyService } from './application/claim-idempotency-key.service.js';
import { CompleteIdempotencyRecordService } from './application/complete-idempotency-record.service.js';

/**
 * Owns idempotency records. Commands of other modules claim a key and complete
 * its record through the exported services, always inside their own
 * transaction, which is why this module does not depend on the database
 * module.
 */
@Module({
  imports: [ClockModule],
  providers: [ClaimIdempotencyKeyService, CompleteIdempotencyRecordService],
  exports: [ClaimIdempotencyKeyService, CompleteIdempotencyRecordService],
})
export class IdempotencyModule {}
