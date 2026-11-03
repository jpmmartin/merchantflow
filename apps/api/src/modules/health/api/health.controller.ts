import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import {
  GetLivenessService,
  type LivenessReport,
} from '../application/get-liveness.service.js';
import {
  GetReadinessService,
  type ReadinessReport,
} from '../application/get-readiness.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly getLiveness: GetLivenessService,
    private readonly getReadiness: GetReadinessService,
  ) {}

  @Get('live')
  live(): LivenessReport {
    return this.getLiveness.execute();
  }

  @Get('ready')
  async ready(): Promise<ReadinessReport> {
    const report = await this.getReadiness.execute();
    switch (report.status) {
      case 'ready':
        return report;
      case 'unavailable':
        throw new ServiceUnavailableException(report);
    }
  }
}
