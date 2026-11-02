import { Module } from '@nestjs/common';
import { HealthController } from './api/health.controller.js';
import { GetLivenessService } from './application/get-liveness.service.js';

@Module({
  controllers: [HealthController],
  providers: [GetLivenessService],
})
export class HealthModule {}
