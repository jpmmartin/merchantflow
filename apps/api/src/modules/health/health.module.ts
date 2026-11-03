import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { HealthController } from './api/health.controller.js';
import { GetLivenessService } from './application/get-liveness.service.js';
import { GetReadinessService } from './application/get-readiness.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [GetLivenessService, GetReadinessService],
})
export class HealthModule {}
